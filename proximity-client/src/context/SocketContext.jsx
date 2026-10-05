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

  const [isConnected,     setIsConnected]     = useState(false);
  const [isConnecting,    setIsConnecting]    = useState(false);
  const [connectionError, setConnectionError] = useState(null);

  const [nearbyUsers, setNearbyUsers] = useState([]);

  const [beaconActive,    setBeaconActive]    = useState(false);
  const [beaconExpiresAt, setBeaconExpiresAt] = useState(null);

  const [pendingIncomingRequests, setPendingIncomingRequests] = useState([]);

  // unreadMessageCount: total unread messages across all rooms.
  // Seeded from session:ready on connect, decremented when rooms are read.
  const [unreadMessageCount, setUnreadMessageCount] = useState(0);

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

    socket.on('connect', () => {
      setIsConnected(true);
      setIsConnecting(false);
      setConnectionError(null);
    });

    socket.on('disconnect', (reason) => {
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

    socket.on('reconnect', () => {
      toast.success('Reconnected!', { id: 'reconnected', duration: 2000 });
    });

    socket.on('reconnect_failed', () => {
      setIsConnecting(false);
      setConnectionError('Could not reconnect after multiple attempts.');
      toast.error('Could not reconnect. Please refresh the page.', { id: 'reconnect-failed' });
    });

    socket.on('session:ready', ({ unreadCount }) => {
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

    socket.on('connect:declined', ({ fromUserId }) => {
      setNearbyUsers((prev) =>
        prev.map((u) =>
          u.userId?.toString() === fromUserId?.toString()
            ? { ...u, requestSent: false }
            : u
        )
      );
    });

    socket.on('chat:notification', ({ fromName, preview }) => {
      setUnreadMessageCount((n) => n + 1);
      toast(`${fromName}: ${preview}`, {
        icon:     '💬',
        duration: 4000,
        style:    { background: '#0a1628', border: '1px solid #1a3a5c', color: '#fff' },
      });
    });

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

//     // ── Application-level events ────────────────────────────────────────────

//     // Proximity
//     nearbyUsers,

