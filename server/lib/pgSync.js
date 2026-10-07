// ---------------------------------------------------------------------------
// Main-thread half of the PostgreSQL bridge: a SYNCHRONOUS,
// DatabaseSync-compatible facade over a worker thread that owns the
// node-postgres client (see lib/pgWorker.js).
//
// getDb() returns this object when DATABASE_URL is set. It exposes the
// exact contract of node:sqlite's DatabaseSync that the whole app
// already uses:
//
//   db.exec(sql)                     — raw / multi-statement execution
//   db.prepare(sql).get(…params)     — first row or undefined
//   db.prepare(sql).all(…params)     — array of rows
//   db.prepare(sql).run(…params)     — { changes, lastInsertRowid }
//
// Every call blocks the main thread (Atomics.wait) until the worker has
// executed the statement, so callers stay fully synchronous and
// statements inside a BEGIN…COMMIT block execute back-to-back with no
// interleaving — the same serialization a single SQLite connection
// provides. NO route, lib, middleware or test changes are required,
// and no money/payment/order logic is modified: only the SQL dialect
// is translated (lib/pgDialect.js).
// ---------------------------------------------------------------------------
import { Worker } from 'node:worker_threads';
import { isPragma, toPgSql } from './pgDialect.js';

const WORKER_URL = new URL('./pgWorker.js', import.meta.url);
const PAYLOAD_BYTES = 16 * 1024 * 1024;
// Overridable so the safety test can exercise the timeout path
// in milliseconds; the production default is 60 seconds.
const QUERY_TIMEOUT_MS = Number(process.env.PG_QUERY_TIMEOUT_MS) || 60_000;

export function createPgBridge(connectionString) {
  const url = String(connectionString || '').trim();
  if (!url) throw new Error('createPgBridge: DATABASE_URL is empty.');
  if (!/^postgres(?:ql)?:\/\//i.test(url)) {
    throw new Error('DATABASE_URL must be a postgres:// or postgresql:// connection string.');
  }

  const sab = new SharedArrayBuffer(8 + PAYLOAD_BYTES);
  const header = new Int32Array(sab, 0, 2);
  const payload = new Uint8Array(sab, 8);

  const worker = new Worker(WORKER_URL, { workerData: { connectionString: url, sab } });

  let dead = false;
  let deadReason = 'worker exited';
  let timedOut = false;
  // The worker must never keep the process alive on its own (test
  // scripts finish and must exit); a running server holds the event
  // loop open via its listener, so unref() is safe there.
  worker.unref();
  worker.on('error', (e) => { dead = true; deadReason = `worker error: ${e.message}`; });
  worker.on('exit', (code) => { dead = true; deadReason = `worker exited (code ${code})`; });

  function querySync(sql, params = [], raw = false) {
    if (dead) throw new Error(`PostgreSQL bridge is unavailable: ${deadReason}`);
    if (timedOut) {
      // FAIL CLOSED after a timeout. The shared-buffer header
      // carries no request id, so once a response is late it
      // can no longer be told apart from the result of a LATER
      // query — a subsequent call could silently read the stale
      // payload as its own result. On a money path a wrong
      // result is far worse than a halted bridge, so this bridge
      // refuses every further query; the operator restarts the
      // process (or fixes the slow query). Restoring
      // single-query recovery needs a request-id protocol in the
      // header — the documented follow-up design is in
      // MASTER_PROJECT_AUDIT.md (Session 14).
      throw new Error('PostgreSQL bridge halted after a query timeout — a late response could be mistaken for a new result. Restart the process (or fix the slow query).');
    }
    const translated = raw ? sql : toPgSql(sql);
    const cleanParams = params.map((p) => (p === undefined ? null : p));
    Atomics.store(header, 0, 0);
    Atomics.store(header, 1, 0);
    worker.postMessage({ sql: translated, params: cleanParams, raw });
    const waited = Atomics.wait(header, 0, 0, QUERY_TIMEOUT_MS);
    if (waited === 'timed-out') {
      // Mark the bridge halted BEFORE throwing: the worker may
      // still deliver this late response into the shared buffer
      // at any moment, and it must never be readable as the
      // result of a later query (see the fail-closed guard
      // above — no further query is ever posted on this bridge).
      timedOut = true;
      throw new Error(`PostgreSQL query timed out after ${QUERY_TIMEOUT_MS}ms (the worker never answered); the bridge is now halted — restart the process.`);
    }
    const status = Atomics.load(header, 0);
    const len = Atomics.load(header, 1);
    if (status === 3) throw new Error('PostgreSQL result exceeded the 16 MB bridge buffer.');
  if (status === 0) {
    if (dead) throw new Error(`PostgreSQL bridge is unavailable: ${deadReason}`);
    throw new Error('PostgreSQL bridge returned no result (invalid state).');
  }

  const text = new TextDecoder().decode(payload.subarray(0, len));
  let msg;
  try { msg = JSON.parse(text); } catch {
    throw new Error('PostgreSQL bridge delivered a malformed result.');
  }

  if (status === 2) {
    const e = new Error(msg.error || 'PostgreSQL query failed.');
    if (msg.code) e.code = msg.code;
    throw e;
  }

  if (status !== 1) throw new Error('PostgreSQL bridge returned an invalid state.');
  if (!msg.ok) {
    const e = new Error(msg.error || 'PostgreSQL query failed.');
    if (msg.code) e.code = msg.code;
    throw e;
  }

  return { rows: msg.rows, rowCount: msg.rowCount };
  }

  const bridge = {
    isPg: true,

    exec(sql) {
      // SQLite tuning pragmas are not applicable to PostgreSQL.
      if (isPragma(sql)) return { rows: [], rowCount: 0 };
      // Raw passthrough: multi-statement DDL (the schema) and
      // BEGIN/COMMIT/ROLLBACK run on the simple protocol.
      return querySync(sql, [], true);
    },

    prepare(sql) {
      // Defensive: a PRAGMA must never reach PostgreSQL. Report an
      // empty result so callers probing schema metadata simply see
      // "nothing" (the PostgreSQL code paths use information_schema).
      if (isPragma(sql)) {
        return {
          get: () => undefined,
          all: () => [],
          run: () => ({ changes: 0, lastInsertRowid: 0 }),
        };
      }
      const translated = toPgSql(sql);
      return {
        get: (...params) => querySync(translated, params).rows[0],
        all: (...params) => querySync(translated, params).rows,
        run: (...params) => {
          const { rows, rowCount } = querySync(translated, params);
          return {
            changes: rowCount ?? 0,
            // node:sqlite exposes lastInsertRowid on the RESULT of
            // run(); the RETURNING id clause (pgDialect) supplies it.
            lastInsertRowid: rows && rows[0] && rows[0].id != null ? rows[0].id : 0,
          };
        },
      };
    },

    close() {
      worker.terminate();
    },
  };
  return bridge;
}
