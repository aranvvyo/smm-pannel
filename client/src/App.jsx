import { Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './contexts/AuthContext.jsx';
import { ToastProvider, Spinner } from './ui.jsx';
import { Layout, Navbar } from './components/Layout.jsx';

import Landing from './pages/landing/Landing.jsx';
import Login from './pages/auth/Login.jsx';
import Signup from './pages/auth/Signup.jsx';
import ClientDashboard from './pages/client/Dashboard.jsx';
import OrderPage from './pages/client/OrderPage.jsx';
import OrdersList from './pages/client/Orders.jsx';
import WalletPage from './pages/client/Wallet.jsx';
import DepositPage from './pages/client/Deposit.jsx';
import VcDepositPage from './pages/client/VcDeposit.jsx';
import TicketsPage from './pages/client/Tickets.jsx';
import NotificationsPage from './pages/client/Notifications.jsx';
import ProfilePage from './pages/client/Profile.jsx';
import TermsPage from './pages/client/Terms.jsx';
import PrivacyPage from './pages/client/Privacy.jsx';

import AdminLayout from './pages/admin/AdminLayout.jsx';
import AdminDashboard from './pages/admin/Dashboard.jsx';
import AdminUsers from './pages/admin/Users.jsx';
import AdminServices from './pages/admin/Services.jsx';
import AdminProviders from './pages/admin/Providers.jsx';
import AdminOrders from './pages/admin/Orders.jsx';
import AdminCoupons from './pages/admin/Coupons.jsx';
import AdminDeposits from './pages/admin/Deposits.jsx';
import AdminWithdraw from './pages/admin/Withdraw.jsx';
import AdminTickets from './pages/admin/Tickets.jsx';
import AdminLogs from './pages/admin/Logs.jsx';
import AdminSettings from './pages/admin/Settings.jsx';

function RequireClient({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <Spinner />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role === 'admin') return <Navigate to="/admin" replace />;
  return children;
}

function RequireAdmin({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <Spinner />;
  if (user?.role !== 'admin') return <Navigate to="/admin/login" replace />;
  return children;
}

export default function App() {
  return (
    <ToastProvider>
      <Routes>
        {/* Public */}
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<PublicOnly><Login /></PublicOnly>} />
        <Route path="/signup" element={<PublicOnly><Signup /></PublicOnly>} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />

        {/* Client area */}
        <Route element={<RequireClient><ClientShell /></RequireClient>}>
          <Route path="/dashboard" element={<ClientDashboard />} />
          <Route path="/order" element={<OrderPage />} />
          <Route path="/orders" element={<OrdersList />} />
          <Route path="/wallet" element={<WalletPage />} />
          <Route path="/deposit" element={<DepositPage />} />
          <Route path="/deposit/inr" element={<VcDepositPage />} />
          <Route path="/tickets" element={<TicketsPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/profile" element={<ProfilePage />} />
        </Route>

        {/* Admin area */}
        <Route path="/admin/login" element={<PublicOnly><Login admin /></PublicOnly>} />
        <Route element={<RequireAdmin><AdminLayout /></RequireAdmin>}>
          <Route path="/admin" element={<AdminDashboard />} />
          <Route path="/admin/users" element={<AdminUsers />} />
          <Route path="/admin/services" element={<AdminServices />} />
          <Route path="/admin/providers" element={<AdminProviders />} />
          <Route path="/admin/orders" element={<AdminOrders />} />
          <Route path="/admin/coupons" element={<AdminCoupons />} />
          <Route path="/admin/deposits" element={<AdminDeposits />} />
          <Route path="/admin/withdrawals" element={<AdminWithdraw />} />
          <Route path="/admin/tickets" element={<AdminTickets />} />
          <Route path="/admin/logs" element={<AdminLogs />} />
          <Route path="/admin/settings" element={<AdminSettings />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ToastProvider>
  );
}

function PublicOnly({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <Spinner />;
  if (user) return <Navigate to={user.role === 'admin' ? '/admin' : '/dashboard'} replace />;
  return children;
}

function ClientShell() {
  const { user } = useAuth();
  const links = [
    ['/dashboard', 'Dashboard'],
    ['/order', 'New Order'],
    ['/orders', 'My Orders'],
    ['/wallet', 'Wallet'],
    ['/deposit', 'Deposit'],
    ['/tickets', 'Support'],
    ['/notifications', 'Notifications'],
    ['/profile', 'Profile'],
  ];
  return (
    <Layout>
      <Navbar links={links} wallet={user?.wallet_inr} />
      <main className="container page"><Outlet /></main>
    </Layout>
  );
}
