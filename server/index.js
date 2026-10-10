import express from 'express';
import cookieParser from 'cookie-parser';
import { existsSync } from 'node:fs';
import { config } from './config.js';
import { getDb } from './db.js';
import { startOrderTicker } from './lib/orderRouter.js';
import { startProviderAutoSync } from './lib/providerAutoSync.js';
import { setupPaymentSimulator, setupApironeMonitor } from './lib/apirone.js';
import { startInrVerificationPoller } from './lib/inrVerification.js';
import { bootstrapManagedProvider } from './lib/managedProvider.js';

// Adapter registration (side-effect imports).
import './lib/providers/demo.js';
import './lib/providers/smmpost.js';

import publicRoutes from './routes/public.js';
import clientAuthRoutes from './routes/client.auth.js';
import clientServiceRoutes from './routes/client.services.js';
import clientOrderRoutes, { quoteRouter } from './routes/client.orders.js';
import clientWalletRoutes from './routes/client.wallet.js';
import clientInrDepositRoutes from './routes/client.inrDeposits.js';
import clientTicketRoutes from './routes/client.tickets.js';
import clientNotifRoutes from './routes/client.notifications.js';

import adminAuthRoutes from './routes/admin.auth.js';
import adminUserRoutes from './routes/admin.users.js';
import adminServiceRoutes from './routes/admin.services.js';
import adminProviderRoutes from './routes/admin.providers.js';
import adminOrderRoutes from './routes/admin.orders.js';
import adminCouponRoutes from './routes/admin.coupons.js';
import { dashboardRouter, depositsRouter } from './routes/admin.finance.js';
import adminTicketRoutes from './routes/admin.tickets.js';
import adminLogRoutes from './routes/admin.logs.js';
import adminSettingsRoutes from './routes/admin.settings.js';
import adminWithdrawRoutes from './routes/admin.withdraw.js';
import adminInrDepositRoutes from './routes/admin.inrDeposits.js';
import adminDepositMaintenanceRoutes from './routes/admin.depositMaintenance.js';
import depositStatusRoutes from './routes/depositStatus.js';
import webhooks from './routes/webhooks.js';

const app = express();
app.disable('x-powered-by');

// Baseline security headers (dependency-free, applied to every
// response including static assets). A strict CSP is intentionally
// NOT set here — the UI uses inline styles throughout and a safe
// policy needs browser testing; revisit in a hardening pass.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// --- webhooks first (they need the RAW body, not the JSON parser) ---
app.use('/webhooks', webhooks);

app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));

// --- CSRF defense-in-depth (Task 17). Cookies are SameSite=strict; this is a
// second line for any same-site-settings change: for a JSON/POST mutation the
// browser's Origin header MUST match the Host header. Attackers cannot spoof
// Origin — only the victim site can produce a matching one. Requests without
// an Origin (curl, scripted tools) are unaffected. ---
app.use('/api', (req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next(); // no browser context (curl, Postman) — cookie still SameSite-gated
  let originHost;
  try { originHost = new URL(origin).host; } catch { return next(); }
  if (String(req.headers.host || '') !== originHost) {
    return res.status(403).json({ error: 'Cross-origin request rejected.' });
  }
  return next();
});

// --- public + client API ---
app.use('/api', publicRoutes);
app.use('/api/auth', clientAuthRoutes);
app.use('/api/services', clientServiceRoutes);
app.use('/api', quoteRouter);               // /api/quote
app.use('/api/orders', clientOrderRoutes);
// INSTA SMM GATEWAY (INR) deposit routes — mounted BEFORE the general
// wallet router so /api/deposits/inr is never captured by the wallet
// router's GET /deposits/:id. (Previously never mounted at all: every
// request fell through to the catch-all and returned "Not found.")
app.use('/api/deposit-status', depositStatusRoutes);   // public, read-only banner state
app.use('/api/deposits/inr', clientInrDepositRoutes);
app.use('/api', clientWalletRoutes);        // /api/wallet, /api/deposits, /api/cryptos
app.use('/api/tickets', clientTicketRoutes);
app.use('/api/notifications', clientNotifRoutes);

// --- admin API. Each router is mounted at its OWN namespace so a broad
// 'GET /:id' in one router can never shadow a specific path in another. ---
app.use('/api/admin/auth', adminAuthRoutes);
app.use('/api/admin/dashboard', dashboardRouter);
// INR manual-verification endpoints — mounted BEFORE the general
// deposits router so /api/admin/deposits/inr is never captured by
// its /:id route.
app.use('/api/admin/deposits/inr', adminInrDepositRoutes);
app.use('/api/admin/deposit-maintenance', adminDepositMaintenanceRoutes);
app.use('/api/admin/deposits', depositsRouter);
app.use('/api/admin/users', adminUserRoutes);
app.use('/api/admin/services', adminServiceRoutes);
app.use('/api/admin/providers', adminProviderRoutes);
app.use('/api/admin/orders', adminOrderRoutes);
app.use('/api/admin/coupons', adminCouponRoutes);
app.use('/api/admin/tickets', adminTicketRoutes);
app.use('/api/admin/logs', adminLogRoutes);
app.use('/api/admin/settings', adminSettingsRoutes);
app.use('/api/admin/withdrawals', adminWithdrawRoutes);

// --- 404 for unknown API paths (never leak anything) ---
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// --- SPA static hosting (built React app) ---
const dist = config.clientDir;
if (existsSync(dist)) {
  app.use(express.static(dist));
  // React Router fallback for client & admin SPA routes.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/webhooks')) return next();
    res.sendFile(dist + '/index.html');
  });
  console.log(`[instasmm] Serving SPA from ${dist}`);
} else {
  console.log(`[instasmm] SPA not built yet (${dist}). Run: npm run build`);
}

// --- global error handler ---
app.use((err, req, res, next) => {
  console.error('[instasmm] error:', err.message);
  if (res.headersSent) return next(err);
  return res.status(500).json({ error: 'Internal server error.' });
});

// --- boot ---
getDb(); // ensure schema + seed
// Environment-managed supplier (THEMAINSMMPROVIDER_*). No network calls —
// the catalog is still pulled only via Admin → Providers → Sync Services.
const managedProvider = bootstrapManagedProvider();
if (managedProvider.status === 'error') {
  console.warn('[instasmm] Environment-managed provider NOT configured:', managedProvider.message);
} else if (managedProvider.status !== 'skipped') {
  console.log(`[instasmm] Environment-managed provider ${managedProvider.status} (id ${managedProvider.id}).`);
}
startOrderTicker();
startProviderAutoSync();
setupPaymentSimulator();
setupApironeMonitor();
// Returns null unless automatic INR crediting is allowed (contract confirmed AND
// autoCreditEnabled). Today it always returns null, so no poll runs.
startInrVerificationPoller();

app.listen(config.port, '0.0.0.0', () => {
  console.log(`\n  ${config.brand.name} ready  →  http://localhost:${config.port}`);
  console.log(`     Client UI & API on the same origin. Admin at /admin`);
  console.log(`     Bound to 0.0.0.0 — reachable on the LAN at http://<this-host-ip>:${config.port}\n`);
});