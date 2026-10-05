// ---------------------------------------------------------------------------
// PostgreSQL dialect helpers — pure functions, no I/O, unit-testable
// (scripts/test-pg-dialect.mjs).
//
// The application's SQL is written for SQLite. These helpers translate
// the handful of constructs that differ so every route, lib, middleware
// and test keeps its ORIGINAL SQL and the synchronous bridge
// (lib/pgSync.js) can run it against PostgreSQL (e.g. Neon) unchanged:
//
//   • `INSERT OR IGNORE`  → `INSERT … ON CONFLICT DO NOTHING`
//   • `?` placeholders     → `$n` (string literals, quoted identifiers
//                             and comments are skipped)
//   • `LIKE`               → `ILIKE` (SQLite's LIKE is ASCII-case-
//                             insensitive; PostgreSQL's LIKE is not)
//   • `lastInsertRowid`    → auto-appended `RETURNING id` on INSERTs
//                             into id-bearing tables
// ---------------------------------------------------------------------------

// Tables whose rows carry an auto-incrementing `id` that the app reads
// back through `run(…).lastInsertRowid`. `settings`, `sessions` and
// `withdraw_addresses` have natural primary keys and no id column, so
// no RETURNING is ever appended for them.
export const PG_ID_TABLES = new Set([
  'users', 'categories', 'providers', 'services', 'orders', 'transactions',
  'deposits', 'coupons', 'coupon_uses', 'notifications', 'tickets',
  'ticket_replies', 'security_logs', 'withdrawals', 'inr_deposits',
]);

export function isPragma(sql) {
  return /^\s*PRAGMA\b/i.test(String(sql));
}

// PostgreSQL reports unique violations with SQLSTATE 23505 and the
// message "duplicate key value violates unique constraint …"; SQLite
// says "UNIQUE constraint failed: …". Accept both so call sites work
// against either database (admin.withdraw.js duplicate handling;
// orderRouter's idempotency regex).
export function isUniqueViolation(e) {
  if (!e) return false;
  if (e.code === '23505') return true;
  const msg = String(e.message || '');
  return msg.includes('UNIQUE') || /unique constraint/i.test(msg);
}

// True when the connection string asks for TLS. node-postgres does not
// act on `sslmode` inside a connection string, so the worker passes an
// explicit ssl option when one is present (Neon always requires TLS).
export function wantsSsl(connectionString) {
  const m = /[?&]sslmode=([^&]+)/i.exec(String(connectionString));
  if (!m) return false;
  return /^(require|verify-ca|verify-full)$/i.test(m[1]);
}

// ---------------------------------------------------------------------------
// SQL scanner. `onCode` is applied ONLY to segments outside single-
// quoted literals (with the '' escape), double-quoted identifiers and
// -- / /* */ comments — so a `?` or the word LIKE inside data can never
// be mistaken for syntax.
// ---------------------------------------------------------------------------
function mapCodeSegments(sql, onCode) {
  const s = String(sql);
  let out = '';
  let code = '';
  let i = 0;
  const flush = () => { if (code) { out += onCode(code); code = ''; } };
  while (i < s.length) {
    const c = s[i];
    const next = s[i + 1];
    if (c === "'") {
      flush();
      let j = i + 1;
      let lit = "'";
      while (j < s.length) {
        if (s[j] === "'") {
          if (s[j + 1] === "'") { lit += "''"; j += 2; continue; }
          lit += "'"; j += 1;
          break;
        }
        lit += s[j];
        j += 1;
      }
      out += lit;
      i = j;
      continue;
    }
    if (c === '"') {
      flush();
      let j = i + 1;
      let lit = '"';
      while (j < s.length) {
        if (s[j] === '"') {
          if (s[j + 1] === '"') { lit += '""'; j += 2; continue; }
          lit += '"'; j += 1;
          break;
        }
        lit += s[j];
        j += 1;
      }
      out += lit;
      i = j;
      continue;
    }
    if (c === '-' && next === '-') {
      flush();
      let j = i + 2;
      while (j < s.length && s[j] !== '\n') j += 1;
      out += s.slice(i, j);
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      flush();
      let j = s.indexOf('*/', i + 2);
      if (j === -1) j = s.length; else j += 2;
      out += s.slice(i, j);
      i = j;
      continue;
    }
    code += c;
    i += 1;
  }
  flush();
  return out;
}

// Rewrite `?` placeholders to `$n`. Numbering starts AFTER any $n
// already present, so a statement mixing both placeholder styles still
// binds every parameter correctly.
export function numberPlaceholders(sql) {
  let max = 0;
  for (const m of String(sql).matchAll(/\$(\d+)/g)) {
    max = Math.max(max, Number(m[1]));
  }
  let n = max;
  return mapCodeSegments(sql, (code) => code.replace(/\?/g, () => `$${++n}`));
}

// Translate one SQLite-flavoured statement to PostgreSQL.
export function toPgSql(sql) {
  let out = String(sql);

  // INSERT OR IGNORE → INSERT … ON CONFLICT DO NOTHING (covers every
  // unique constraint, exactly like SQLite's OR IGNORE covers any
  // constraint violation that can be resolved by skipping the row).
  // The capture group re-emits the INSERT keyword exactly as written
  // (any case) — only the ` OR IGNORE` suffix is dropped, so the
  // rewrite never duplicates or re-cases the statement's own text.
  if (/\bINSERT\s+OR\s+IGNORE\b/i.test(out)) {
    out = out.replace(/(\bINSERT)\s+OR\s+IGNORE\b/i, '$1');
    const hadSemicolon = /;\s*$/.test(out);
    out = out.replace(/;\s*$/, '').trimEnd();
    if (!/\bON\s+CONFLICT\b/i.test(out)) out += ' ON CONFLICT DO NOTHING';
    if (hadSemicolon) out += ';';
  }

  // SQLite's case-insensitive ASCII LIKE → PostgreSQL ILIKE.
  out = mapCodeSegments(out, (code) => code.replace(/\bLIKE\b/gi, 'ILIKE'));

  out = numberPlaceholders(out);

  // INSERT into an id-bearing table without its own RETURNING clause:
  // append `RETURNING id` so run() can report lastInsertRowid, the
  // contract node:sqlite exposes and the app relies on. RETURNING is
  // the final INSERT clause, so it lands after any ON CONFLICT suffix.
  if (/\bINSERT\s+INTO\b/i.test(out) && !/\bRETURNING\b/i.test(out)) {
    const table = /\bINSERT\s+INTO\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i.exec(out);
    if (table && PG_ID_TABLES.has(table[1].toLowerCase())) {
      const hadSemicolon = /;\s*$/.test(out);
      out = out.replace(/;\s*$/, '').trimEnd() + ' RETURNING id' + (hadSemicolon ? ';' : '');
    }
  }
  return out;
}
