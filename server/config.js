import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const port = parseInt(process.env.PORT || '3000', 10);

// Admin credentials are read from the environment (never hardcoded in this
// file or committed to git). An account is only enabled when BOTH its email and
// password are set. Emails are normalized to lowercase to match login handling.
function adminAccountsFromEnv() {
  const accounts = [
    [process.env.ADMIN_EMAIL_1 || process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD_1 || process.env.ADMIN_PASSWORD],
    [process.env.ADMIN_EMAIL_2, process.env.ADMIN_PASSWORD_2],
  ];
  const admins = {};
  for (const [email, password] of accounts) {
    if (email && password && String(email).includes('@')) {
      admins[String(email).trim().toLowerCase()] = String(password);
    }
  }
  return admins;
}

// ---------------------------------------------------------------------------
// Server configuration. Admin credentials are immutable by design — they can
// ONLY be changed here in the codebase (never through the UI).
// ---------------------------------------------------------------------------
export const config = {
  nodeEnv: process.env.NODE_ENV || 'production',
  port,
  // Root of the project
  rootDir: path.resolve(__dirname, '..'),
  // Where the compiled React SPA lives (produced by `npm run build`)
  clientDir: path.resolve(__dirname, '..', 'client', 'dist'),
  dbFile: process.env.DB_FILE || path.resolve(__dirname, '..', 'data', 'instasmm.db'),
  sessionSecret: process.env.SESSION_SECRET || 'instasmm-local-dev-secret-change-me',
  sessionTtlMs: parseInt(process.env.SESSION_TTL_MS || String(1000 * 60 * 60 * 24 * 30), 10), // ~30 days persistent

  // Public base URL — used for Apirone callback URLs and QR codes.
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),

  // Platform branding
  brand: {
    name: 'InstaSMM',
    domain: 'instasmm.store',
  },

  // Admin owner accounts. Credentials come ONLY from environment variables —
  // never from the codebase (a committed admin password would leak on GitHub):
  //   ADMIN_EMAIL_1 / ADMIN_PASSWORD_1   primary owner (also ADMIN_EMAIL short forms)
  //   ADMIN_EMAIL_2 / ADMIN_PASSWORD_2   optional second owner
  // Emails on this list are Admins; every other email is a Client. When no
  // accounts are configured the instance boots with NO admins (secure default);
  // you must set these in your shell (local) or Render's environment.
  admins: adminAccountsFromEnv(),

  // Default settings merged on first boot (admin can tweak via settings table)
  defaultSettings: {
    exchange_rate: 100,      // 1 USD = 100 INR
    deposit_timeout_hours: 24,
    // DEFAULT OFF: a created invoice must NEVER auto-confirm by itself.
    // Turning this on is an explicit admin choice to simulate a payment
    // landing for demo/testing — it is not a substitute for a real payment.
    demo_auto_confirm: '0',
    demo_confirm_seconds: '8',
    demo_payout_seconds: '6', // demo provider simulate latency
    // Global default markup applied to freshly-synced provider services
    // (per-service markup overrides; per-provider markup overrides global).
    global_markup_type: 'percent',
    global_markup_value: '25',
    // Support channels — OUR OWN contacts only. Empty until an admin fills
    // them in Settings. Never a supplier's channel.
    support_email: '',
    support_whatsapp: '',
    support_telegram: '',
    support_phone: '',
  },

  // Apirone base URL (self-hosted or apirone.com). Credentials (account_id,
  // transfer_key, webhook_token) are stored in the settings table and entered
  // at runtime through Admin → Settings — NEVER in env or codebase.
  apirone: {
    apiUrl: process.env.APIRONE_API_URL || 'https://apirone.com',
  },

  depositCryptos: [
    { id: 'LTC', label: 'Litecoin', short: 'LTC', net: 'LTC', hot: true },
    { id: 'BEP20_USDT', label: 'Tether USD (BSC/BEP20)', short: 'USDT BEP20', net: 'BSC', hot: false },
    { id: 'ERC20_USDT', label: 'Tether USD (ERC20)', short: 'USDT ERC20', net: 'ETH', hot: false },
  ],
};
