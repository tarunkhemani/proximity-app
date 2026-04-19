import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
} from 'react';
import { io }   from 'socket.io-client';
import toast    from 'react-hot-toast';
import { useAuth } from './AuthContext';

const SOCKET_URL          = import.meta.env.VITE_SOCKET_URL || 'http://localhost:5000';
const RECONNECT_DELAY_MIN = 1_000;
const RECONNECT_DELAY_MAX = 10_000;

const SocketContext = createContext(null);

export function SocketProvider({ children }) {
  const { token, isAuthenticated } = useAuth();

  const socketRef = useRef(null);

  // ── Connection state ───────────────────────────────────────────────────────
  const [isConnected,     setIsConnected]     = useState(false);
  const [isConnecting,    setIsConnecting]    = useState(false);
  const [connectionError, setConnectionError] = useState(null);

  // ── Proximity state ────────────────────────────────────────────────────────
  const [nearbyUsers, setNearbyUsers] = useState([]);

  // ── Beacon state ───────────────────────────────────────────────────────────
  const [beaconActive,    setBeaconActive]    = useState(false);
  const [beaconExpiresAt, setBeaconExpiresAt] = useState(null);

  // ── Inbox state ────────────────────────────────────────────────────────────
  // pendingIncomingRequests: requests this user has RECEIVED and not yet acted on.
  // Persisted in context so the badge count and drawer list stay in sync across
  // navigation without a full re-fetch.
  const [pendingIncomingRequests, setPendingIncomingRequests] = useState([]);

  // unreadMessageCount: total unread messages across all rooms.
  // Seeded from session:ready on connect, decremented when rooms are read.
  const [unreadMessageCount, setUnreadMessageCount] = useState(0);

  // ── Socket init / teardown ────────────────────────────────────────────────
  useEffect(() => {
    if (!isAuthenticated || !token) {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
        setIsConnected(false);
        setIsConnecting(false);
      }
      return;
    }

    if (socketRef.current?.connected) return;

    setIsConnecting(true);
    setConnectionError(null);

    const socket = io(SOCKET_URL, {
      auth:                { token: `Bearer ${token}` },
      transports:          ['polling', 'websocket'],
      reconnection:        true,
      reconnectionAttempts: 10,
      reconnectionDelay:    RECONNECT_DELAY_MIN,
      reconnectionDelayMax: RECONNECT_DELAY_MAX,
      randomizationFactor:  0.5,
      timeout:              10_000,
      autoConnect:          false,
      connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000,
        skipMiddlewares: false,
      },
    });

    // ── Lifecycle ────────────────────────────────────────────────────────────
    socket.on('connect', () => {
      console.log(`[socket] Connected — id: ${socket.id}`);
      setIsConnected(true);
      setIsConnecting(false);
      setConnectionError(null);
    });

    socket.on('disconnect', (reason) => {
      console.log(`[socket] Disconnected — reason: ${reason}`);
      setIsConnected(false);
      if (reason === 'io server disconnect') socket.connect();
    });

    socket.on('connect_error', (err) => {
      console.error('[socket] Connection error:', err.message);
      setIsConnecting(false);
      setConnectionError(err.message);
      if (err.message.startsWith('AUTH_EXPIRED')) {
        toast.error('Session expired. Please log in again.', { id: 'auth-expired' });
      } else if (err.message.startsWith('AUTH_')) {
        toast.error('Authentication failed. Please log in again.', { id: 'auth-error' });
      } else {
        toast.error('Lost connection to server. Retrying…', { id: 'conn-error' });
      }
    });

    socket.on('reconnect', (attempt) => {
      console.log(`[socket] Reconnected after ${attempt} attempt(s)`);
      toast.success('Reconnected!', { id: 'reconnected', duration: 2000 });
    });

    socket.on('reconnect_failed', () => {
      setIsConnecting(false);
      setConnectionError('Could not reconnect after multiple attempts.');
      toast.error('Could not reconnect. Please refresh the page.', { id: 'reconnect-failed' });
    });

    // ── Application events ───────────────────────────────────────────────────

    socket.on('session:ready', ({ userId, unreadCount }) => {
      console.log(`[socket] Session ready — userId: ${userId}, unread: ${unreadCount}`);
      setUnreadMessageCount(unreadCount ?? 0);
    });

    socket.on('proximity:nearby', ({ users }) => {
      setNearbyUsers(users || []);
    });

    socket.on('proximity:appeared', (user) => {
      setNearbyUsers((prev) => {
        const alreadyPresent = prev.some((u) => u.userId === user.userId);
        if (!alreadyPresent) {
          toast(`${user.name} is nearby — ${user.zone}`, {
            icon: '📡',
            style: { background: '#0a1628', color: '#fff', border: '1px solid #1a3a5c' },
          });
          return [...prev, user];
        }
        return prev;
      });
    });

    socket.on('beacon:started', ({ isVisible, beaconExpiresAt: expiresAt, durationMinutes }) => {
      setBeaconActive(isVisible);
      setBeaconExpiresAt(expiresAt ? new Date(expiresAt) : null);
      toast.success(`Beacon active for ${durationMinutes} minutes`, { id: 'beacon-started' });
    });

    socket.on('beacon:stopped', () => {
      setBeaconActive(false);
      setBeaconExpiresAt(null);
      setNearbyUsers([]);
      toast('Beacon stopped. You are now invisible.', {
        icon: '🔕',
        id:   'beacon-stopped',
        style: { background: '#0a1628', color: '#fff', border: '1px solid #1a3a5c' },
      });
    });

    socket.on('beacon:expired', () => {
      setBeaconActive(false);
      setBeaconExpiresAt(null);
      setNearbyUsers([]);
      toast('Your beacon has expired.', {
        icon:     '⏱',
        id:       'beacon-expired',
        duration: 5000,
        style:    { background: '#0a1628', color: '#fff', border: '1px solid #1a3a5c' },
      });
    });

    // ── Incoming connection request ───────────────────────────────────────────
    // Add to pendingIncomingRequests so the drawer can render it with
    // Accept / Decline buttons. Also show a toast for immediate visibility.
    socket.on('connect:incoming', (requestData) => {
      const { fromUserId, fromName, fromAvatar, fromBio, fromTags, message, roomId, messageId, sentAt } = requestData;

      setPendingIncomingRequests((prev) => {
        // Deduplicate — don't add the same request twice
        if (prev.some((r) => r.messageId === messageId)) return prev;
        return [
          {
            fromUserId,
            fromName,
            fromAvatar,
            fromBio,
            fromTags,
            message,
            roomId,
            messageId,
            sentAt,
            receivedAt: new Date().toISOString(),
          },
          ...prev,
        ];
      });

      // Increment badge
      setUnreadMessageCount((n) => n + 1);

      toast(
        () => (
          <div className="flex flex-col gap-0.5">
            <span className="font-semibold text-white text-sm">{fromName} wants to connect</span>
            {message && <span className="text-white/60 text-xs line-clamp-1">{message}</span>}
            <span className="text-white/30 text-[10px] mt-0.5">Open inbox to accept or decline</span>
          </div>
        ),
        {
          id:       `req-${messageId}`,
          duration: 8000,
          icon:     '⚡',
          style:    { background: '#0a1628', border: '1px solid #00f5c4', color: '#fff' },
        }
      );
    });

    // ── Our request was accepted ──────────────────────────────────────────────
    socket.on('connect:you_were_accepted', ({ byUserId, byName, roomId }) => {
      // Update nearby users list so the blip colour changes from amber to purple
      setNearbyUsers((prev) =>
        prev.map((u) =>
          u.userId?.toString() === byUserId?.toString()
            ? { ...u, isConnected: true, requestSent: false, roomId }
            : u
        )
      );

      toast(
        () => (
          <div className="flex flex-col gap-0.5">
            <span className="font-semibold text-white text-sm">{byName} accepted your request!</span>
            <span className="text-white/50 text-xs">You can now chat</span>
          </div>
        ),
        {
          id:       `accepted-${byUserId}`,
          duration: 6000,
          icon:     '🎉',
          style:    { background: '#0a1628', border: '1px solid #818cf8', color: '#fff' },
        }
      );
    });

    // ── Our request was declined ──────────────────────────────────────────────
    socket.on('connect:declined', ({ fromUserId }) => {
      setNearbyUsers((prev) =>
        prev.map((u) =>
          u.userId?.toString() === fromUserId?.toString()
            ? { ...u, requestSent: false }
            : u
        )
      );
    });

    // ── Chat notifications (message while not in room) ────────────────────────
    socket.on('chat:notification', ({ fromName, preview }) => {
      setUnreadMessageCount((n) => n + 1);
      toast(`${fromName}: ${preview}`, {
        icon:     '💬',
        duration: 4000,
        style:    { background: '#0a1628', border: '1px solid #1a3a5c', color: '#fff' },
      });
    });

    // ── Generic server errors ─────────────────────────────────────────────────
    socket.on('error', ({ event, message: errMsg }) => {
      console.error(`[socket] Server error on '${event}':`, errMsg);
      toast.error(errMsg || 'Something went wrong', { id: `err-${event}` });
    });

    socket.connect();
    socketRef.current = socket;

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
      setIsConnected(false);
      setIsConnecting(false);
    };
  }, [isAuthenticated, token]);

  // ── Action helpers ─────────────────────────────────────────────────────────

  const startBeacon = useCallback((durationMinutes = 60) => {
    if (!socketRef.current?.connected) { toast.error('Not connected to server'); return; }
    socketRef.current.emit('beacon:start', { durationMinutes });
  }, []);

  const stopBeacon = useCallback(() => {
    socketRef.current?.emit('beacon:stop');
  }, []);

