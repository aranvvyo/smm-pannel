import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate, NavLink } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { usePoll, useToast, fmtInr, Icon } from '../ui.jsx';
import { get } from '../api.js';

export function Layout({ children }) {
  return (
    <>
      {children}
      <footer className="site-footer">
        <div className="container">
          <b style={{ color: 'var(--muted)' }}>InstaSMM</b>{' '}
          <span className="faint">SMM panel &middot; crypto deposits &middot; &copy; {new Date().getFullYear()} instasmm.store</span>
          {' '}
          <Link to="/terms" className="faint" style={{ marginLeft: 8 }}>Terms</Link>
          {' '}
          <Link to="/refund-policy" className="faint" style={{ marginLeft: 8 }}>Refund &amp; Payment Policy</Link>
        </div>
      </footer>
    </>
  );
}

export function Navbar({ links = [], wallet = null, admin = false }) {
  const { user, logout, adminLogout } = useAuth();
  const nav = useNavigate();
  const toast = useToast();
  const [unread, setUnread] = useState(0);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const menuRef = useRef(null);
  const profileRef = useRef(null);

  // Close the mobile menu on Escape; move focus to the menu for keyboard users.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setMobileOpen(false); };
    document.addEventListener('keydown', onKey);
    const firstLink = menuRef.current?.querySelector('a, button');
    firstLink?.focus?.();
    return () => document.removeEventListener('keydown', onKey);
  }, [mobileOpen]);
  // Close the menu when the viewport grows wide enough for the desktop nav.
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 860px)');
    const onWide = (e) => { if (e.matches) setMobileOpen(false); };
    mq.addEventListener?.('change', onWide);
    return () => mq.removeEventListener?.('change', onWide);
  }, []);

  // Dismiss the profile dropdown on outside click / Escape.
  useEffect(() => {
    if (!profileOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setProfileOpen(false); };
    const onClick = (e) => { if (profileRef.current && !profileRef.current.contains(e.target)) setProfileOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('click', onClick); };
  }, [profileOpen]);

  const refreshUnread = async () => {
    if (!user || admin) { setUnread(0); return; }
    try {
      const d = await get('/api/notifications');
      setUnread(d.unread || 0);
    } catch { /* ignore */ }
  };
  usePoll(refreshUnread, 15000);
  // Badge bus: opening the notifications panel marks items read and dispatches
  // this event so the dot clears immediately (it also fires when an item is
  // tapped or "mark all" is used). Never shows stale "unread" after a visit.
  useEffect(() => {
    const onRead = () => refreshUnread();
    window.addEventListener('instasmm:notifs-read', onRead);
    return () => window.removeEventListener('instasmm:notifs-read', onRead);
  }, [user, admin]);

  const onLogout = async () => {
    if (admin) await adminLogout(); else await logout();
    toast('Signed out.', 'success');
    nav(admin ? '/admin/login' : '/');
  };

  const closeMobile = () => setMobileOpen(false);

  const avatarChar = (user?.name || user?.email || 'U').charAt(0).toUpperCase();

  return (
    <nav className="nav">
      <div className="container">
        <div className="nav-inner">
          {/* Logo always first (left) — mobile + desktop. */}
          <Link to={admin ? '/admin' : '/'} className="logo" onClick={closeMobile}>
            <span className="logo-mark"><Icon name="logo" size={18} stroke={2} style={{ color: '#fff' }} /></span>
            InstaSMM
          </Link>

          {/* Desktop nav links */}
          {!admin && (
            <div className="nav-links desktop-nav">
              {links.map(([to, label]) => (
                <NavLink key={to} to={to} className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
                  {label}
                </NavLink>
              ))}
            </div>
          )}

          <div className="nav-actions">
            {wallet != null && (
              <span className="badge badge-success hide-mobile" title="Available balance (INR)">
                <span className="dot" style={{ background: 'var(--success)' }} /> {fmtInr(wallet)}
              </span>
            )}

            {/* Bell — badge only when there is a real unread count. */}
            {!admin && (
              <NavLink to="/notifications" className="bell-wrap" title="Notifications" onClick={closeMobile}>
                <span className="bell"><Icon name="bell" size={17} stroke={1.8} /></span>
                {unread > 0 && <span className="bell-dot">{unread > 9 ? '9+' : unread}</span>}
              </NavLink>
            )}

            {/* Hamburger for mobile (client only) */}
            {!admin && (
              <button
                className="hamburger hide-desktop"
                onClick={() => setMobileOpen((v) => !v)}
                aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
              >
                <Icon name={mobileOpen ? 'close' : 'menu'} size={22} stroke={2} />
              </button>
            )}

            {/* Profile menu — the email is never shown in the navbar; the avatar
                opens a dropdown with account actions. */}
            <div className="profile-menu desktop-nav" ref={profileRef} data-profile-menu>
              <button
                className="profile-trigger"
                onClick={() => setProfileOpen((v) => !v)}
                aria-haspopup="menu"
                aria-expanded={profileOpen}
                title="Account menu"
              >
                <span className="profile-avatar">{avatarChar}</span>
                <Icon name="chevronDown" size={14} stroke={2} className="profile-chevron" />
              </button>
              {profileOpen && (
                <div className="profile-dropdown" role="menu">
                  <div className="profile-head">
                    <div className="muted" style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text)' }}>{user?.name || 'Account'}</div>
                    <div className="faint" style={{ fontSize: '0.75rem' }}>{user?.email}</div>
                  </div>
                  <div className="mobile-divider" />
                  {!admin && (
                    <Link to="/profile" className="profile-item" role="menuitem" onClick={() => setProfileOpen(false)}>
                      <Icon name="user" size={15} stroke={1.8} /> Profile &amp; settings
                    </Link>
                  )}
                  {!admin && (
                    <Link to="/wallet" className="profile-item" role="menuitem" onClick={() => setProfileOpen(false)}>
                      <Icon name="wallet" size={15} stroke={1.8} /> Wallet
                    </Link>
                  )}
                  <button className="profile-item profile-item-danger" role="menuitem" onClick={onLogout}>
                    <Icon name="logout" size={15} stroke={1.8} /> Logout
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Mobile dropdown menu */}
        {!admin && (
          <div className={`mobile-menu ${mobileOpen ? 'open' : ''}`} ref={menuRef} role="dialog" aria-label="Navigation menu">
            <div className="mobile-menu-inner">
              {links.map(([to, label]) => (
                <NavLink key={to} to={to} className={({ isActive }) => 'mobile-link' + (isActive ? ' active' : '')}
                  onClick={closeMobile}>
                  {label}
                </NavLink>
              ))}
              {wallet != null && (
                <div className="mobile-wallet">
                  <span className="dot" style={{ background: 'var(--success)' }} /> Balance: {fmtInr(wallet)}
                </div>
              )}
              <div className="mobile-divider" />
              <div className="mobile-user muted" style={{ fontSize: '0.85rem', padding: '8px 0' }}>{user?.name || user?.email}</div>
              <button className="btn btn-ghost btn-sm" onClick={onLogout} style={{ textAlign: 'left', padding: '8px 0' }}>Logout</button>
            </div>
          </div>
        )}
      </div>
    </nav>
  );
}