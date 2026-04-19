import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate }    from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Radio,
  MapPin,
  Users,
  MessageCircle,
  Wifi,
  WifiOff,
  ChevronDown,
  ChevronUp,
  Clock,
  Zap,
  AlertTriangle,
  Navigation,
  LogOut,
  Inbox,
} from 'lucide-react';

import { useSocket }      from '../context/SocketContext';
import { useAuth }        from '../context/AuthContext';
import { useGeolocation } from '../hooks/useGeolocation';
import InboxDrawer        from '../components/InboxDrawer';
import { Link } from 'react-router-dom';

// ── Constants ─────────────────────────────────────────────────────────────────
const BEACON_DURATIONS = [
  { label: '15 min',  value: 15  },
  { label: '30 min',  value: 30  },
  { label: '1 hour',  value: 60  },
  { label: '2 hours', value: 120 },
  { label: '4 hours', value: 240 },
];
const BLIP_STALE_THRESHOLD_MS = 90_000;

function blipColour(user) {
  if (user.isConnected) return '#818cf8';
  if (user.requestSent) return '#f59e0b';
  return '#00f5c4';
}

function formatTimeRemaining(expiresAt) {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt) - Date.now();
  if (ms <= 0) return 'Expired';
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatDistance(metres) {
  if (!metres && metres !== 0) return '—';
  if (metres < 10)   return 'Right here';
  if (metres < 1000) return `~${Math.round(metres / 10) * 10}m`;
  return `${(metres / 1000).toFixed(1)}km`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

function RadarCanvas({ nearbyUsers, beaconActive, size = 280 }) {
  const center = size / 2;

  function blipPosition(userId, index, total) {
    const hash  = userId.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
    const angle = ((index / Math.max(total, 1)) * 360 + (hash % 40) - 20) * (Math.PI / 180);
    const r     = center * (0.30 + ((hash % 40) / 100));
    return { x: center + r * Math.cos(angle), y: center + r * Math.sin(angle) };
  }

  return (
    <div
      className="relative flex-shrink-0"
      style={{ width: size, height: size }}
      role="img"
      aria-label={`Radar showing ${nearbyUsers.length} nearby user${nearbyUsers.length !== 1 ? 's' : ''}`}
    >
      <svg width={size} height={size} className="absolute inset-0" aria-hidden="true">
        {[0.25, 0.5, 0.75, 1].map((ratio) => (
          <circle key={ratio} cx={center} cy={center} r={center * ratio - 1}
            fill="none" stroke="rgba(30,77,123,0.5)"
            strokeWidth={ratio === 1 ? 1.5 : 0.75}
            strokeDasharray={ratio < 1 ? '4 6' : 'none'} />
        ))}
        <line x1={center} y1={4}      x2={center} y2={size - 4} stroke="rgba(30,77,123,0.3)" strokeWidth={0.5} />
        <line x1={4}      y1={center} x2={size - 4} y2={center} stroke="rgba(30,77,123,0.3)" strokeWidth={0.5} />
        {[{ ratio: 0.33, label: '66m' }, { ratio: 0.66, label: '133m' }, { ratio: 0.99, label: '200m' }]
          .map(({ ratio, label }) => (
            <text key={label} x={center + center * ratio - 4} y={center - 5}
              fill="rgba(255,255,255,0.18)" fontSize={8} textAnchor="end"
              fontFamily="JetBrains Mono, monospace">{label}</text>
          ))}
      </svg>

      <div className="absolute inset-0 rounded-full animate-sweep" style={{ transformOrigin: 'center center' }} aria-hidden="true">
        <div className="w-full h-full rounded-full radar-sweep-gradient" />
      </div>
      <div className="absolute inset-0 animate-sweep" style={{ transformOrigin: 'center center' }} aria-hidden="true">
        <div className="absolute" style={{ left: center - 1, top: 4, width: 1.5, height: center - 4,
          transformOrigin: 'bottom center', background: 'linear-gradient(to top, rgba(0,245,196,0.9), transparent)', borderRadius: 1 }} />
      </div>

      <div className="absolute" style={{ left: center - 6, top: center - 6 }} aria-hidden="true">
        <div className="relative w-3 h-3">
          {beaconActive && <span className="absolute inset-0 rounded-full bg-beacon animate-ping-slow opacity-70" />}
          <span className="relative block w-3 h-3 rounded-full"
            style={{ background: beaconActive ? '#00f5c4' : 'rgba(255,255,255,0.4)',
              boxShadow: beaconActive ? '0 0 8px rgba(0,245,196,0.8)' : 'none' }} />
        </div>
      </div>

      {nearbyUsers.map((user, index) => {
        const pos    = blipPosition(user.userId, index, nearbyUsers.length);
        const colour = blipColour(user);
        const isOnline = user.isOnline !== false;
        return (
          <motion.div key={user.userId} initial={{ opacity: 0, scale: 0 }}
            animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 20 }}
            className="absolute" style={{ left: pos.x - 5, top: pos.y - 5 }}
            aria-label={`${user.name} is nearby`}>
            <span className="absolute inset-0 rounded-full animate-ping-slow"
              style={{ opacity: 0.5, backgroundColor: colour, animationDelay: `${(index * 0.3) % 1.5}s` }} />
            <span className="relative block w-2.5 h-2.5 rounded-full cursor-pointer"
              style={{ backgroundColor: colour, boxShadow: `0 0 6px ${colour}`, opacity: isOnline ? 1 : 0.45 }} />
          </motion.div>
        );
      })}
    </div>
  );
}

