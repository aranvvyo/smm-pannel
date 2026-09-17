import { getDb } from '../db.js';
import { notify } from './notifier.js';
import { logSecurity } from '../middleware/auth.js';

// Manual admin wallet adjustment. amountInrPaise > 0 = credit, < 0 = debit.
// A debit that would take balance below zero is refused.
export function adminAdjustBalance(admin, targetUserId, amountPaise, reason = '') {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(targetUserId);
  if (!user) { const e = new Error('User not found.'); e.code = 'NO_USER'; throw e; }

  const newBalance = user.wallet_balance + amountPaise;
  if (newBalance < 0) {
    const e = new Error(`Insufficient balance — user has ${(user.wallet_balance / 100).toFixed(2)} INR.`); e.code = 'BAD_AMOUNT'; throw e;
  }

  db.exec('BEGIN');
  try {
    db.prepare('UPDATE users SET wallet_balance=? WHERE id=?').run(newBalance, user.id);
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