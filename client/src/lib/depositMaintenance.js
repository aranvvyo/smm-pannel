// ---------------------------------------------------------------------------
// Customer-side deposit maintenance state.
//
// Read-only: GET /api/deposit-status (public, no secrets, no actors). The
// server enforces maintenance on every deposit start; this module only lets the
// UI explain it and disable the matching controls. A status fetch that fails
// leaves the last known state in place, and a 503 DEPOSIT_MAINTENANCE response
// from any action marks that method as in maintenance immediately.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState } from 'react';
import { get } from '../api.js';

export const DEPOSIT_MAINTENANCE_CODE = 'DEPOSIT_MAINTENANCE';
const OFF = Object.freeze({ maintenance: false, message: '' });
const POLL_MS = 30_000;

export function isDepositMaintenanceError(err) {
  return !!err && err.code === DEPOSIT_MAINTENANCE_CODE;
}

function normalize(v) {
  return {
    maintenance: v?.maintenance === true,
    message: typeof v?.message === 'string' ? v.message.slice(0, 200) : '',
  };
}

// Returns { inr, crypto, refresh, markMaintenance }. Each method is
// { maintenance: boolean, message: string }.
export function useDepositMaintenance() {
  const [state, setState] = useState({ inr: OFF, crypto: OFF });

  const refresh = useCallback(async () => {
    try {
      const d = await get('/api/deposit-status');
      setState({ inr: normalize(d.inr), crypto: normalize(d.crypto) });
    } catch {
      /* keep the last known state; the server still enforces it */
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const markMaintenance = useCallback((method, message) => {
    setState((s) => ({ ...s, [method]: { maintenance: true, message: typeof message === 'string' ? message.slice(0, 200) : '' } }));
  }, []);

  return { inr: state.inr, crypto: state.crypto, refresh, markMaintenance };
}
