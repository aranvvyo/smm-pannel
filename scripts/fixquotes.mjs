// One-off fixer: SQLite string literals must be single-quoted. Normalizes the
// mangled  `'... role="client" ...'` / `` `... role="client" ...` `` patterns by
// swapping inside-quote delimiters so the JS remains valid.
import { readFileSync, writeFileSync } from 'node:fs';

const files = [
  'server/lib/notifier.js',
  'server/lib/analytics.js',
  'server/lib/orderRouter.js',
  'server/routes/admin.auth.js',
  'server/routes/admin.users.js',
  'server/routes/admin.orders.js',
  'server/routes/admin.tickets.js',
  'server/routes/client.tickets.js',
  'server/routes/client.wallet.js',
  'server/routes/public.js',
  'server/routes/webhooks.js',
  'server/lib/apirone.js',
];

function fix(source) {
  // 1) Backtick / double-quote surroundings: just unhug the `` "lit" `` -> 'lit'
  let out = source.replace(/role="client"/g, "role='client'");
  out = out.replace(/role="admin"/g, "role='admin'");
  out = out.replace(/key="exchange_rate"/g, "key='exchange_rate'");
  out = out.replace(/key="deposit_timeout_hours"/g, "key='deposit_timeout_hours'");
  out = out.replace(/status="CANCELED"/g, "status='CANCELED'");
  out = out.replace(/status="IN_PROGRESS"/g, "status='IN_PROGRESS'");
  // 2) Single-quoted JS string containing the SQL literal: '...="lit"...' is
  //    invalid once step 1 inserts an inner single quote. Re-wrap as template.
  out = out.replace(/'([^'\n]*role='client'[^'\n]*)'/g, '`$1`');
  out = out.replace(/'([^'\n]*role='admin'[^'\n]*)'/g, '`$1`');
  out = out.replace(/'([^'\n]*key='exchange_rate'[^'\n]*)'/g, '`$1`');
  out = out.replace(/'([^'\n]*status='CANCELED'[^'\n]*)'/g, '`$1`');
  out = out.replace(/'([^'\n]*status='IN_PROGRESS'[^'\n]*)'/g, '`$1`');
  return out;
}

let total = 0;
for (const f of files) {
  try {
    const src = readFileSync(f, 'utf8');
    const next = fix(src);
    if (next !== src) {
      writeFileSync(f, next);
      console.log('fixed', f);
      total++;
    }
  } catch (e) {
    console.log('skip', f, e.message);
  }
}
console.log('done', total, 'files changed');