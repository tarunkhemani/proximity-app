import { Suspense, lazy, useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster }       from 'react-hot-toast';
import { useRegisterSW } from 'virtual:pwa-register/react';

import { AuthProvider, useAuth } from './context/AuthContext';
import { SocketProvider }        from './context/SocketContext';
import OfflineBanner             from './components/OfflineBanner';

// ── Lazy-loaded pages ─────────────────────────────────────────────────────────
const LoginPage   = lazy(() => import('./pages/LoginPage'));
const RegisterPage = lazy(() => import('./pages/RegisterPage'));
const RadarPage   = lazy(() => import('./pages/RadarPage'));
const ChatPage    = lazy(() => import('./pages/ChatPage'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));

// ── Route guards ──────────────────────────────────────────────────────────────
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

// ── Loading screen ────────────────────────────────────────────────────────────
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

// ── Initialising screen (shown while stored token is being verified) ───────────
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

// ── PWA update prompt ─────────────────────────────────────────────────────────
// Shown when a new service worker is waiting. Prompts the user to reload
// and get the latest version rather than silently updating mid-session.
function PWAUpdatePrompt() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegistered(r) {
      console.log('[pwa] Service worker registered:', r);
    },
    onRegisterError(error) {
      console.error('[pwa] Service worker registration error:', error);
    },
  });

  if (!needRefresh) return null;

  return (
    <div className="fixed bottom-4 left-4 right-4 z-50 max-w-sm mx-auto">
      <div className="card p-4 flex items-center justify-between gap-3 shadow-card border-beacon/30">
        <div>
          <p className="text-sm font-semibold text-white">Update available</p>
          <p className="text-xs text-white/40 mt-0.5">Reload to get the latest version</p>
        </div>
        <button
          type="button"
          onClick={() => updateServiceWorker(true)}
          className="btn-primary text-xs py-1.5 px-3 h-auto flex-shrink-0"
        >
          Reload
        </button>
      </div>
    </div>
  );
}

