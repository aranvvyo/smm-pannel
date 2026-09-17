import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { get, post } from '../api.js';

const AuthContext = createContext(null);

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await get('/api/auth/me');
      setUser(data.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const login = async (email, password) => {
    const data = await post('/api/auth/login', { email, password });
    setUser(data.user);
    return data.user;
  };

  const adminLogin = async (email, password) => {
    const data = await post('/api/admin/auth/login', { email, password });
    setUser(data.user);
    return data.user;
  };

  const register = async (payload) => {
    const data = await post('/api/auth/register', payload);
    setUser(data.user);
    return data.user;
  };

  const logout = async () => {
    try { await post('/api/auth/logout', {}); } catch { /* noop */ }
    setUser(null);
  };

  const adminLogout = async () => {
    try { await post('/api/admin/auth/logout', {}); } catch { /* noop */ }
    setUser(null);
  };

  const value = {
    user,
    loading,
    isAdmin: user?.role === 'admin',
    login,
    adminLogin,
    register,
    logout,
    adminLogout,
    refresh,
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}