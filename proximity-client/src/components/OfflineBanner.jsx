import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { WifiOff, Wifi } from 'lucide-react';

// ── useOnlineStatus ────────────────────────────────────────────────────────────
// Tracks browser online/offline state using the navigator.onLine API and the
// online/offline window events. Works reliably on mobile (airplane mode,
// dropping from wifi to no signal).
function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    const goOnline  = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);

    window.addEventListener('online',  goOnline);
    window.addEventListener('offline', goOffline);

    return () => {
      window.removeEventListener('online',  goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return isOnline;
}

// ── OfflineBanner ──────────────────────────────────────────────────────────────
// Renders a banner at the very top of the viewport when the device is offline.
// Also shows a brief "back online" confirmation when connectivity is restored.
export default function OfflineBanner() {
  const isOnline = useOnlineStatus();

  // Track previous state so we can show the "back online" flash
  const [wasOffline, setWasOffline] = useState(false);
  const [showOnline, setShowOnline] = useState(false);

  useEffect(() => {
    if (!isOnline) {
      setWasOffline(true);
      setShowOnline(false);
    } else if (wasOffline) {
      // Just came back online — flash a confirmation then dismiss
      setShowOnline(true);
      const timer = setTimeout(() => {
        setShowOnline(false);
        setWasOffline(false);
      }, 2500);
      return () => clearTimeout(timer);
    }
  }, [isOnline, wasOffline]);

  return (
    <AnimatePresence>
      {!isOnline && (
        <motion.div
          key="offline"
          initial={{ y: -48, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -48, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 30 }}
          className="fixed top-0 left-0 right-0 z-[100] flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium"
          style={{
            background: 'linear-gradient(90deg, #1a1000 0%, #2a1800 50%, #1a1000 100%)',
            borderBottom: '1px solid rgba(245,158,11,0.3)',
            color: '#fbbf24',
          }}
          role="alert"
          aria-live="assertive"
        >
          <WifiOff size={15} className="flex-shrink-0" />
          <span>You are offline — real-time features paused</span>
        </motion.div>
      )}

      {isOnline && showOnline && (
        <motion.div
          key="back-online"
          initial={{ y: -48, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -48, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 30 }}
          className="fixed top-0 left-0 right-0 z-[100] flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium"
          style={{
            background: 'linear-gradient(90deg, #001a0e 0%, #00281a 50%, #001a0e 100%)',
            borderBottom: '1px solid rgba(0,245,196,0.3)',
            color: '#00f5c4',
          }}
          role="status"
          aria-live="polite"
        >
          <Wifi size={15} className="flex-shrink-0" />
          <span>Back online — reconnecting…</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}