function StatusBar({ isConnected, isConnecting, lastUpdatedAt }) {
  return (
    <div className="flex items-center justify-between px-4 py-2 bg-radar-elevated border-b border-radar-border text-xs font-mono">
      <div className="flex items-center gap-2">
        {isConnecting
          ? <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
          : isConnected
            ? <span className="w-2 h-2 rounded-full bg-beacon glow-beacon" />
            : <span className="w-2 h-2 rounded-full bg-red-500" />}
        <span className="text-white/40">
          {isConnecting ? 'Connecting…' : isConnected ? 'Live' : 'Disconnected'}
        </span>
      </div>
      {lastUpdatedAt && (
        <div className="flex items-center gap-1 text-white/30">
          <Clock size={10} />
          <span>{new Date(lastUpdatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
        </div>
      )}
    </div>
  );
}

function BeaconProgressBar({ expiresAt }) {
  const [pct, setPct] = useState(100);
  const startRef = useRef(null);

  useEffect(() => {
    if (!startRef.current) startRef.current = Date.now();
    const totalMs = new Date(expiresAt) - startRef.current;
    const tick = () => setPct(Math.max(0, ((new Date(expiresAt) - Date.now()) / totalMs) * 100));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  return (
    <div className="h-1 rounded-full bg-radar-elevated overflow-hidden">
      <motion.div className="h-full rounded-full bg-beacon" style={{ width: `${pct}%` }}
        transition={{ duration: 1, ease: 'linear' }} />
    </div>
  );
}

function BeaconPanel({ beaconActive, beaconExpiresAt, onStart, onStop }) {
  const [showDurationPicker, setShowDurationPicker] = useState(false);
  const [selectedDuration,   setSelectedDuration]   = useState(60);
  const [timeRemaining,      setTimeRemaining]       = useState(null);

  useEffect(() => {
    if (!beaconActive || !beaconExpiresAt) { setTimeRemaining(null); return; }
    const tick = () => setTimeRemaining(formatTimeRemaining(beaconExpiresAt));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [beaconActive, beaconExpiresAt]);

  const handleStart = () => { onStart(selectedDuration); setShowDurationPicker(false); };

  return (
    <div className="card p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors duration-300
            ${beaconActive ? 'bg-beacon/15 text-beacon' : 'bg-radar-elevated text-white/30'}`}>
            <Radio size={16} />
          </div>
          <div>
            <p className="text-sm font-semibold text-white">{beaconActive ? 'Broadcasting' : 'Beacon Off'}</p>
            <p className="text-xs text-white/40">
              {beaconActive ? `Visible to others · ${timeRemaining ?? '…'} left` : 'Start beacon to appear on others\' radar'}
            </p>
          </div>
        </div>
        <button type="button"
          onClick={beaconActive ? onStop : () => setShowDurationPicker((p) => !p)}
          className={`relative w-14 h-7 rounded-full transition-all duration-300 flex-shrink-0
            focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-radar-surface
            ${beaconActive ? 'bg-beacon focus:ring-beacon' : 'bg-radar-elevated border border-radar-border focus:ring-radar-ring'}`}
          aria-label={beaconActive ? 'Stop beacon' : 'Start beacon'} aria-pressed={beaconActive}>
          <motion.span layout transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            className={`absolute top-1 w-5 h-5 rounded-full shadow ${beaconActive ? 'bg-radar-bg right-1' : 'bg-white/30 left-1'}`} />
          {beaconActive && <span className="absolute inset-0 rounded-full animate-ping-slow bg-beacon/30" />}
        </button>
      </div>

      <AnimatePresence>
        {showDurationPicker && !beaconActive && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <div className="pt-1 flex flex-col gap-3">
              <p className="text-xs text-white/40 font-medium uppercase tracking-wider">Broadcast for how long?</p>
              <div className="grid grid-cols-5 gap-1.5">
                {BEACON_DURATIONS.map(({ label, value }) => (
                  <button key={value} type="button" onClick={() => setSelectedDuration(value)}
                    className={`py-2 rounded-lg text-xs font-medium transition-all duration-150
                      ${selectedDuration === value
                        ? 'bg-beacon text-radar-bg shadow-beacon'
                        : 'bg-radar-elevated text-white/50 hover:text-white border border-radar-border'}`}>
                    {label}
                  </button>
                ))}
              </div>
              <button type="button" onClick={handleStart}
                className="btn-primary h-10 flex items-center justify-center gap-2">
                <Zap size={14} /> Start broadcasting
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {beaconActive && beaconExpiresAt && <BeaconProgressBar expiresAt={beaconExpiresAt} />}
    </div>
  );
}

function PermissionGate({ permissionState, error, onRequest }) {
  if (permissionState === 'granted') return null;
  const isDenied      = permissionState === 'denied';
  const isUnsupported = permissionState === 'unsupported';
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      className={`card p-4 flex items-start gap-3 ${isDenied ? 'border-red-500/30' : 'border-amber-500/30'}`}>
      <AlertTriangle size={18} className={`flex-shrink-0 mt-0.5 ${isDenied ? 'text-red-400' : 'text-amber-400'}`} />
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-medium ${isDenied ? 'text-red-300' : 'text-amber-300'}`}>
          {isUnsupported ? 'Geolocation not supported' : isDenied ? 'Location access denied' : 'Location access needed'}
        </p>
        <p className="text-xs text-white/40 mt-0.5">
          {isUnsupported ? 'Your browser does not support GPS.'
            : isDenied ? 'Enable location in your browser settings, then refresh.'
            : 'Allow location access to use the radar.'}
        </p>
        {!isDenied && !isUnsupported && (
          <button type="button" onClick={onRequest}
            className="mt-2.5 btn-primary text-xs py-1.5 px-3 h-auto inline-flex items-center gap-1.5">
            <Navigation size={12} /> Allow location access
          </button>
        )}
      </div>
    </motion.div>
  );
}

function BlipCard({ user, onConnect, onChat, index }) {
  const colour = blipColour(user);
  return (
    <motion.div layout initial={{ opacity: 0, y: 12, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }}
      transition={{ delay: index * 0.04, type: 'spring', stiffness: 280, damping: 24 }}
      className="card p-4 flex items-center gap-3 hover:border-radar-ring transition-colors duration-200">
      <div className="relative flex-shrink-0">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center text-sm font-semibold"
          style={{ background: `${colour}18`, border: `1px solid ${colour}40`, color: colour }}>
          {user.avatar
            ? <img src={user.avatar} alt={user.name} className="w-full h-full rounded-xl object-cover" />
            : user.name?.[0]?.toUpperCase() ?? '?'}
        </div>
        <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-radar-surface"
          style={{ background: user.isOnline !== false ? colour : '#444' }} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold text-white truncate">{user.name}</p>
          {user.isConnected && (
            <span className="badge bg-indigo-500/15 text-indigo-300 border border-indigo-500/25 text-[10px]">Connected</span>
          )}
          {user.requestSent && !user.isConnected && (
            <span className="badge bg-amber-500/15 text-amber-300 border border-amber-500/25 text-[10px]">Pending</span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-white/40 flex items-center gap-1"><MapPin size={9} />{user.zone ?? '—'}</span>
          <span className="text-white/20 text-xs">·</span>
          <span className="text-xs font-mono" style={{ color: `${colour}cc` }}>{formatDistance(user.distanceMeters)}</span>
        </div>
        {user.tags?.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {user.tags.slice(0, 4).map((tag) => (
              <span key={tag} className="badge bg-radar-elevated text-white/40 border border-radar-border text-[10px]">{tag}</span>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1.5 flex-shrink-0">
        {user.isConnected ? (
          <button type="button" onClick={() => onChat(user)}
            className="w-8 h-8 rounded-lg bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20 transition-colors flex items-center justify-center"
            aria-label={`Chat with ${user.name}`}><MessageCircle size={15} /></button>
        ) : user.requestSent ? (
          <button type="button" disabled
            className="w-8 h-8 rounded-lg bg-amber-500/10 text-amber-400/50 flex items-center justify-center cursor-not-allowed"
            aria-label="Request pending"><Clock size={15} /></button>
        ) : (
          <button type="button" onClick={() => onConnect(user)}
            className="w-8 h-8 rounded-lg bg-beacon/10 text-beacon hover:bg-beacon/20 transition-colors flex items-center justify-center"
            aria-label={`Connect with ${user.name}`}><Zap size={15} /></button>
        )}
      </div>
    </motion.div>
  );
}

function ConnectModal({ target, onSend, onClose }) {
  const [message, setMessage] = useState('');
  const maxLen = 200;
  const handleSend = () => { onSend(target.userId, message.trim()); onClose(); };
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
      style={{ background: 'rgba(5,13,26,0.85)' }} onClick={onClose}>
      <motion.div initial={{ y: 40, scale: 0.97 }} animate={{ y: 0, scale: 1 }}
        exit={{ y: 40, scale: 0.97, opacity: 0 }} transition={{ type: 'spring', stiffness: 300, damping: 28 }}
        className="card-elevated w-full max-w-sm p-6 flex flex-col gap-5" onClick={(e) => e.stopPropagation()}>
        <div>
          <h2 className="text-base font-semibold text-white">Connect with {target.name}</h2>
          <p className="text-sm text-white/40 mt-0.5">
            {target.zone} · {formatDistance(target.distanceMeters)} away
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="connect-msg" className="text-sm font-medium text-white/70">
            Say hello <span className="text-white/30 font-normal">(optional)</span>
          </label>
          <textarea id="connect-msg" rows={3} maxLength={maxLen} value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={`Hi ${target.name?.split(' ')[0]}, I spotted you on the radar!`}
            className="input resize-none leading-relaxed py-3 text-sm" autoFocus />
          <p className="text-xs text-white/25 text-right">{message.length}/{maxLen}</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={onClose} className="btn-ghost flex-1 h-10">Cancel</button>
          <button type="button" onClick={handleSend}
            className="btn-primary flex-1 h-10 flex items-center justify-center gap-1.5">
            <Zap size={14} /> Send request
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── NavBar — now includes Inbox button with badge ─────────────────────────────
function NavBar({ user, isConnected, totalBadge, onInboxOpen, onLogout }) {
  return (
    <header className="flex items-center justify-between px-4 py-3 bg-radar-surface border-b border-radar-border">
      <div className="flex items-center gap-2.5">
        <div className="relative w-7 h-7">
          <div className="absolute inset-0 rounded-full border border-beacon/20 animate-ping-slow" />
          <div className="absolute inset-1 rounded-full border border-beacon/40" />
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-1.5 h-1.5 rounded-full bg-beacon" style={{ boxShadow: '0 0 4px rgba(0,245,196,0.8)' }} />
          </div>
        </div>
        <span className="font-semibold text-white tracking-tight">proximity</span>
      </div>

      <div className="flex items-center gap-2">
        {/* Connection pill */}
        <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium
          ${isConnected
            ? 'bg-beacon/10 text-beacon border border-beacon/20'
            : 'bg-red-500/10 text-red-400 border border-red-500/20'}`}>
          {isConnected ? <Wifi size={11} /> : <WifiOff size={11} />}
          {isConnected ? 'Live' : 'Offline'}
        </div>

        {/* ── Inbox button with badge ─────────────────────────────────── */}
        <button type="button" onClick={onInboxOpen}
          className="relative w-8 h-8 rounded-lg text-white/50 hover:text-white hover:bg-radar-elevated transition-colors flex items-center justify-center"
          aria-label={`Open inbox${totalBadge > 0 ? ` (${totalBadge} unread)` : ''}`}>
          <Inbox size={16} />
          <AnimatePresence>
            {totalBadge > 0 && (
              <motion.span
                key="badge"
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                exit={{ scale: 0 }}
                className="absolute -top-1 -right-1 min-w-[16px] h-4 rounded-full bg-beacon text-radar-bg text-[9px] font-bold flex items-center justify-center px-1"
              >
                {totalBadge > 9 ? '9+' : totalBadge}
              </motion.span>
            )}
          </AnimatePresence>
        </button>

        {/* Avatar + logout */}
        <Link
          to="/profile"
          className="w-7 h-7 rounded-lg bg-radar-elevated border border-radar-border flex items-center justify-center text-xs font-semibold text-white/70 hover:border-beacon hover:text-beacon transition-colors"
          aria-label="View profile"
        >
          {user?.name?.[0]?.toUpperCase() ?? '?'}
        </Link>
        {/* <div className="flex items-center gap-1">
          <div className="w-7 h-7 rounded-lg bg-radar-elevated border border-radar-border flex items-center justify-center text-xs font-semibold text-white/70">
            {user?.name?.[0]?.toUpperCase() ?? '?'}
          </div>
          <button type="button" onClick={onLogout}
            className="w-7 h-7 rounded-lg text-white/30 hover:text-white/70 hover:bg-radar-elevated transition-colors flex items-center justify-center"
            aria-label="Log out"><LogOut size={14} /></button>
        </div> */}
      </div>
    </header>
  );
}

function EmptyRadar({ beaconActive, permissionGranted }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 gap-3 text-center">
      <div className="w-12 h-12 rounded-2xl bg-radar-elevated border border-radar-border flex items-center justify-center">
        <Users size={20} className="text-white/20" />
      </div>
      <div>
        <p className="text-sm font-medium text-white/40">No one on radar yet</p>
        <p className="text-xs text-white/25 mt-0.5 max-w-[200px]">
          {!permissionGranted ? 'Allow location access to scan your area'
            : !beaconActive ? 'Start your beacon so others can find you too'
            : 'Scanning 200m radius…'}
        </p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN PAGE
// ─────────────────────────────────────────────────────────────────────────────
export default function RadarPage() {
  const navigate = useNavigate();
  const { user, logout } = useAuth();
  const {
    isConnected,
    isConnecting,
    beaconActive,
    beaconExpiresAt,
    nearbyUsers: socketNearbyUsers,
    pendingIncomingRequests,
    unreadMessageCount,
    startBeacon,
    stopBeacon,
    sendConnectionRequest,
    onEvent,
  } = useSocket();

  const {
    position,
    permissionState,
    error:            geoError,
    lastUpdatedAt,
    requestPermission,
  } = useGeolocation();

  // ── State ──────────────────────────────────────────────────────────────────
  const [nearbyUsers,    setNearbyUsers]    = useState([]);
  const [connectTarget,  setConnectTarget]  = useState(null);
  const [listExpanded,   setListExpanded]   = useState(true);
  const [pendingUserIds, setPendingUserIds] = useState(new Set());
  const [inboxOpen,      setInboxOpen]      = useState(false);

  const pruneIntervalRef = useRef(null);

  // ── Sync socket nearby list ────────────────────────────────────────────────
  useEffect(() => {
    if (!socketNearbyUsers?.length) return;
    setNearbyUsers((prev) => {
      const prevMap = new Map(prev.map((u) => [u.userId, u]));
      return socketNearbyUsers.map((incoming) => {
        const existing = prevMap.get(incoming.userId) ?? {};
        return { ...existing, ...incoming,
          requestSent: pendingUserIds.has(incoming.userId) || existing.requestSent,
          lastSeenAt: Date.now() };
      });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socketNearbyUsers]);

  useEffect(() => {
    const cleanup = onEvent('proximity:appeared', (incomingUser) => {
      setNearbyUsers((prev) => {
        const existing = prev.find((u) => u.userId === incomingUser.userId);
        if (existing) return prev.map((u) =>
          u.userId === incomingUser.userId ? { ...u, ...incomingUser, lastSeenAt: Date.now() } : u);
        return [...prev, { ...incomingUser, requestSent: pendingUserIds.has(incomingUser.userId), lastSeenAt: Date.now() }];
      });
    });
    return cleanup;
  }, [onEvent, pendingUserIds]);

  useEffect(() => {
    const cleanup = onEvent('connect:request_sent', ({ toUserId }) => {
      setPendingUserIds((prev) => new Set([...prev, toUserId]));
      setNearbyUsers((prev) => prev.map((u) => u.userId === toUserId ? { ...u, requestSent: true } : u));
    });
    return cleanup;
  }, [onEvent]);

  useEffect(() => {
    const cleanup = onEvent('connect:you_were_accepted', ({ byUserId, roomId }) => {
      setNearbyUsers((prev) => prev.map((u) =>
        u.userId === byUserId ? { ...u, isConnected: true, requestSent: false, roomId } : u));
    });
    return cleanup;
  }, [onEvent]);

  useEffect(() => {
    pruneIntervalRef.current = setInterval(() => {
      const now = Date.now();
      setNearbyUsers((prev) => prev.filter((u) => !u.lastSeenAt || now - u.lastSeenAt < BLIP_STALE_THRESHOLD_MS));
    }, 15_000);
    return () => clearInterval(pruneIntervalRef.current);
  }, []);

  // ── Badge total: requests + unread messages ────────────────────────────────
  const totalBadge = pendingIncomingRequests.length + unreadMessageCount;

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleConnectRequest = useCallback((target) => { setConnectTarget(target); }, []);
  const handleSendRequest    = useCallback((toUserId, message) => { sendConnectionRequest(toUserId, message); }, [sendConnectionRequest]);
  const handleChatNav        = useCallback((u) => { if (u.roomId) navigate(`/chat/${u.roomId}`); }, [navigate]);
  const handleLogout         = useCallback(async () => { stopBeacon(); await logout(); navigate('/login', { replace: true }); }, [logout, navigate, stopBeacon]);

  const permissionGranted = permissionState === 'granted';
  const onlineCount       = nearbyUsers.filter((u) => u.isOnline !== false).length;

  return (
    <div className="min-h-screen bg-radar-bg flex flex-col">
      <NavBar
        user={user}
        isConnected={isConnected}
        totalBadge={totalBadge}
        onInboxOpen={() => setInboxOpen(true)}
        onLogout={handleLogout}
      />
      <StatusBar isConnected={isConnected} isConnecting={isConnecting} lastUpdatedAt={lastUpdatedAt} />

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-md mx-auto px-4 py-6 flex flex-col gap-5">
          {/* Radar canvas */}
          <div className="flex flex-col items-center gap-3">
            <div className="relative">
              <RadarCanvas nearbyUsers={nearbyUsers} beaconActive={beaconActive} size={280} />
              <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 text-[10px] font-mono text-white/20 whitespace-nowrap">
                200m radius
              </div>
            </div>
            <motion.div key={onlineCount} initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium
                ${onlineCount > 0 ? 'bg-beacon/10 text-beacon border border-beacon/20' : 'bg-radar-elevated text-white/30 border border-radar-border'}`}>
              {onlineCount > 0
                ? <><span className="w-1.5 h-1.5 rounded-full bg-beacon animate-pulse" />{onlineCount} {onlineCount === 1 ? 'person' : 'people'} nearby</>
                : <><span className="w-1.5 h-1.5 rounded-full bg-white/20" />Scanning…</>}
            </motion.div>
          </div>

          {/* Permission gate */}
          <AnimatePresence>
            {!permissionGranted && (
              <PermissionGate permissionState={permissionState} error={geoError} onRequest={requestPermission} />
            )}
          </AnimatePresence>

          {/* GPS error */}
          <AnimatePresence>
            {geoError && permissionGranted && (
              <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                className="flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-xl px-3 py-2.5">
                <AlertTriangle size={13} className="flex-shrink-0" />{geoError}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Beacon control */}
          <BeaconPanel beaconActive={beaconActive} beaconExpiresAt={beaconExpiresAt} onStart={startBeacon} onStop={stopBeacon} />

          {/* Nearby list */}
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Users size={14} className="text-white/40" />
                <span className="text-sm font-semibold text-white/70">Nearby</span>
                {nearbyUsers.length > 0 && (
                  <span className="badge bg-radar-elevated text-white/40 border border-radar-border">{nearbyUsers.length}</span>
                )}
              </div>
              {nearbyUsers.length > 0 && (
                <button type="button" onClick={() => setListExpanded((p) => !p)}
                  className="text-white/30 hover:text-white/60 transition-colors flex items-center gap-1 text-xs">
                  {listExpanded ? <><ChevronUp size={14} />Collapse</> : <><ChevronDown size={14} />Show {nearbyUsers.length}</>}
                </button>
              )}
            </div>

            <AnimatePresence mode="popLayout">
              {listExpanded && nearbyUsers.length > 0
                ? nearbyUsers.map((u, i) => (
                    <BlipCard key={u.userId} user={u} index={i} onConnect={handleConnectRequest} onChat={handleChatNav} />
                  ))
                : !listExpanded ? null : (
                    <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                      <EmptyRadar beaconActive={beaconActive} permissionGranted={permissionGranted} />
                    </motion.div>
                  )}
            </AnimatePresence>
          </div>

          <div className="h-6" />
        </div>
      </main>

      {/* Connect modal */}
      <AnimatePresence>
        {connectTarget && (
          <ConnectModal target={connectTarget} onSend={handleSendRequest} onClose={() => setConnectTarget(null)} />
        )}
      </AnimatePresence>

      {/* ── Inbox drawer ──────────────────────────────────────────────────── */}
      <InboxDrawer isOpen={inboxOpen} onClose={() => setInboxOpen(false)} />
    </div>
  );
}
// import { useState, useEffect, useCallback, useRef } from 'react';
// import { useNavigate } from 'react-router-dom';
// import { motion, AnimatePresence } from 'framer-motion';
// import {
//   Radio,
//   RadarIcon,
//   MapPin,
//   Users,
//   MessageCircle,
//   User,
//   Wifi,
//   WifiOff,
//   ChevronDown,
//   ChevronUp,
//   Clock,
//   Zap,
//   AlertTriangle,
//   Navigation,
//   LogOut,
// } from 'lucide-react';

// import { useSocket }      from '../context/SocketContext';
// import { useAuth }        from '../context/AuthContext';
// import { useGeolocation } from '../hooks/useGeolocation';

// // ── Constants ─────────────────────────────────────────────────────────────────

// // Beacon duration options shown in the picker
// const BEACON_DURATIONS = [
//   { label: '15 min',  value: 15  },
//   { label: '30 min',  value: 30  },
//   { label: '1 hour',  value: 60  },
//   { label: '2 hours', value: 120 },
//   { label: '4 hours', value: 240 },
// ];

// // How long a blip stays in the nearby list after its last update (ms)
// const BLIP_STALE_THRESHOLD_MS = 90_000; // 90 seconds — matches backend TTL

// // Colour assigned to a blip based on connection state
// function blipColour(user) {
//   if (user.isConnected)         return 'blip-connected'; // purple  — already connected
//   if (user.requestSent)         return 'blip-pending';   // amber   — request pending
//   return 'blip-online';                                  // teal    — stranger
// }

// // ── Helper: format time remaining on the beacon ────────────────────────────────
// function formatTimeRemaining(expiresAt) {
//   if (!expiresAt) return null;
//   const ms = new Date(expiresAt) - Date.now();
//   if (ms <= 0) return 'Expired';
//   const totalSeconds = Math.floor(ms / 1000);
//   const h = Math.floor(totalSeconds / 3600);
//   const m = Math.floor((totalSeconds % 3600) / 60);
//   const s = totalSeconds % 60;
//   if (h > 0) return `${h}h ${m}m`;
//   if (m > 0) return `${m}m ${s}s`;
//   return `${s}s`;
// }

// // ── Helper: distance label ─────────────────────────────────────────────────────
// function formatDistance(metres) {
//   if (!metres && metres !== 0) return '—';
//   if (metres < 10)   return 'Right here';
//   if (metres < 1000) return `~${Math.round(metres / 10) * 10}m`;
//   return `${(metres / 1000).toFixed(1)}km`;
// }

// // ─────────────────────────────────────────────────────────────────────────────
// // SUB-COMPONENTS
// // ─────────────────────────────────────────────────────────────────────────────

// // ── Radar canvas ───────────────────────────────────────────────────────────────
// // Pure CSS/SVG radar with a rotating sweep arm and concentric rings.
// // Blips are positioned deterministically from their userId hash so they don't
// // jump around on every re-render.
// function RadarCanvas({ nearbyUsers, beaconActive, size = 280 }) {
//   const center = size / 2;

//   // Deterministic angle and radius from a string — keeps blips stable
//   function blipPosition(userId, index, total) {
//     // Spread blips evenly around the radar with slight jitter per userId
//     const hash  = userId.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
//     const angle = ((index / Math.max(total, 1)) * 360 + (hash % 40) - 20) * (Math.PI / 180);
//     // Keep blips in the outer 30-70% of the radius so they don't cluster at centre
//     const r     = center * (0.30 + ((hash % 40) / 100));
//     return {
//       x: center + r * Math.cos(angle),
//       y: center + r * Math.sin(angle),
//     };
//   }

//   return (
//     <div
//       className="relative flex-shrink-0"
//       style={{ width: size, height: size }}
//       role="img"
//       aria-label={`Radar showing ${nearbyUsers.length} nearby user${nearbyUsers.length !== 1 ? 's' : ''}`}
//     >
//       {/* ── Static SVG rings ────────────────────────────────────────────── */}
//       <svg
//         width={size}
//         height={size}
//         className="absolute inset-0"
//         aria-hidden="true"
//       >
//         {/* Concentric distance rings */}
//         {[0.25, 0.5, 0.75, 1].map((ratio) => (
//           <circle
//             key={ratio}
//             cx={center}
//             cy={center}
//             r={center * ratio - 1}
//             fill="none"
//             stroke="rgba(30,77,123,0.5)"
//             strokeWidth={ratio === 1 ? 1.5 : 0.75}
//             strokeDasharray={ratio < 1 ? '4 6' : 'none'}
//           />
//         ))}

//         {/* Cross-hairs */}
//         <line x1={center} y1={4}      x2={center} y2={size - 4} stroke="rgba(30,77,123,0.3)" strokeWidth={0.5} />
//         <line x1={4}      y1={center} x2={size - 4} y2={center} stroke="rgba(30,77,123,0.3)" strokeWidth={0.5} />

//         {/* Distance labels */}
//         {[
//           { ratio: 0.33, label: '66m'  },
//           { ratio: 0.66, label: '133m' },
//           { ratio: 0.99, label: '200m' },
//         ].map(({ ratio, label }) => (
//           <text
//             key={label}
//             x={center + center * ratio - 4}
//             y={center - 5}
//             fill="rgba(255,255,255,0.18)"
//             fontSize={8}
//             textAnchor="end"
//             fontFamily="JetBrains Mono, monospace"
//           >
//             {label}
//           </text>
//         ))}
//       </svg>

//       {/* ── Rotating sweep arm ─────────────────────────────────────────── */}
//       <div
//         className="absolute inset-0 rounded-full animate-sweep"
//         style={{ transformOrigin: 'center center' }}
//         aria-hidden="true"
//       >
//         <div className="w-full h-full rounded-full radar-sweep-gradient" />
//       </div>

//       {/* ── Sweep arm leading edge ─────────────────────────────────────── */}
//       <div
//         className="absolute inset-0 animate-sweep"
//         style={{ transformOrigin: 'center center' }}
//         aria-hidden="true"
//       >
//         <div
//           className="absolute"
//           style={{
//             left:              center - 1,
//             top:               4,
//             width:             1.5,
//             height:            center - 4,
//             transformOrigin:   'bottom center',
//             background:        'linear-gradient(to top, rgba(0,245,196,0.9), transparent)',
//             borderRadius:      1,
//           }}
//         />
//       </div>

//       {/* ── Centre dot ────────────────────────────────────────────────── */}
//       <div
//         className="absolute"
//         style={{ left: center - 6, top: center - 6 }}
//         aria-hidden="true"
//       >
//         <div className="relative w-3 h-3">
//           {beaconActive && (
//             <span className="absolute inset-0 rounded-full bg-beacon animate-ping-slow opacity-70" />
//           )}
//           <span
//             className="relative block w-3 h-3 rounded-full"
//             style={{
//               background:  beaconActive ? '#00f5c4' : 'rgba(255,255,255,0.4)',
//               boxShadow:   beaconActive ? '0 0 8px rgba(0,245,196,0.8)' : 'none',
//             }}
//           />
//         </div>
//       </div>

//       {/* ── Nearby user blips ─────────────────────────────────────────── */}
//       {nearbyUsers.map((user, index) => {
//         const pos       = blipPosition(user.userId, index, nearbyUsers.length);
//         const isOnline  = user.isOnline !== false;
//         const colour    = user.isConnected
//           ? '#818cf8'
//           : user.requestSent
//             ? '#f59e0b'
//             : '#00f5c4';

//         return (
//           <motion.div
//             key={user.userId}
//             initial={{ opacity: 0, scale: 0 }}
//             animate={{ opacity: 1, scale: 1 }}
//             exit={{ opacity: 0, scale: 0 }}
//             transition={{ type: 'spring', stiffness: 300, damping: 20 }}
//             className="absolute"
//             style={{
//               left: pos.x - 5,
//               top:  pos.y - 5,
//             }}
//             aria-label={`${user.name} is nearby`}
//           >
//             {/* Outer ping ring */}
//             <span
//               className="absolute inset-0 rounded-full animate-ping-slow"
//               style={{
//                 opacity:         0.5,
//                 backgroundColor: colour,
//                 animationDelay:  `${(index * 0.3) % 1.5}s`,
//               }}
//             />
//             {/* Blip dot */}
//             <span
//               className="relative block w-2.5 h-2.5 rounded-full cursor-pointer"
//               style={{
//                 backgroundColor: colour,
//                 boxShadow:       `0 0 6px ${colour}`,
//                 opacity:         isOnline ? 1 : 0.45,
//               }}
//             />
//           </motion.div>
//         );
//       })}
//     </div>
//   );
// }

// // ── Connection status bar ──────────────────────────────────────────────────────
// function StatusBar({ isConnected, isConnecting, zone, lastUpdatedAt }) {
//   return (
//     <div className="flex items-center justify-between px-4 py-2 bg-radar-elevated border-b border-radar-border text-xs font-mono">
//       <div className="flex items-center gap-2">
//         {isConnecting ? (
//           <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
//         ) : isConnected ? (
//           <span className="w-2 h-2 rounded-full bg-beacon glow-beacon" />
//         ) : (
//           <span className="w-2 h-2 rounded-full bg-red-500" />
//         )}
//         <span className="text-white/40">
//           {isConnecting ? 'Connecting…' : isConnected ? 'Live' : 'Disconnected'}
//         </span>
//       </div>

//       {zone && (
//         <div className="flex items-center gap-1.5 text-white/50">
//           <MapPin size={10} />
//           <span>{zone}</span>
//         </div>
//       )}

//       {lastUpdatedAt && (
//         <div className="flex items-center gap-1 text-white/30">
//           <Clock size={10} />
//           <span>{new Date(lastUpdatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
//         </div>
//       )}
//     </div>
//   );
// }

// // ── Beacon control panel ───────────────────────────────────────────────────────
// function BeaconPanel({ beaconActive, beaconExpiresAt, onStart, onStop }) {
//   const [showDurationPicker, setShowDurationPicker] = useState(false);
//   const [selectedDuration,   setSelectedDuration]   = useState(60);
//   const [timeRemaining,      setTimeRemaining]       = useState(null);

//   // Countdown ticker
//   useEffect(() => {
//     if (!beaconActive || !beaconExpiresAt) {
//       setTimeRemaining(null);
//       return;
//     }
//     const tick = () => setTimeRemaining(formatTimeRemaining(beaconExpiresAt));
//     tick();
//     const id = setInterval(tick, 1000);
//     return () => clearInterval(id);
//   }, [beaconActive, beaconExpiresAt]);

//   const handleStart = () => {
//     onStart(selectedDuration);
//     setShowDurationPicker(false);
//   };

//   return (
//     <div className="card p-5 flex flex-col gap-4">
//       {/* Header row */}
//       <div className="flex items-center justify-between">
//         <div className="flex items-center gap-2.5">
//           <div
//             className={`
//               w-8 h-8 rounded-lg flex items-center justify-center transition-colors duration-300
//               ${beaconActive
//                 ? 'bg-beacon/15 text-beacon'
//                 : 'bg-radar-elevated text-white/30'}
//             `}
//           >
//             <Radio size={16} />
//           </div>
//           <div>
//             <p className="text-sm font-semibold text-white">
//               {beaconActive ? 'Broadcasting' : 'Beacon Off'}
//             </p>
//             <p className="text-xs text-white/40">
//               {beaconActive
//                 ? `Visible to others · ${timeRemaining ?? '…'} left`
//                 : 'Start beacon to appear on others\' radar'}
//             </p>
//           </div>
//         </div>

//         {/* Big toggle */}
//         <button
//           type="button"
//           onClick={beaconActive ? onStop : () => setShowDurationPicker((p) => !p)}
//           className={`
//             relative w-14 h-7 rounded-full transition-all duration-300 flex-shrink-0
//             focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-radar-surface
//             ${beaconActive
//               ? 'bg-beacon focus:ring-beacon'
//               : 'bg-radar-elevated border border-radar-border focus:ring-radar-ring'}
//           `}
//           aria-label={beaconActive ? 'Stop beacon' : 'Start beacon'}
//           aria-pressed={beaconActive}
//         >
//           <motion.span
//             layout
//             transition={{ type: 'spring', stiffness: 500, damping: 30 }}
//             className={`
//               absolute top-1 w-5 h-5 rounded-full shadow
//               ${beaconActive ? 'bg-radar-bg right-1' : 'bg-white/30 left-1'}
//             `}
//           />
//           {beaconActive && (
//             <span className="absolute inset-0 rounded-full animate-ping-slow bg-beacon/30" />
//           )}
//         </button>
//       </div>

//       {/* Duration picker — shown when turning beacon ON */}
//       <AnimatePresence>
//         {showDurationPicker && !beaconActive && (
//           <motion.div
//             initial={{ opacity: 0, height: 0 }}
//             animate={{ opacity: 1, height: 'auto' }}
//             exit={{ opacity: 0, height: 0 }}
//             className="overflow-hidden"
//           >
//             <div className="pt-1 flex flex-col gap-3">
//               <p className="text-xs text-white/40 font-medium uppercase tracking-wider">
//                 Broadcast for how long?
//               </p>
//               <div className="grid grid-cols-5 gap-1.5">
//                 {BEACON_DURATIONS.map(({ label, value }) => (
//                   <button
//                     key={value}
//                     type="button"
//                     onClick={() => setSelectedDuration(value)}
//                     className={`
//                       py-2 rounded-lg text-xs font-medium transition-all duration-150
//                       ${selectedDuration === value
//                         ? 'bg-beacon text-radar-bg shadow-beacon'
//                         : 'bg-radar-elevated text-white/50 hover:text-white hover:border-radar-ring border border-radar-border'}
//                     `}
//                   >
//                     {label}
//                   </button>
//                 ))}
//               </div>
//               <button
//                 type="button"
//                 onClick={handleStart}
//                 className="btn-primary h-10 flex items-center justify-center gap-2"
//               >
//                 <Zap size={14} />
//                 Start broadcasting
//               </button>
//             </div>
//           </motion.div>
//         )}
//       </AnimatePresence>

//       {/* Active beacon progress bar */}
//       {beaconActive && beaconExpiresAt && (
//         <BeaconProgressBar expiresAt={beaconExpiresAt} />
//       )}
//     </div>
//   );
// }

// // Thin progress bar showing how much beacon time is left
// function BeaconProgressBar({ expiresAt }) {
//   const [pct, setPct] = useState(100);
//   const startRef = useRef(null);

//   useEffect(() => {
//     // Capture the time we first mounted this bar as the 100% baseline
//     if (!startRef.current) startRef.current = Date.now();

//     const totalMs = new Date(expiresAt) - startRef.current;

//     const tick = () => {
//       const remaining = new Date(expiresAt) - Date.now();
//       setPct(Math.max(0, (remaining / totalMs) * 100));
//     };
//     tick();
//     const id = setInterval(tick, 1000);
//     return () => clearInterval(id);
//   }, [expiresAt]);

//   return (
//     <div className="h-1 rounded-full bg-radar-elevated overflow-hidden">
//       <motion.div
//         className="h-full rounded-full bg-beacon"
//         style={{ width: `${pct}%` }}
//         transition={{ duration: 1, ease: 'linear' }}
//       />
//     </div>
//   );
// }

// // ── Geolocation permission gate ────────────────────────────────────────────────
// function PermissionGate({ permissionState, error, onRequest }) {
//   if (permissionState === 'granted') return null;

//   const isDenied      = permissionState === 'denied';
//   const isUnsupported = permissionState === 'unsupported';

//   return (
//     <motion.div
//       initial={{ opacity: 0, y: 8 }}
//       animate={{ opacity: 1, y: 0 }}
//       className={`
//         card p-4 flex items-start gap-3
//         ${isDenied ? 'border-red-500/30' : 'border-amber-500/30'}
//       `}
//     >
//       <AlertTriangle
//         size={18}
//         className={`flex-shrink-0 mt-0.5 ${isDenied ? 'text-red-400' : 'text-amber-400'}`}
//       />
//       <div className="flex-1 min-w-0">
//         <p className={`text-sm font-medium ${isDenied ? 'text-red-300' : 'text-amber-300'}`}>
//           {isUnsupported
//             ? 'Geolocation not supported'
//             : isDenied
//               ? 'Location access denied'
//               : 'Location access needed'}
//         </p>
//         <p className="text-xs text-white/40 mt-0.5">
//           {isUnsupported
//             ? 'Your browser does not support GPS. Try Chrome or Safari.'
//             : isDenied
//               ? 'Enable location in your browser settings, then refresh.'
//               : 'Allow location access to use the radar and appear to others nearby.'}
//         </p>
//         {!isDenied && !isUnsupported && (
//           <button
//             type="button"
//             onClick={onRequest}
//             className="mt-2.5 btn-primary text-xs py-1.5 px-3 h-auto inline-flex items-center gap-1.5"
//           >
//             <Navigation size={12} />
//             Allow location access
//           </button>
//         )}
//       </div>
//     </motion.div>
//   );
// }

// // ── Nearby user card ───────────────────────────────────────────────────────────
// function BlipCard({ user, onConnect, onChat, index }) {
//   const colour = user.isConnected
//     ? '#818cf8'
//     : user.requestSent
//       ? '#f59e0b'
//       : '#00f5c4';

//   return (
//     <motion.div
//       layout
//       initial={{ opacity: 0, y: 12, scale: 0.97 }}
//       animate={{ opacity: 1, y: 0,  scale: 1 }}
//       exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.15 } }}
//       transition={{ delay: index * 0.04, type: 'spring', stiffness: 280, damping: 24 }}
//       className="card p-4 flex items-center gap-3 hover:border-radar-ring transition-colors duration-200"
//     >
//       {/* Avatar */}
//       <div className="relative flex-shrink-0">
//         <div
//           className="w-10 h-10 rounded-xl flex items-center justify-center text-sm font-semibold"
//           style={{
//             background: `${colour}18`,
//             border:     `1px solid ${colour}40`,
//             color:      colour,
//           }}
//         >
//           {user.avatar
//             ? <img src={user.avatar} alt={user.name} className="w-full h-full rounded-xl object-cover" />
//             : user.name?.[0]?.toUpperCase() ?? '?'}
//         </div>
//         {/* Online indicator */}
//         <span
//           className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-radar-surface"
//           style={{ background: user.isOnline !== false ? colour : '#444' }}
//         />
//       </div>

//       {/* Info */}
//       <div className="flex-1 min-w-0">
//         <div className="flex items-center gap-2">
//           <p className="text-sm font-semibold text-white truncate">{user.name}</p>
//           {user.isConnected && (
//             <span className="badge bg-indigo-500/15 text-indigo-300 border border-indigo-500/25 text-[10px]">
//               Connected
//             </span>
//           )}
//           {user.requestSent && !user.isConnected && (
//             <span className="badge bg-amber-500/15 text-amber-300 border border-amber-500/25 text-[10px]">
//               Pending
//             </span>
//           )}
//         </div>
//         <div className="flex items-center gap-2 mt-0.5">
//           <span className="text-xs text-white/40 flex items-center gap-1">
//             <MapPin size={9} />
//             {user.zone ?? '—'}
//           </span>
//           <span className="text-white/20 text-xs">·</span>
//           <span className="text-xs font-mono" style={{ color: `${colour}cc` }}>
//             {formatDistance(user.distanceMeters)}
//           </span>
//         </div>
//         {/* Tags */}
//         {user.tags?.length > 0 && (
//           <div className="flex flex-wrap gap-1 mt-1.5">
//             {user.tags.slice(0, 4).map((tag) => (
//               <span
//                 key={tag}
//                 className="badge bg-radar-elevated text-white/40 border border-radar-border text-[10px]"
//               >
//                 {tag}
//               </span>
//             ))}
//           </div>
//         )}
//       </div>

//       {/* Action buttons */}
//       <div className="flex flex-col gap-1.5 flex-shrink-0">
//         {user.isConnected ? (
//           <button
//             type="button"
//             onClick={() => onChat(user)}
//             className="w-8 h-8 rounded-lg bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20 transition-colors flex items-center justify-center"
//             aria-label={`Chat with ${user.name}`}
//           >
//             <MessageCircle size={15} />
//           </button>
//         ) : user.requestSent ? (
//           <button
//             type="button"
//             disabled
//             className="w-8 h-8 rounded-lg bg-amber-500/10 text-amber-400/50 flex items-center justify-center cursor-not-allowed"
//             aria-label="Request pending"
//           >
//             <Clock size={15} />
//           </button>
//         ) : (
//           <button
//             type="button"
//             onClick={() => onConnect(user)}
//             className="w-8 h-8 rounded-lg bg-beacon/10 text-beacon hover:bg-beacon/20 transition-colors flex items-center justify-center"
//             aria-label={`Connect with ${user.name}`}
//           >
//             <Zap size={15} />
//           </button>
//         )}
//       </div>
//     </motion.div>
//   );
// }

// // ── Connect request modal ──────────────────────────────────────────────────────
// function ConnectModal({ target, onSend, onClose }) {
//   const [message, setMessage] = useState('');
//   const maxLen = 200;

//   const handleSend = () => {
//     onSend(target.userId, message.trim());
//     onClose();
//   };

//   return (
//     <motion.div
//       initial={{ opacity: 0 }}
//       animate={{ opacity: 1 }}
//       exit={{ opacity: 0 }}
//       className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4"
//       style={{ background: 'rgba(5,13,26,0.85)' }}
//       onClick={onClose}
//     >
//       <motion.div
//         initial={{ y: 40, scale: 0.97 }}
//         animate={{ y: 0,  scale: 1 }}
//         exit={{ y: 40, scale: 0.97, opacity: 0 }}
//         transition={{ type: 'spring', stiffness: 300, damping: 28 }}
//         className="card-elevated w-full max-w-sm p-6 flex flex-col gap-5"
//         onClick={(e) => e.stopPropagation()}
//       >
//         <div>
//           <h2 className="text-base font-semibold text-white">
//             Connect with {target.name}
//           </h2>
//           <p className="text-sm text-white/40 mt-0.5">
//             They are at <span className="text-white/60">{target.zone}</span>,{' '}
//             {formatDistance(target.distanceMeters)} away
//           </p>
//         </div>

//         <div className="flex flex-col gap-1.5">
//           <label htmlFor="connect-msg" className="text-sm font-medium text-white/70">
//             Say hello
//             <span className="text-white/30 font-normal ml-1">(optional)</span>
//           </label>
//           <textarea
//             id="connect-msg"
//             rows={3}
//             maxLength={maxLen}
//             value={message}
//             onChange={(e) => setMessage(e.target.value)}
//             placeholder={`Hi ${target.name?.split(' ')[0]}, I spotted you on the radar! Want to connect?`}
//             className="input resize-none leading-relaxed py-3 text-sm"
//             autoFocus
//           />
//           <p className="text-xs text-white/25 text-right">
//             {message.length}/{maxLen}
//           </p>
//         </div>

//         <div className="flex gap-2">
//           <button type="button" onClick={onClose} className="btn-ghost flex-1 h-10">
//             Cancel
//           </button>
//           <button type="button" onClick={handleSend} className="btn-primary flex-1 h-10 flex items-center justify-center gap-1.5">
//             <Zap size={14} />
//             Send request
//           </button>
//         </div>
//       </motion.div>
//     </motion.div>
//   );
// }

// // ── Top navigation bar ────────────────────────────────────────────────────────
// function NavBar({ user, isConnected, onLogout }) {
//   return (
//     <header className="flex items-center justify-between px-4 py-3 bg-radar-surface border-b border-radar-border">
//       <div className="flex items-center gap-2.5">
//         <div className="relative w-7 h-7">
//           <div className="absolute inset-0 rounded-full border border-beacon/20 animate-ping-slow" />
//           <div className="absolute inset-1 rounded-full border border-beacon/40" />
//           <div className="absolute inset-0 flex items-center justify-center">
//             <div className="w-1.5 h-1.5 rounded-full bg-beacon" style={{ boxShadow: '0 0 4px rgba(0,245,196,0.8)' }} />
//           </div>
//         </div>
//         <span className="font-semibold text-white tracking-tight">proximity</span>
//       </div>

//       <div className="flex items-center gap-2">
//         {/* Connection status pill */}
//         <div className={`
//           flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium
//           ${isConnected
//             ? 'bg-beacon/10 text-beacon border border-beacon/20'
//             : 'bg-red-500/10 text-red-400 border border-red-500/20'}
//         `}>
//           {isConnected ? <Wifi size={11} /> : <WifiOff size={11} />}
//           {isConnected ? 'Live' : 'Offline'}
//         </div>

//         {/* User avatar / logout */}
//         <div className="flex items-center gap-1">
//           <div className="w-7 h-7 rounded-lg bg-radar-elevated border border-radar-border flex items-center justify-center text-xs font-semibold text-white/70">
//             {user?.name?.[0]?.toUpperCase() ?? '?'}
//           </div>
//           <button
//             type="button"
//             onClick={onLogout}
//             className="w-7 h-7 rounded-lg text-white/30 hover:text-white/70 hover:bg-radar-elevated transition-colors flex items-center justify-center"
//             aria-label="Log out"
//           >
//             <LogOut size={14} />
//           </button>
//         </div>
//       </div>
//     </header>
//   );
// }

// // ── Empty state ───────────────────────────────────────────────────────────────
// function EmptyRadar({ beaconActive, permissionGranted }) {
//   return (
//     <div className="flex flex-col items-center justify-center py-10 gap-3 text-center">
//       <div className="w-12 h-12 rounded-2xl bg-radar-elevated border border-radar-border flex items-center justify-center">
//         <Users size={20} className="text-white/20" />
//       </div>
//       <div>
//         <p className="text-sm font-medium text-white/40">No one on radar yet</p>
//         <p className="text-xs text-white/25 mt-0.5 max-w-[200px]">
//           {!permissionGranted
//             ? 'Allow location access to scan your area'
//             : !beaconActive
//               ? 'Start your beacon so others can find you too'
//               : 'Scanning 200m radius… people will appear as they join'}
//         </p>
//       </div>
//     </div>
//   );
// }

// // ─────────────────────────────────────────────────────────────────────────────
// // MAIN PAGE COMPONENT
// // ─────────────────────────────────────────────────────────────────────────────
// export default function RadarPage() {
//   const navigate = useNavigate();
//   const { user, logout }        = useAuth();
//   const {
//     isConnected,
//     isConnecting,
//     beaconActive,
//     beaconExpiresAt,
//     nearbyUsers: socketNearbyUsers,
//     startBeacon,
//     stopBeacon,
//     sendConnectionRequest,
//     onEvent,
//   } = useSocket();

//   const {
//     position,
//     permissionState,
//     error: geoError,
//     lastUpdatedAt,
//     requestPermission,
//   } = useGeolocation();

//   // ── Local state ────────────────────────────────────────────────────────────

//   // Merged nearby users — combines the full proximity:nearby list with
//   // incremental proximity:appeared pushes and stale-user pruning.
//   const [nearbyUsers, setNearbyUsers]         = useState([]);
//   const [connectTarget, setConnectTarget]     = useState(null); // user being requested
//   const [listExpanded, setListExpanded]       = useState(true);
//   const [pendingUserIds, setPendingUserIds]   = useState(new Set()); // request sent

//   // Ref to the stale-pruning interval
//   const pruneIntervalRef = useRef(null);

//   // ── Sync socket nearby list into local state ────────────────────────────────
//   // The socket context's nearbyUsers is updated on every proximity:nearby event.
//   // We merge it here to preserve requestSent state and lastSeenAt timestamps.
//   useEffect(() => {
//     console.log('[radar] socketNearbyUsers changed:', socketNearbyUsers);
//     if (!socketNearbyUsers?.length) return;

//     setNearbyUsers((prev) => {
//       const prevMap = new Map(prev.map((u) => [u.userId, u]));

//       const merged = socketNearbyUsers.map((incoming) => {
//         const existing = prevMap.get(incoming.userId) ?? {};
//         return {
//           ...existing,
//           ...incoming,
//           requestSent: pendingUserIds.has(incoming.userId) || existing.requestSent,
//           lastSeenAt:  Date.now(),
//         };
//       });

//       return merged;
//     });
//   // eslint-disable-next-line react-hooks/exhaustive-deps
//   }, [socketNearbyUsers]);

//   // ── Listen for proximity:appeared (push — someone entered radius) ──────────
//   useEffect(() => {
//     const cleanup = onEvent('proximity:appeared', (incomingUser) => {
//       setNearbyUsers((prev) => {
//         const existing = prev.find((u) => u.userId === incomingUser.userId);
//         if (existing) {
//           // Update last seen but don't discard request state
//           return prev.map((u) =>
//             u.userId === incomingUser.userId
//               ? { ...u, ...incomingUser, lastSeenAt: Date.now() }
//               : u
//           );
//         }
//         return [
//           ...prev,
//           {
//             ...incomingUser,
//             requestSent: pendingUserIds.has(incomingUser.userId),
//             lastSeenAt:  Date.now(),
//           },
//         ];
//       });
//     });
//     return cleanup;
//   }, [onEvent, pendingUserIds]);

//   // ── Listen for connect:request_sent confirmation ────────────────────────────
//   useEffect(() => {
//     const cleanup = onEvent('connect:request_sent', ({ toUserId }) => {
//       setPendingUserIds((prev) => new Set([...prev, toUserId]));
//       setNearbyUsers((prev) =>
//         prev.map((u) => (u.userId === toUserId ? { ...u, requestSent: true } : u))
//       );
//     });
//     return cleanup;
//   }, [onEvent]);

//   // ── Listen for connect:you_were_accepted ────────────────────────────────────
//   useEffect(() => {
//     const cleanup = onEvent('connect:you_were_accepted', ({ byUserId, roomId }) => {
//       setNearbyUsers((prev) =>
//         prev.map((u) =>
//           u.userId === byUserId ? { ...u, isConnected: true, requestSent: false, roomId } : u
//         )
//       );
//     });
//     return cleanup;
//   }, [onEvent]);

//   // ── Prune stale blips ──────────────────────────────────────────────────────
//   // Remove users who haven't sent a location update in > 90 seconds.
//   // This mirrors the backend TTL index behaviour on the client side.
//   useEffect(() => {
//     pruneIntervalRef.current = setInterval(() => {
//       const now = Date.now();
//       setNearbyUsers((prev) =>
//         prev.filter((u) => {
//           if (!u.lastSeenAt) return true; // keep if we have no timestamp
//           return now - u.lastSeenAt < BLIP_STALE_THRESHOLD_MS;
//         })
//       );
//     }, 15_000); // check every 15 seconds

//     return () => clearInterval(pruneIntervalRef.current);
//   }, []);

//   // ── Derive current zone from position ──────────────────────────────────────
//   // The actual zone snapping happens server-side, but we show the last
//   // known zone label from the most recent nearby response or position.
//   const currentZone = nearbyUsers.length > 0
//     ? null // the status bar will stay empty until server confirms zone
//     : null;

//   // ── Handlers ──────────────────────────────────────────────────────────────
//   const handleConnectRequest = useCallback((target) => {
//     setConnectTarget(target);
//   }, []);

//   const handleSendRequest = useCallback((toUserId, message) => {
//     sendConnectionRequest(toUserId, message);
//   }, [sendConnectionRequest]);

//   const handleChatNav = useCallback((user) => {
//     if (user.roomId) {
//       navigate(`/chat/${user.roomId}`);
//     }
//   }, [navigate]);

//   const handleLogout = useCallback(async () => {
//     stopBeacon();
//     await logout();
//     navigate('/login', { replace: true });
//   }, [logout, navigate, stopBeacon]);

//   // ── Derived values ─────────────────────────────────────────────────────────
//   const permissionGranted = permissionState === 'granted';
//   const onlineCount       = nearbyUsers.filter((u) => u.isOnline !== false).length;

//   // ─────────────────────────────────────────────────────────────────────────
//   // RENDER
//   // ─────────────────────────────────────────────────────────────────────────
//   return (
//     <div className="min-h-screen bg-radar-bg flex flex-col">
//       {/* Nav */}
//       <NavBar user={user} isConnected={isConnected} onLogout={handleLogout} />

//       {/* Socket status bar */}
//       <StatusBar
//         isConnected={isConnected}
//         isConnecting={isConnecting}
//         zone={position ? undefined : undefined}
//         lastUpdatedAt={lastUpdatedAt}
//       />

//       {/* ── Main scrollable body ─────────────────────────────────────────── */}
//       <main className="flex-1 overflow-y-auto">
//         <div className="max-w-md mx-auto px-4 py-6 flex flex-col gap-5">

//           {/* ── Radar canvas ──────────────────────────────────────────────── */}
//           <div className="flex flex-col items-center gap-3">
//             <div className="relative">
//               <RadarCanvas
//                 nearbyUsers={nearbyUsers}
//                 beaconActive={beaconActive}
//                 size={280}
//               />

//               {/* Radius label */}
//               <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 text-[10px] font-mono text-white/20 whitespace-nowrap">
//                 200m radius
//               </div>
//             </div>

//             {/* Live count pill */}
//             <motion.div
//               key={onlineCount}
//               initial={{ scale: 0.8, opacity: 0 }}
//               animate={{ scale: 1, opacity: 1 }}
//               className={`
//                 flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium
//                 ${onlineCount > 0
//                   ? 'bg-beacon/10 text-beacon border border-beacon/20'
//                   : 'bg-radar-elevated text-white/30 border border-radar-border'}
//               `}
//             >
//               {onlineCount > 0 ? (
//                 <>
//                   <span className="w-1.5 h-1.5 rounded-full bg-beacon animate-pulse" />
//                   {onlineCount} {onlineCount === 1 ? 'person' : 'people'} nearby
//                 </>
//               ) : (
//                 <>
//                   <span className="w-1.5 h-1.5 rounded-full bg-white/20" />
//                   Scanning…
//                 </>
//               )}
//             </motion.div>
//           </div>

//           {/* ── Permission gate ────────────────────────────────────────── */}
//           <AnimatePresence>
//             {!permissionGranted && (
//               <PermissionGate
//                 permissionState={permissionState}
//                 error={geoError}
//                 onRequest={requestPermission}
//               />
//             )}
//           </AnimatePresence>

//           {/* ── GPS error (non-denial, e.g. timeout) ──────────────────── */}
//           <AnimatePresence>
//             {geoError && permissionGranted && (
//               <motion.div
//                 initial={{ opacity: 0, y: 4 }}
//                 animate={{ opacity: 1, y: 0 }}
//                 exit={{ opacity: 0 }}
//                 className="flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-xl px-3 py-2.5"
//               >
//                 <AlertTriangle size={13} className="flex-shrink-0" />
//                 {geoError}
//               </motion.div>
//             )}
//           </AnimatePresence>

//           {/* ── Beacon control ─────────────────────────────────────────── */}
//           <BeaconPanel
//             beaconActive={beaconActive}
//             beaconExpiresAt={beaconExpiresAt}
//             onStart={startBeacon}
//             onStop={stopBeacon}
//           />

//           {/* ── Nearby users list ──────────────────────────────────────── */}
//           <div className="flex flex-col gap-3">
//             {/* Section header */}
//             <div className="flex items-center justify-between">
//               <div className="flex items-center gap-2">
//                 <Users size={14} className="text-white/40" />
//                 <span className="text-sm font-semibold text-white/70">Nearby</span>
//                 {nearbyUsers.length > 0 && (
//                   <span className="badge bg-radar-elevated text-white/40 border border-radar-border">
//                     {nearbyUsers.length}
//                   </span>
//                 )}
//               </div>
//               {nearbyUsers.length > 0 && (
//                 <button
//                   type="button"
//                   onClick={() => setListExpanded((p) => !p)}
//                   className="text-white/30 hover:text-white/60 transition-colors flex items-center gap-1 text-xs"
//                 >
//                   {listExpanded ? (
//                     <><ChevronUp size={14} /> Collapse</>
//                   ) : (
//                     <><ChevronDown size={14} /> Show {nearbyUsers.length}</>
//                   )}
//                 </button>
//               )}
//             </div>

//             {/* User cards */}
//             <AnimatePresence mode="popLayout">
//               {listExpanded && nearbyUsers.length > 0 ? (
//                 nearbyUsers.map((u, i) => (
//                   <BlipCard
//                     key={u.userId}
//                     user={u}
//                     index={i}
//                     onConnect={handleConnectRequest}
//                     onChat={handleChatNav}
//                   />
//                 ))
//               ) : (
//                 !listExpanded ? null : (
//                   <motion.div
//                     key="empty"
//                     initial={{ opacity: 0 }}
//                     animate={{ opacity: 1 }}
//                     exit={{ opacity: 0 }}
//                   >
//                     <EmptyRadar
//                       beaconActive={beaconActive}
//                       permissionGranted={permissionGranted}
//                     />
//                   </motion.div>
//                 )
//               )}
//             </AnimatePresence>
//           </div>

//           {/* Bottom padding so last card isn't flush against viewport edge */}
//           <div className="h-6" />
//         </div>
//       </main>

//       {/* ── Connect modal (portal-style, overlaid) ──────────────────────── */}
//       <AnimatePresence>
//         {connectTarget && (
//           <ConnectModal
//             target={connectTarget}
//             onSend={handleSendRequest}
//             onClose={() => setConnectTarget(null)}
//           />
//         )}
//       </AnimatePresence>
//     </div>
//   );
// }