const sendMessage = useCallback((roomId, content, clientId = null) => {
  if (!socketRef.current?.connected) {
    toast.error('Not connected — message not sent');
    return;
  }
  socketRef.current.emit('chat:message', { roomId, content, clientId });
}, []);

  const joinRoom = useCallback((roomId) => {
    socketRef.current?.emit('chat:join', { roomId });
  }, []);

  const sendConnectionRequest = useCallback((toUserId, message = '') => {
    if (!socketRef.current?.connected) { toast.error('Not connected to server'); return; }
    socketRef.current.emit('connect:request', { toUserId, message });
  }, []);

  // acceptConnectionRequest: emits the socket event AND removes the request
  // from pendingIncomingRequests so the inbox badge updates immediately.
  const acceptConnectionRequest = useCallback((fromUserId, messageId) => {
    socketRef.current?.emit('connect:accept', { fromUserId, messageId });
    setPendingIncomingRequests((prev) =>
      prev.filter((r) => r.messageId !== messageId)
    );
    setUnreadMessageCount((n) => Math.max(0, n - 1));
  }, []);

  // declineConnectionRequest: same pattern as accept.
  const declineConnectionRequest = useCallback((fromUserId, messageId) => {
    socketRef.current?.emit('connect:decline', { fromUserId, messageId });
    setPendingIncomingRequests((prev) =>
      prev.filter((r) => r.messageId !== messageId)
    );
    setUnreadMessageCount((n) => Math.max(0, n - 1));
  }, []);

  const sendTypingIndicator = useCallback((roomId, isTyping) => {
    socketRef.current?.emit('chat:typing', { roomId, isTyping });
  }, []);

  const markRoomRead = useCallback((roomId) => {
    socketRef.current?.emit('chat:read', { roomId });
    // Decrement unread count conservatively (server is the source of truth)
    setUnreadMessageCount((n) => Math.max(0, n - 1));
  }, []);

  const emitLocationUpdate = useCallback(({ longitude, latitude, accuracy }) => {
    if (!socketRef.current?.connected || !beaconActive) return;
    socketRef.current.emit('location:update', { longitude, latitude, accuracy });
  }, [beaconActive]);

  // dismissRequest: removes a request from the local list without sending a
  // socket event. Used when a request has already been handled on another device.
  const dismissRequest = useCallback((messageId) => {
    setPendingIncomingRequests((prev) =>
      prev.filter((r) => r.messageId !== messageId)
    );
    setUnreadMessageCount((n) => Math.max(0, n - 1));
  }, []);

  const onEvent = useCallback((event, handler) => {
    const socket = socketRef.current;
    if (!socket) return () => {};
    socket.on(event, handler);
    return () => socket.off(event, handler);
  }, []);

  const value = {
    socket: socketRef.current,
    isConnected,
    isConnecting,
    connectionError,
    nearbyUsers,
    beaconActive,
    beaconExpiresAt,
    // Inbox
    pendingIncomingRequests,
    unreadMessageCount,
    dismissRequest,
    // Actions
    startBeacon,
    stopBeacon,
    sendMessage,
    joinRoom,
    sendConnectionRequest,
    acceptConnectionRequest,
    declineConnectionRequest,
    sendTypingIndicator,
    markRoomRead,
    emitLocationUpdate,
    onEvent,
  };

  return (
    <SocketContext.Provider value={value}>
      {children}
    </SocketContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSocket() {
  const ctx = useContext(SocketContext);
  if (!ctx) throw new Error('useSocket must be used within a SocketProvider');
  return ctx;
}
// import {
//   createContext,
//   useContext,
//   useEffect,
//   useRef,
//   useState,
//   useCallback,
// } from 'react';
// import { io } from 'socket.io-client';
// import toast from 'react-hot-toast';
// import { useAuth } from './AuthContext';

// // ── Constants ─────────────────────────────────────────────────────────────────
// const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:5000';

// // How long to wait between reconnect attempts (ms). Socket.io has its own
// // built-in exponential backoff — these values tune the initial behaviour.
// const RECONNECT_DELAY_MIN = 1_000;
// const RECONNECT_DELAY_MAX = 10_000;

// // ── Context shape ─────────────────────────────────────────────────────────────
// // Document the shape here so consumers know what to expect without
// // having to read the full provider implementation.
// //
// // {
// //   socket:          Socket | null      — the raw socket.io client instance
// //   isConnected:     boolean            — true when socket is in 'connected' state
// //   isConnecting:    boolean            — true during the initial connect / reconnect
// //   connectionError: string | null      — last connection error message
// //   nearbyUsers:     Array              — latest proximity:nearby payload
// //   beaconActive:    boolean            — is this user's beacon currently on?
// //   beaconExpiresAt: Date | null        — when the beacon auto-shuts off
// //   startBeacon:     (minutes) => void  — emit beacon:start
// //   stopBeacon:      () => void         — emit beacon:stop
// //   sendMessage:     (roomId, content) => void
// //   joinRoom:        (roomId) => void
// //   onEvent:         (event, handler) → cleanup fn — safely subscribe to any event
// // }

// const SocketContext = createContext(null);

// export function SocketProvider({ children }) {
//   const { token, isAuthenticated } = useAuth();

//   // ── Socket ref ────────────────────────────────────────────────────────────
//   // We keep the socket in a ref (not state) because:
//   //   a) Changing the socket should NOT trigger a React re-render on its own
//   //   b) Event handlers registered inside useEffect close over the ref,
//   //      not a stale state snapshot
//   const socketRef = useRef(null);

//   // ── Derived UI state ──────────────────────────────────────────────────────
//   const [isConnected,     setIsConnected]     = useState(false);
//   const [isConnecting,    setIsConnecting]     = useState(false);
//   const [connectionError, setConnectionError] = useState(null);

//   // ── Proximity state ───────────────────────────────────────────────────────
//   const [nearbyUsers,    setNearbyUsers]    = useState([]);

//   // ── Beacon state ─────────────────────────────────────────────────────────
//   const [beaconActive,    setBeaconActive]    = useState(false);
//   const [beaconExpiresAt, setBeaconExpiresAt] = useState(null);

//   // ── Connect / disconnect socket when auth state changes ───────────────────
//   useEffect(() => {
//     // If the user is not authenticated, ensure any existing socket is closed
//     // and do not attempt to connect.
//     if (!isAuthenticated || !token) {
//       if (socketRef.current) {
//         console.log('[socket] User logged out — disconnecting socket');
//         socketRef.current.disconnect();
//         socketRef.current = null;
//         setIsConnected(false);
//         setIsConnecting(false);
//       }
//       return;
//     }

//     // If a socket already exists (e.g. token refreshed without logout), reuse it.
//     if (socketRef.current?.connected) return;

//     // ── Initialise socket.io client ─────────────────────────────────────────
//     setIsConnecting(true);
//     setConnectionError(null);

//     const socket = io(SOCKET_URL, {
//       // JWT sent in auth payload — read by the server's auth middleware
//       auth: { token: `Bearer ${token}` },

//       // Connection transport strategy:
//       //   Start with polling (works everywhere, no upgrade needed for initial conn)
//       //   then upgrade to WebSocket for the persistent connection.
//       //   Reversing this ('websocket' first) can fail in environments that block WS.
//       transports: ['polling', 'websocket'],

//       // Reconnection config
//       reconnection: true,
//       reconnectionAttempts: 10,
//       reconnectionDelay:    RECONNECT_DELAY_MIN,
//       reconnectionDelayMax: RECONNECT_DELAY_MAX,
//       randomizationFactor:  0.5,

//       // Timeout for the initial connection handshake
//       timeout: 10_000,

//       // Do not auto-connect — we call socket.connect() manually below
//       // so we can attach listeners before the first event fires.
//       autoConnect: false,
//     });

//     // ── Connection lifecycle events ─────────────────────────────────────────
//     socket.on('connect', () => {
//       console.log(`[socket] Connected — id: ${socket.id}`);
//       setIsConnected(true);
//       setIsConnecting(false);
//       setConnectionError(null);
//     });

//     socket.on('disconnect', (reason) => {
//       console.log(`[socket] Disconnected — reason: ${reason}`);
//       setIsConnected(false);

//       // 'io server disconnect' means the server intentionally closed the socket
//       // (e.g. auth failure detected after connection). Don't auto-reconnect.
//       if (reason === 'io server disconnect') {
//         socket.connect(); // manually reconnect after re-auth
//       }
//       // All other reasons (transport close, timeout) trigger auto-reconnect
//       // via the reconnection config above.
//     });

//     socket.on('connect_error', (err) => {
//       console.error('[socket] Connection error:', err.message);
//       setIsConnecting(false);
//       setConnectionError(err.message);

//       // Parse auth-specific errors and show a user-facing toast
//       if (err.message.startsWith('AUTH_EXPIRED')) {
//         toast.error('Session expired. Please log in again.', { id: 'auth-expired' });
//       } else if (err.message.startsWith('AUTH_')) {
//         toast.error('Authentication failed. Please log in again.', { id: 'auth-error' });
//       } else {
//         // Network error — show a less alarming message
//         toast.error('Lost connection to server. Retrying…', { id: 'conn-error' });
//       }
//     });

//     socket.on('reconnect', (attempt) => {
//       console.log(`[socket] Reconnected after ${attempt} attempt(s)`);
//       toast.success('Reconnected!', { id: 'reconnected', duration: 2000 });
//     });

//     socket.on('reconnect_failed', () => {
//       setIsConnecting(false);
//       setConnectionError('Could not reconnect to server after multiple attempts.');
//       toast.error('Could not reconnect. Please refresh the page.', { id: 'reconnect-failed' });
//     });

//     // ── Application-level events ────────────────────────────────────────────

//     // session:ready — server confirms identity and sends initial state
//     socket.on('session:ready', ({ userId, unreadCount }) => {
//       console.log(`[socket] Session ready — userId: ${userId}, unread: ${unreadCount}`);
//     });

//     // proximity:nearby — full list of nearby users (response to location:update)
//     socket.on('proximity:nearby', ({ users }) => {
//       console.log('[socket] proximity:nearby received — user count:', users?.length, users);
//       setNearbyUsers(users || []);
//     });

//     // proximity:appeared — someone new entered the radius (push notification)
//     socket.on('proximity:appeared', (user) => {
//       // Only show a toast if the user is not already in the nearby list
//       console.log('[socket] proximity:appeared received:', user);
//       setNearbyUsers((prev) => {
//         const alreadyPresent = prev.some((u) => u.userId === user.userId);
//         console.log('[socket] proximity:appeared — already in list:', alreadyPresent);
//         if (!alreadyPresent) {
//           toast(`${user.name} is nearby — ${user.zone}`, {
//             icon: '📡',
//             style: {
//               background: '#0a1628',
//               color: '#fff',
//               border: '1px solid #1a3a5c',
//             },
//           });
//           return [...prev, user];
//         }
//         return prev;
//       });
//     });

//     // beacon:started — server confirmed beacon is live
//     socket.on('beacon:started', ({ isVisible, beaconExpiresAt: expiresAt, durationMinutes }) => {
//       setBeaconActive(isVisible);
//       setBeaconExpiresAt(expiresAt ? new Date(expiresAt) : null);
//       toast.success(`Beacon active for ${durationMinutes} minutes`, { id: 'beacon-started' });
//     });

//     // beacon:stopped — server confirmed beacon is off
//     socket.on('beacon:stopped', () => {
//       setBeaconActive(false);
//       setBeaconExpiresAt(null);
//       setNearbyUsers([]); // clear the list — you're invisible now
//       toast('Beacon stopped. You are now invisible.', {
//         icon: '🔕',
//         id: 'beacon-stopped',
//         style: { background: '#0a1628', color: '#fff', border: '1px solid #1a3a5c' },
//       });
//     });

//     // beacon:expired — server auto-shutoff timer fired
//     socket.on('beacon:expired', () => {
//       setBeaconActive(false);
//       setBeaconExpiresAt(null);
//       setNearbyUsers([]);
//       toast('Your beacon has expired. Enable it again to be visible.', {
//         icon: '⏱',
//         id: 'beacon-expired',
//         duration: 5000,
//         style: { background: '#0a1628', color: '#fff', border: '1px solid #1a3a5c' },
//       });
//     });

//     // connect:incoming — someone sent a connection request
//     socket.on('connect:incoming', ({ fromName, message, roomId, messageId }) => {
//       toast(
//         (t) => (
//           <div className="flex flex-col gap-1">
//             <span className="font-semibold text-white">{fromName} wants to connect</span>
//             <span className="text-white/60 text-sm">{message}</span>
//           </div>
//         ),
//         {
//           id: `req-${messageId}`,
//           duration: 8000,
//           style: { background: '#0a1628', border: '1px solid #1a3a5c', color: '#fff' },
//         }
//       );
//     });

//     // chat:notification — new message while not in the chat room
//     socket.on('chat:notification', ({ fromName, preview }) => {
//       toast(`${fromName}: ${preview}`, {
//         icon: '💬',
//         duration: 4000,
//         style: { background: '#0a1628', border: '1px solid #1a3a5c', color: '#fff' },
//       });
//     });

//     // Generic server-emitted errors — log and toast
//     socket.on('error', ({ event, message: errMsg }) => {
//       console.error(`[socket] Server error on event '${event}':`, errMsg);
//       toast.error(errMsg || 'Something went wrong', { id: `err-${event}` });
//     });

//     // ── Kick off the connection ─────────────────────────────────────────────
//     socket.connect();
//     socketRef.current = socket;

//     // ── Cleanup on unmount or when token changes ────────────────────────────
//     return () => {
//       console.log('[socket] Cleaning up socket connection');
//       socket.removeAllListeners();
//       socket.disconnect();
//       socketRef.current = null;
//       setIsConnected(false);
//       setIsConnecting(false);
//     };
//   }, [isAuthenticated, token]);

//   // ── Action helpers ────────────────────────────────────────────────────────
//   // Wrap raw socket.emit() calls in stable functions (useCallback with empty
//   // deps) so child components can safely put them in their own dep arrays.

//   const startBeacon = useCallback((durationMinutes = 60) => {
//     if (!socketRef.current?.connected) {
//       toast.error('Not connected to server');
//       return;
//     }
//     socketRef.current.emit('beacon:start', { durationMinutes });
//   }, []);

//   const stopBeacon = useCallback(() => {
//     socketRef.current?.emit('beacon:stop');
//   }, []);

//   const sendMessage = useCallback((roomId, content) => {
//     if (!socketRef.current?.connected) {
//       toast.error('Not connected — message not sent');
//       return;
//     }
//     socketRef.current.emit('chat:message', { roomId, content });
//   }, []);

//   const joinRoom = useCallback((roomId) => {
//     socketRef.current?.emit('chat:join', { roomId });
//   }, []);

//   const sendConnectionRequest = useCallback((toUserId, message = '') => {
//     if (!socketRef.current?.connected) {
//       toast.error('Not connected to server');
//       return;
//     }
//     socketRef.current.emit('connect:request', { toUserId, message });
//   }, []);

//   const acceptConnectionRequest = useCallback((fromUserId, messageId) => {
//     socketRef.current?.emit('connect:accept', { fromUserId, messageId });
//   }, []);

//   const declineConnectionRequest = useCallback((fromUserId, messageId) => {
//     socketRef.current?.emit('connect:decline', { fromUserId, messageId });
//   }, []);

//   const sendTypingIndicator = useCallback((roomId, isTyping) => {
//     socketRef.current?.emit('chat:typing', { roomId, isTyping });
//   }, []);

//   const markRoomRead = useCallback((roomId) => {
//     socketRef.current?.emit('chat:read', { roomId });
//   }, []);

//   // ── Generic event subscription helper ────────────────────────────────────
//   // Components use this to subscribe to socket events directly without
//   // importing the socket ref. Returns a cleanup function for use in useEffect.
//   //
//   // Usage:
//   //   useEffect(() => {
//   //     return onEvent('chat:message', (msg) => setMessages(prev => [...prev, msg]));
//   //   }, [onEvent]);
//   const onEvent = useCallback((event, handler) => {
//     const socket = socketRef.current;
//     if (!socket) return () => {};

//     socket.on(event, handler);
//     return () => socket.off(event, handler); // cleanup function
//   }, []);

//   // ── Location emit helper ──────────────────────────────────────────────────
//   // Called by useGeolocation hook on each position update.
//   const emitLocationUpdate = useCallback(({ longitude, latitude, accuracy }) => {
//     if (!socketRef.current?.connected || !beaconActive) return;
//     socketRef.current.emit('location:update', { longitude, latitude, accuracy });
//   }, [beaconActive]);

//   // ── Context value ─────────────────────────────────────────────────────────
//   const value = {
//     // Raw socket — available for advanced use cases but prefer the helpers below
//     socket: socketRef.current,

//     // Connection state
//     isConnected,
//     isConnecting,
//     connectionError,

//     // Proximity
//     nearbyUsers,

//     // Beacon
//     beaconActive,
//     beaconExpiresAt,

//     // Actions
//     startBeacon,
//     stopBeacon,
//     sendMessage,
//     joinRoom,
//     sendConnectionRequest,
//     acceptConnectionRequest,
//     declineConnectionRequest,
//     sendTypingIndicator,
//     markRoomRead,
//     emitLocationUpdate,

//     // Generic event listener helper
//     onEvent,
//   };

//   return (
//     <SocketContext.Provider value={value}>
//       {children}
//     </SocketContext.Provider>
//   );
// }

// // eslint-disable-next-line react-refresh/only-export-components
// export function useSocket() {
//   const ctx = useContext(SocketContext);
//   if (!ctx) throw new Error('useSocket must be used within a SocketProvider');
//   return ctx;
// }