import { useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { useToast, Icon } from '../../ui.jsx';

const NAV = [
  ['/admin', 'chart', 'Dashboard'],
  ['/admin/users', 'users', 'Users'],
  ['/admin/services', 'package', 'Services'],
  ['/admin/providers', 'plug', 'Providers'],
  ['/admin/orders', 'order', 'Orders'],
  ['/admin/coupons', 'ticket', 'Coupons'],
  ['/admin/deposits', 'deposit', 'Deposits'],
  ['/admin/withdrawals', 'send', 'Withdraw'],
  ['/admin/tickets', 'support', 'Tickets'],
  ['/admin/logs', 'shield', 'Audit Logs'],
  ['/admin/settings', 'settings', 'Settings'],
];

export default function AdminLayout() {
  const { user, adminLogout } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  // On mobile the sidebar is an off-canvas drawer toggled by the hamburger —
  // never a horizontal-scrolling bar.
  const [open, setOpen] = useState(false);

  const logout = async () => {
    await adminLogout();
    toast('Signed out.', 'success');
    nav('/admin/login');
  };

  return (
    <div className="admin-wrap">
      <aside className={'admin-side' + (open ? ' open' : '')}>
        <Link to="/" className="logo" style={{ margin: '6px 10px 14px' }}>
          <span className="logo-mark"><Icon name="logo" size={18} stroke={2} style={{ color: '#fff' }} /></span>
          InstaSMM
          <span className="badge badge-danger" style={{ marginLeft: 4 }}>Admin</span>
        </Link>
        {NAV.map(([to, icon, label]) => (
          <NavLink key={to} to={to} className={({ isActive }) => 'side-link' + (isActive ? ' active' : '')} onClick={() => setOpen(false)}>
            <span className="side-icon"><Icon name={icon} size={17} stroke={1.8} /></span>{label}
          </NavLink>
        ))}
        <div style={{ marginTop: 18, padding: '0 4px' }}>
          <button className="btn btn-outline btn-sm" style={{ width: '100%' }} onClick={logout}>Logout</button>
        </div>
      </aside>
      {open && <div className="admin-backdrop" onClick={() => setOpen(false)} />}
      <main className="admin-main">
        <div className="admin-topbar">
          <button className="admin-burger" onClick={() => setOpen(true)} aria-label="Open menu">
            <Icon name="menu" size={20} stroke={2} />
            <span>Menu</span>
          </button>
          <div className="faint" style={{ fontSize: '0.85rem' }}>{new Date().toLocaleString('en-IN', { dateStyle: 'full' })}</div>
          <div className="admin-user">
            <span className="badge badge-b"><span className="dot" style={{ background: 'var(--accent)' }} /> {user?.email}</span>
            <Link to="/" className="muted" style={{ fontSize: '0.85rem' }}>View site <Icon name="arrowRight" size={13} stroke={2.2} style={{ verticalAlign: '-2px' }} /></Link>
          </div>
        </div>
        <Outlet />
      </main>
    </div>
  );
}