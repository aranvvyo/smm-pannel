import { getDb } from '../db.js';
import { notify } from './notifier.js';
import { logSecurity } from '../middleware/auth.js';

// Manual admin wallet adjustment. amountInrPaise > 0 = credit, < 0 = debit.
// A debit that would take balance below zero is refused.
export function adminAdjustBalance(admin, targetUserId, amountPaise, reason = '') {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(targetUserId);
  if (!user) { const e = new Error('User not found.'); e.code = 'NO_USER'; throw e; }

  let newBalance;
  db.exec('BEGIN');
  try {
    // ATOMIC, CONDITIONAL. The balance check and the write are one statement
    // evaluated against the live row, so a concurrent debit cannot push the
    // balance below zero, and no stale read is ever written back.
    const res = db.prepare(
      'UPDATE users SET wallet_balance = wallet_balance + ? WHERE id=? AND wallet_balance + ? >= 0'
    ).run(amountPaise, user.id, amountPaise);
    if (res.changes !== 1) {
      const live = Number(db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(user.id).wallet_balance);
      const e = new Error(`Insufficient balance — user has ${(live / 100).toFixed(2)} INR.`); e.code = 'BAD_AMOUNT'; throw e;
    }
    newBalance = Number(db.prepare('SELECT wallet_balance FROM users WHERE id=?').get(user.id).wallet_balance);
    db.prepare(
      `INSERT INTO transactions (user_id, type, amount_inr, balance_after, ref_id, meta_json, created_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`
    ).run(user.id, amountPaise >= 0 ? 'admin_credit' : 'admin_debit', amountPaise, newBalance,
      JSON.stringify({ by: admin.email, reason }), Date.now());
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  notify(user.id, 'account',
    amountPaise >= 0 ? 'Wallet Credit' : 'Wallet Debit',
    amountPaise >= 0
      ? `Admin added ${(amountPaise / 100).toFixed(2)} INR to your wallet.`
      : `Admin adjusted ${(Math.abs(amountPaise) / 100).toFixed(2)} INR. Reason: ${reason || 'n/a'}`);
  logSecurity(admin.id, admin.email, amountPaise >= 0 ? 'admin_credit' : 'admin_debit', 'admin');
  return { newBalance };
}