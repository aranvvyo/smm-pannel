// ---------------------------------------------------------------------------
// Worker-thread half of the PostgreSQL bridge (lib/pgSync.js is the
// main-thread half). Runs on a worker thread and owns the single
// node-postgres Client. Results are delivered back through the
// SharedArrayBuffer handed in via workerData:
//
//   header[0]  0 = idle · 1 = ok · 2 = error · 3 = result too large
//   header[1]  payload length in bytes (JSON)
//   bytes 8…   payload
//
// The parent blocks in Atomics.wait until the header is written. From
// the main thread's point of view every query is therefore
// SYNCHRONOUS — and because nothing else can run on the main thread
// while it blocks, statements issued inside a BEGIN…COMMIT block can
// never interleave with another request's statements: the same
// serialization a single SQLite connection provides. (All five
// transaction sites in the app — placeOrder, cancelOrder,
// creditDeposit, verifyInrDeposit, adminAdjustBalance — are fully
// synchronous between BEGIN and COMMIT, which is what makes this
// safe.)
// ---------------------------------------------------------------------------
import { workerData, parentPort } from 'node:worker_threads';

const { connectionString, sab } = workerData;
const header = new Int32Array(sab, 0, 2);
const payload = new Uint8Array(sab, 8);
const encoder = new TextEncoder();

let pg = null;
let client = null;
let txDepth = 0;

function deliver(status, obj) {
  const bytes = encoder.encode(JSON.stringify(obj));
  if (bytes.length > payload.length) {
    // Result too large for the shared buffer — report, never corrupt.
    Atomics.store(header, 1, 0);
    Atomics.store(header, 0, 3);
    Atomics.notify(header, 0);
    return;
  }
  payload.set(bytes);
  Atomics.store(header, 1, bytes.length);
  Atomics.store(header, 0, status);
  Atomics.notify(header, 0);
}

async function openClient() {
  if (!pg) {
    // Dynamic import: a missing package surfaces as a clean query
    // error, not a crashed worker. Normalise to the module's
    // default export — the node-postgres entry instance carrying
    // Client/types — so member access works under either CJS/ESM
    // interop shape.
    const mod = await import('pg');
    pg = mod.default ?? mod;
    // node-postgres returns BIGINT (int8 — COUNT(*), SUM(),
    // IDENTITY ids) and NUMERIC as strings by default; coerce
    // them to JS numbers so rows behave like the SQLite driver's.
    // Every value in this app (epoch-ms, paise, counts) is far
    // below Number.MAX_SAFE_INTEGER, so no precision is lost.
    pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
    pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));
  }
  if (!client) {
    const opts = { connectionString, connect_timeout: 15 };
    if (/[?&]sslmode=(require|verify-ca|verify-full)/i.test(String(connectionString))) {
      // node-postgres does not act on sslmode inside a connection
      // string — pass the option explicitly. `rejectUnauthorized:
      // false` is the standard setting for managed Postgres (Neon et
      // al.) whose certificates are publicly signed.
      opts.ssl = { rejectUnauthorized: false };
    }
    client = new pg.Client(opts);
    await client.connect();
  }
  return client;
}

const CONNECTION_ERROR_TEXT = /connection terminated|socket hang up|broken pipe|connection refused|connection timed out|econnreset|etimedout|epipe|econnrefused|enotfound|ehostunreach/i;

function isConnectionError(e) {
  if (!e) return false;
  if (['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH'].includes(e.code)) return true;
  return CONNECTION_ERROR_TEXT.test(String(e.message || ''));
}

const isTxControl = (sql) => /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(String(sql));

async function runQuery(sql, params, raw) {
  const c = await openClient();
  if (raw || params.length === 0) {
    // Simple protocol: no bound parameters — and, unlike the extended
    // protocol, multiple semicolon-separated statements in one string,
    // which the schema DDL and BEGIN/COMMIT/ROLLBACK rely on.
    return c.query(sql);
  }
  return c.query({ text: sql, values: params });
}

async function handle(sql, params, raw) {
  const stmt = String(sql);
  const isBegin = /^\s*BEGIN\b/i.test(stmt);
  const isEnd = /^\s*(COMMIT|ROLLBACK)\b/i.test(stmt);
  if (isBegin) txDepth += 1;
  try {
    const res = await runQuery(stmt, params, raw);
    if (isEnd) txDepth = Math.max(0, txDepth - 1);
    return { rows: res.rows || [], rowCount: res.rowCount ?? (res.rows ? res.rows.length : 0) };
  } catch (e) {
    // BEGIN failing means the transaction never opened; COMMIT/ROLLBACK
    // failing means it is closed server-side. Either way undo the
    // depth change. A mid-transaction failure leaves the transaction
    // open (aborted) — the caller's ROLLBACK closes it.
    if (isBegin || isEnd) txDepth = Math.max(0, txDepth - 1);
    throw e;
  }
}

parentPort.on('message', async (msg) => {
  const sql = String(msg?.sql ?? '');
  const params = Array.isArray(msg?.params) ? msg.params : [];
  const raw = Boolean(msg?.raw);
  const attempt = Number(msg?.attempt) || 0;
  try {
    const res = await handle(sql, params, raw);
    deliver(1, { ok: true, rows: res.rows, rowCount: res.rowCount });
  } catch (e) {
    const connDropped = isConnectionError(e);
    if (connDropped) {
      // Drop the broken client so the NEXT statement reconnects.
      // Neon suspends idle compute and closes sockets, so a cold
      // first query after a quiet period is a normal, recoverable
      // event.
      try { if (client) await client.end(); } catch { /* already gone */ }
      client = null;
    }
    // Retry ONCE, and only when it is provably safe: outside any
    // transaction (txDepth === 0 — the caller's ROLLBACK handles the
    // in-transaction case), on a plain statement (never BEGIN/COMMIT/
    // ROLLBACK — a COMMIT whose response was lost must not be re-run),
    // and only on the first attempt.
    const retryable = connDropped && attempt === 0 && txDepth === 0 && !isTxControl(sql);
    if (retryable) {
      try {
        const res = await handle(sql, params, raw);
        deliver(1, { ok: true, rows: res.rows, rowCount: res.rowCount });
        return;
      } catch (e2) {
        deliver(2, { ok: false, error: String(e2.message || e2), code: e2.code });
        return;
      }
    }
    deliver(2, { ok: false, error: String(e.message || e), code: e.code });
  }
});

process.on('uncaughtException', (e) => {
  try { deliver(2, { ok: false, error: `pg worker: ${e.message}`, code: e.code }); } catch { /* cannot deliver */ }
});
