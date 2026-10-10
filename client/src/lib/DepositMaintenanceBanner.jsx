import { Icon } from '../ui.jsx';

// Shown above a deposit page while its method is in maintenance. Existing
// history and open invoices stay visible; only starting new deposits is blocked.
export default function DepositMaintenanceBanner({ status, label }) {
  if (!status?.maintenance) return null;
  return (
    <div className="vc-status pending" role="status" aria-live="polite" style={{ marginBottom: 16 }}>
      <Icon name="alert" size={16} />
      <span>
        <b>{label} deposits are temporarily unavailable.</b>{' '}
        {status.message || 'Please try again later.'} Your existing deposits and history are unaffected.
      </span>
    </div>
  );
}
