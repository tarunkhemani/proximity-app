import { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster }    from 'react-hot-toast';

import { AuthProvider, useAuth } from './context/AuthContext';
import { SocketProvider }        from './context/SocketContext';
import OfflineBanner             from './components/OfflineBanner';

const LoginPage    = lazy(() => import('./pages/LoginPage'));
const RegisterPage = lazy(() => import('./pages/RegisterPage'));
const RadarPage    = lazy(() => import('./pages/RadarPage'));
const ChatPage     = lazy(() => import('./pages/ChatPage'));
const ProfilePage  = lazy(() => import('./pages/ProfilePage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));

function ProtectedRoute({ children }) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return children;
}

function PublicRoute({ children }) {
  const { isAuthenticated } = useAuth();
  if (isAuthenticated) return <Navigate to="/radar" replace />;
  return children;
}

function PageLoader() {
  return (
    <div className="min-h-screen bg-radar-bg flex flex-col items-center justify-center gap-4">
      <div className="relative w-16 h-16">
        <span className="absolute inset-0 rounded-full border border-beacon/30 animate-ping-slow" />
        <span className="absolute inset-2 rounded-full border border-beacon/50 animate-ping-slow [animation-delay:0.3s]" />
        <span className="absolute inset-4 rounded-full border border-beacon animate-ping-slow [animation-delay:0.6s]" />
      </div>
      <p className="text-white/40 text-sm tracking-widest uppercase font-mono">Loading…</p>
    </div>
  );
}

function InitialisingScreen() {
  return (
    <div className="min-h-screen bg-radar-bg flex flex-col items-center justify-center gap-6">
      <div className="relative w-20 h-20">
        <span className="absolute inset-0 rounded-full border border-beacon/20 animate-ping-slow" />
        <span className="absolute inset-3 rounded-full border border-beacon/40 animate-ping-slow [animation-delay:0.4s]" />
        <span className="absolute inset-6 rounded-full border-2 border-beacon animate-ping-slow [animation-delay:0.8s]" />
      </div>
      <p className="text-white/30 text-xs tracking-[0.3em] uppercase font-mono">Initialising</p>
    </div>
  );
}

function AppRouter() {
  const { isInitialising } = useAuth();

  if (isInitialising) return <InitialisingScreen />;

  return (
    <BrowserRouter>
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route index element={<Navigate to="/radar" replace />} />

          <Route
            path="/login"
            element={<PublicRoute><LoginPage /></PublicRoute>}
          />
          <Route
            path="/register"
            element={<PublicRoute><RegisterPage /></PublicRoute>}
          />
          <Route
            path="/radar"
            element={<ProtectedRoute><RadarPage /></ProtectedRoute>}
          />
          <Route
            path="/chat/:roomId"
            element={<ProtectedRoute><ChatPage /></ProtectedRoute>}
          />
          <Route
            path="/profile"
            element={<ProtectedRoute><ProfilePage /></ProtectedRoute>}
          />

          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <SocketProvider>
        <OfflineBanner />
        <AppRouter />
        <Toaster
          position="top-center"
          gutter={8}
          containerStyle={{ top: 16 }}
          toastOptions={{
            duration: 4000,
            style: {
              background:   '#0a1628',
              color:        '#ffffff',
              border:       '1px solid #1a3a5c',
              borderRadius: '12px',
              fontSize:     '14px',
              maxWidth:     '340px',
            },
            success: { iconTheme: { primary: '#00f5c4', secondary: '#0a1628' } },
            error:   { iconTheme: { primary: '#f87171', secondary: '#0a1628' } },
          }}
        />
      </SocketProvider>
    </AuthProvider>
  );
}