// ── Router ────────────────────────────────────────────────────────────────────
function AppRouter() {
  const { isInitialising } = useAuth();

  if (isInitialising) return <InitialisingScreen />;

  return (
    <BrowserRouter>
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route index element={<Navigate to="/radar" replace />} />

          <Route path="/login"    element={<PublicRoute><LoginPage /></PublicRoute>} />
          <Route path="/register" element={<PublicRoute><RegisterPage /></PublicRoute>} />

          <Route path="/radar"        element={<ProtectedRoute><RadarPage /></ProtectedRoute>} />
          <Route path="/chat/:roomId" element={<ProtectedRoute><ChatPage /></ProtectedRoute>} />
          <Route path="/profile"      element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} />

          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────────
export default function App() {
  return (
    <AuthProvider>
      <SocketProvider>
        {/* Offline detection banner — sits above everything */}
        <OfflineBanner />

        <AppRouter />

        {/* PWA update prompt */}
        <PWAUpdatePrompt />

        {/* Toast notifications */}
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
// import { Suspense, lazy } from 'react';
// import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
// import { Toaster } from 'react-hot-toast';

// import { AuthProvider, useAuth } from './context/AuthContext';
// import { SocketProvider } from './context/SocketContext';

// // ── Lazy-loaded route components ──────────────────────────────────────────────
// // Lazy loading splits the JS bundle — each route is its own chunk that only
// // loads when the user navigates to it. Critical for a PWA / mobile performance.
// //
// // These pages will be built in Phase 5. The file stubs below are needed
// // so Vite doesn't throw import errors right now.
// const LoginPage    = lazy(() => import('./pages/LoginPage'));
// const RegisterPage = lazy(() => import('./pages/RegisterPage'));
// const RadarPage    = lazy(() => import('./pages/RadarPage'));
// const ChatPage     = lazy(() => import('./pages/ChatPage'));
// const ProfilePage  = lazy(() => import('./pages/ProfilePage'));
// const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));

// // ── Route guards ──────────────────────────────────────────────────────────────
// // ProtectedRoute: wraps pages that require authentication.
// // If not authenticated, redirects to /login and remembers where the user
// // was trying to go (passed as ?next= so login can redirect back after success).
// function ProtectedRoute({ children }) {
//   const { isAuthenticated } = useAuth();

//   if (!isAuthenticated) {
//     const next = encodeURIComponent(window.location.pathname + window.location.search);
//     return <Navigate to={`/login?next=${next}`} replace />;
//   }

//   return children;
// }

// // PublicRoute: wraps pages like login/register that should redirect
// // authenticated users to the app instead of showing them the auth forms.
// function PublicRoute({ children }) {
//   const { isAuthenticated } = useAuth();

//   if (isAuthenticated) {
//     return <Navigate to="/radar" replace />;
//   }

//   return children;
// }

// // ── Page-level loading skeleton ───────────────────────────────────────────────
// // Shown by <Suspense> while a lazy page chunk is downloading.
// function PageLoader() {
//   return (
//     <div className="min-h-screen bg-radar-bg flex flex-col items-center justify-center gap-4">
//       {/* Animated radar rings */}
//       <div className="relative w-16 h-16">
//         <span className="absolute inset-0 rounded-full border border-beacon/30 animate-ping-slow" />
//         <span className="absolute inset-2 rounded-full border border-beacon/50 animate-ping-slow [animation-delay:0.3s]" />
//         <span className="absolute inset-4 rounded-full border border-beacon animate-ping-slow [animation-delay:0.6s]" />
//       </div>
//       <p className="text-white/40 text-sm tracking-widest uppercase font-mono">
//         Loading…
//       </p>
//     </div>
//   );
// }

// // ── Router tree ───────────────────────────────────────────────────────────────
// function AppRouter() {
//   const { isInitialising } = useAuth();

//   // Block rendering until the stored token has been verified.
//   // Without this, ProtectedRoute redirects to /login on every hard refresh
//   // before the async /auth/me call resolves.
//   if (isInitialising) return <InitialisingScreen />;
//   return (
//     <BrowserRouter>
//       <Suspense fallback={<PageLoader />}>
//         <Routes>
//           {/* Public root → redirect to /radar (if auth) or /login (if not) */}
//           <Route index element={<Navigate to="/radar" replace />} />

//           {/* Auth routes — redirect to /radar if already logged in */}
//           <Route
//             path="/login"
//             element={
//               <PublicRoute>
//                 <LoginPage />
//               </PublicRoute>
//             }
//           />
//           <Route
//             path="/register"
//             element={
//               <PublicRoute>
//                 <RegisterPage />
//               </PublicRoute>
//             }
//           />

//           {/* Protected app routes — require authentication */}
//           <Route
//             path="/radar"
//             element={
//               <ProtectedRoute>
//                 <RadarPage />
//               </ProtectedRoute>
//             }
//           />
//           <Route
//             path="/chat/:roomId"
//             element={
//               <ProtectedRoute>
//                 <ChatPage />
//               </ProtectedRoute>
//             }
//           />
//           <Route
//             path="/profile"
//             element={
//               <ProtectedRoute>
//                 <ProfilePage />
//               </ProtectedRoute>
//             }
//           />

//           {/* 404 catch-all */}
//           <Route path="*" element={<NotFoundPage />} />
//         </Routes>
//       </Suspense>
//     </BrowserRouter>
//   );
// }
// function InitialisingScreen() {
//   return (
//     <div className="min-h-screen bg-radar-bg flex flex-col items-center justify-center gap-6">
//       <div className="relative w-20 h-20">
//         <span className="absolute inset-0 rounded-full border border-beacon/20 animate-ping-slow" />
//         <span className="absolute inset-3 rounded-full border border-beacon/40 animate-ping-slow [animation-delay:0.4s]" />
//         <span className="absolute inset-6 rounded-full border-2 border-beacon animate-ping-slow [animation-delay:0.8s]" />
//       </div>
//       <p className="text-white/30 text-xs tracking-[0.3em] uppercase font-mono">
//         Initialising
//       </p>
//     </div>
//   );
// }
// // ── Root app component ────────────────────────────────────────────────────────
// // Provider order matters:
// //   AuthProvider  — must wrap SocketProvider (socket reads the token from auth)
// //   SocketProvider — must wrap all pages that use useSocket()
// //   Toaster       — renders outside the component tree, always visible

// export default function App() {
//   return (
//     <AuthProvider>
//       <SocketProvider>
//         <AppRouter />

//         {/* Global toast renderer — configured for the dark radar theme */}
//         <Toaster
//           position="top-center"
//           gutter={8}
//           containerStyle={{ top: 16 }}
//           toastOptions={{
//             duration: 4000,
//             style: {
//               background: '#0a1628',
//               color:      '#ffffff',
//               border:     '1px solid #1a3a5c',
//               borderRadius: '12px',
//               fontSize:   '14px',
//               maxWidth:   '340px',
//             },
//             success: {
//               iconTheme: { primary: '#00f5c4', secondary: '#0a1628' },
//             },
//             error: {
//               iconTheme: { primary: '#f87171', secondary: '#0a1628' },
//             },
//           }}
//         />
//       </SocketProvider>
//     </AuthProvider>
//   );
// }
// function App() {
//   return (
//     <div className="min-h-screen flex items-center justify-center bg-gray-900">
//       <h1 className="text-4xl font-bold text-green-400">Tailwind is Working!</h1>
//     </div>
//   )
// }

// export default App