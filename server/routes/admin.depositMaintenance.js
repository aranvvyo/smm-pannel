// Admin: independent INR / crypto deposit maintenance switches.
// Mounted at /api/admin/deposit-maintenance. Every route requires an admin
// (requireAdmin checks the session AND the admin email allow-list). Every
// change is written to the security log with the actor and the client address.
import { Router } from 'express';
import { requireAdmin, logSecurity, clientIp } from '../middleware/auth.js';
import { getAllMaintenance, setMaintenance, METHODS } from '../lib/depositMaintenance.js';
import { ah, sendErr } from './_helpers.js';

const r = Router();
r.use(requireAdmin);

// GET — current state of both switches (includes version for safe saves).
r.get('/', (req, res) => res.json({ maintenance: getAllMaintenance() }));

// PUT /:method — body { enabled: boolean, message: string, expected_version: int }
r.put('/:method', ah(async (req, res) => {
  const method = String(req.params.method || '');
  if (!METHODS.includes(method)) return sendErr(res, 404, 'Unknown deposit method.');
  const body = req.body || {};
  if (typeof body.enabled !== 'boolean') return sendErr(res, 400, 'enabled must be true or false.');
  if (!Number.isSafeInteger(body.expected_version) || body.expected_version < 0) {
    return sendErr(res, 400, 'expected_version is required (refresh the page and try again).');
  }
  if (body.message !== undefined && typeof body.message !== 'string') {
    return sendErr(res, 400, 'Message must be text.');
  }
  const out = setMaintenance({
    method,
    enabled: body.enabled,
    message: body.message ?? '',
    actor: req.user.email,
    expectedVersion: body.expected_version,
  });
  if (!out.ok) {
    // A newer setting exists. Return it so the admin sees the current state.
    return res.status(409).json({
      error: 'This setting was changed by someone else. Reload and try again.',
      code: 'STALE_VERSION',
      maintenance: out.current,
    });
  }
  logSecurity(req.user.id, req.user.email,
    `deposit_maintenance_${method}_${body.enabled ? 'on' : 'off'}`, clientIp(req),
    JSON.stringify({ method, enabled: body.enabled, version: out.state.version }));
  return res.json({ maintenance: out.state });
}));

export default r;
