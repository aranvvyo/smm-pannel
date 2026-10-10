// Public, read-only deposit availability for the customer UI banners.
// Returns only the switch and the message. No versions, no actor identity, no
// secrets. It cannot change anything.
import { Router } from 'express';
import { getAllMaintenance } from '../lib/depositMaintenance.js';

const r = Router();
r.get('/', (req, res) => {
  const m = getAllMaintenance();
  res.set('Cache-Control', 'no-store');
  return res.json({
    inr: { maintenance: m.inr.enabled, message: m.inr.message },
    crypto: { maintenance: m.crypto.enabled, message: m.crypto.message },
  });
});
export default r;
