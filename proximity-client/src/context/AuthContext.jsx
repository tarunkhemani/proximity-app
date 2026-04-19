import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
} from 'react';
import api from '../lib/api';

const AuthContext = createContext(null);

export const TOKEN_KEY = 'proximity_token';
export const USER_KEY  = 'proximity_user';

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));
  const [user,  setUser]  = useState(() => {
    try {
      const raw = localStorage.getItem(USER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });

  // Loading states
  const [isLoading,      setIsLoading]      = useState(false);
  const [isInitialising, setIsInitialising] = useState(true); // true on first load

  // Track if we've already verified the stored token this session
  const verifiedRef = useRef(false);

  // ── Persist helpers ────────────────────────────────────────────────────────
  const persistSession = useCallback((newToken, newUser) => {
    localStorage.setItem(TOKEN_KEY, newToken);
    localStorage.setItem(USER_KEY, JSON.stringify(newUser));
    setToken(newToken);
    setUser(newUser);
  }, []);

  const clearSession = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setToken(null);
    setUser(null);
  }, []);

  // ── Verify stored token on mount ───────────────────────────────────────────
  // When the user refreshes the page, they may have a valid token in localStorage.
  // We call GET /api/auth/me to confirm it is still valid and re-hydrate the
  // user object in case their profile changed since the token was issued.
  useEffect(() => {
    if (verifiedRef.current) return;
    verifiedRef.current = true;

    const storedToken = localStorage.getItem(TOKEN_KEY);

    if (!storedToken) {
      setIsInitialising(false);
      return;
    }

    api
      .get('/auth/me')
      .then(({ data }) => {
        // Token is valid — update the user object from the server
        localStorage.setItem(USER_KEY, JSON.stringify(data.user));
        setUser(data.user);
      })
      .catch(() => {
        // Token is invalid or expired and refresh also failed —
        // the axios interceptor already cleared localStorage, but we
        // reset state here too for safety.
        clearSession();
      })
      .finally(() => {
        setIsInitialising(false);
      });
  }, [clearSession]);

  // ── register ───────────────────────────────────────────────────────────────
  // Returns { success: true } or { success: false, error, fields }
  const register = useCallback(async ({ name, email, password, bio, tags }) => {
    setIsLoading(true);
    try {
      const { data } = await api.post('/auth/register', {
        name,
        email,
        password,
        bio:  bio  || '',
        tags: tags || [],
      });

      persistSession(data.accessToken, data.user);
      return { success: true };
    } catch (err) {
      const data = err.response?.data;
      return {
        success: false,
        error:  data?.error  || 'Registration failed. Please try again.',
        fields: data?.fields || {},
      };
    } finally {
      setIsLoading(false);
    }
  }, [persistSession]);

  // ── login ──────────────────────────────────────────────────────────────────
  const login = useCallback(async ({ email, password }) => {
    setIsLoading(true);
    try {
      const { data } = await api.post('/auth/login', { email, password });

      persistSession(data.accessToken, data.user);
      return { success: true };
    } catch (err) {
      const data = err.response?.data;
      return {
        success: false,
        error: data?.error || 'Login failed. Please check your credentials.',
      };
    } finally {
      setIsLoading(false);
    }
  }, [persistSession]);

  // ── logout ─────────────────────────────────────────────────────────────────
  const logout = useCallback(async () => {
    try {
      // Best-effort server-side session revocation
      await api.post('/auth/logout');
    } catch {
      // Continue with client-side logout even if the server call fails
    } finally {
      clearSession();
    }
  }, [clearSession]);

  // ── updateUserState ────────────────────────────────────────────────────────
  // Called after profile edits so the context stays in sync without a full
  // re-fetch. Only updates fields that were changed.
  const updateUserState = useCallback((partial) => {
    setUser((prev) => {
      if (!prev) return prev;
      const updated = { ...prev, ...partial };
      localStorage.setItem(USER_KEY, JSON.stringify(updated));
      return updated;
    });
  }, []);

  const isAuthenticated = Boolean(token && user);

  return (
    <AuthContext.Provider
      value={{
        token,
        user,
        isLoading,
        isInitialising,
        isAuthenticated,
        register,
        login,
        logout,
        updateUserState,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
// import { createContext, useContext, useState, useCallback } from 'react';

// const AuthContext = createContext(null);

// // TOKEN KEY — centralised so it's consistent across all reads/writes
// export const TOKEN_KEY = 'proximity_token';
// export const USER_KEY  = 'proximity_user';

// export function AuthProvider({ children }) {
//   // Initialise from localStorage so the session survives a page refresh.
//   // In Phase 5 we will wire this up to POST /api/auth/login.
//   const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));
//   const [user,  setUser]  = useState(() => {
//     try {
//       const raw = localStorage.getItem(USER_KEY);
//       return raw ? JSON.parse(raw) : null;
//     } catch {
//       return null;
//     }
//   });

//   const login = useCallback((newToken, newUser) => {
//     localStorage.setItem(TOKEN_KEY, newToken);
//     localStorage.setItem(USER_KEY, JSON.stringify(newUser));
//     setToken(newToken);
//     setUser(newUser);
//   }, []);

//   const logout = useCallback(() => {
//     localStorage.removeItem(TOKEN_KEY);
//     localStorage.removeItem(USER_KEY);
//     setToken(null);
//     setUser(null);
//   }, []);

//   // isAuthenticated: true only when both token and user are present.
//   // Components use this to decide whether to render protected content.
//   const isAuthenticated = Boolean(token && user);

//   return (
//     <AuthContext.Provider value={{ token, user, login, logout, isAuthenticated }}>
//       {children}
//     </AuthContext.Provider>
//   );
// }

// // eslint-disable-next-line react-refresh/only-export-components
// export function useAuth() {
//   const ctx = useContext(AuthContext);
//   if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
//   return ctx;
// }