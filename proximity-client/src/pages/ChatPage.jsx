import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft,
  Send,
  MapPin,
  Radio,
  Check,
  CheckCheck,
  Clock,
  Loader2,
  AlertTriangle,
  ChevronUp,
  Zap,
  UserCheck,
} from 'lucide-react';

import { useSocket } from '../context/SocketContext';
import { useAuth }   from '../context/AuthContext';
import api           from '../lib/api';

// ── Constants ─────────────────────────────────────────────────────────────────
const TYPING_DEBOUNCE_MS = 1_500;
const MESSAGES_PER_PAGE  = 30;

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatMessageTime(dateStr) {
  return new Date(dateStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDayLabel(dateStr) {
  const d         = new Date(dateStr);
  const now       = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString())       return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

// ── FIX 2a — normalise senderId regardless of whether Mongoose populated it ──
// When messages are loaded via REST, getConversationHistory() calls
// .populate('senderId', 'name avatar'), turning senderId into an object like
// { _id: '69da...', name: 'bot1' }. Calling .toString() on a plain object
// returns '[object Object]', which never matches user._id.
// This helper always returns a plain string regardless of shape.
function getSenderId(senderId) {
  if (!senderId) return '';
  if (typeof senderId === 'string') return senderId;
  // Populated object: { _id: ObjectId | string, name, avatar }
  if (typeof senderId === 'object') {
    const id = senderId._id ?? senderId;
    return id?.toString() ?? '';
  }
  return senderId.toString();
}

function groupMessagesByDay(messages) {
  const groups   = [];
  let currentDay = null;
  messages.forEach((msg) => {
    const day = new Date(msg.createdAt).toDateString();
    if (day !== currentDay) {
      currentDay = day;
      groups.push({ type: 'separator', day, label: formatDayLabel(msg.createdAt) });
    }
    groups.push({ type: 'message', ...msg });
  });
  return groups;
}

// ── Generate a lightweight correlation token for optimistic messages ──────────
function generateClientId() {
  return `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

function MessageBubble({ message, isMine, showAvatar, otherUser }) {
  const isRequest = message.type === 'connect_request';
  const isAccept  = message.type === 'connect_accept';
  const isSystem  = message.type === 'system' || isAccept;

  if (isSystem) {
    return (
      <div className="flex justify-center my-2">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-radar-elevated border border-radar-border">
          <UserCheck size={12} className="text-beacon" />
          <span className="text-xs text-white/40">{message.content}</span>
        </div>
      </div>
    );
  }

  if (isRequest) {
    return (
      <div className={`flex ${isMine ? 'justify-end' : 'justify-start'} mb-2`}>
        <div className="max-w-[78%] rounded-2xl border border-beacon/20 bg-beacon/5 p-4 flex flex-col gap-2">
          <div className="flex items-center gap-2 text-beacon">
            <Zap size={14} />
            <span className="text-xs font-semibold uppercase tracking-wider">Connection request</span>
          </div>
          {message.content && (
            <p className="text-sm text-white/80 leading-relaxed">{message.content}</p>
          )}
          <p className="text-[10px] text-white/30">{formatMessageTime(message.createdAt)}</p>
        </div>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className={`flex items-end gap-2 mb-1 ${isMine ? 'flex-row-reverse' : 'flex-row'}`}
    >
      {/* Other user avatar */}
      <div className="w-7 flex-shrink-0 self-end">
        {!isMine && showAvatar && (
          <div className="w-7 h-7 rounded-full bg-radar-elevated border border-radar-border flex items-center justify-center text-xs font-semibold text-white/60">
            {otherUser?.avatar
              ? <img src={otherUser.avatar} alt="" className="w-full h-full rounded-full object-cover" />
              : otherUser?.name?.[0]?.toUpperCase() ?? '?'}
          </div>
        )}
      </div>

      {/* Bubble */}
      <div className={`
        max-w-[75%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed
        ${isMine
          ? 'bg-beacon text-radar-bg rounded-br-sm font-medium'
          : 'bg-radar-elevated text-white border border-radar-border rounded-bl-sm'}
        ${message._optimistic ? 'opacity-70' : 'opacity-100'}
      `}>
        <p className="break-words whitespace-pre-wrap">{message.content}</p>
      </div>

      {/* Timestamp + read receipt (own messages) */}
      {isMine && (
        <div className="flex flex-col items-end gap-0.5 flex-shrink-0 self-end pb-0.5">
          <span className="text-[10px] text-white/25 font-mono">
            {formatMessageTime(message.createdAt)}
          </span>
          <span className="text-[10px]">
            {message._optimistic ? (
              <Clock size={12} className="text-white/20" />
            ) : message.readAt ? (
              <CheckCheck size={12} className="text-beacon" />
            ) : message.delivered ? (
              <CheckCheck size={12} className="text-white/25" />
            ) : (
              <Check size={12} className="text-white/20" />
            )}
          </span>
        </div>
      )}

      {/* Timestamp (received messages) */}
      {!isMine && (
        <span className="text-[10px] text-white/25 font-mono self-end pb-0.5 flex-shrink-0">
          {formatMessageTime(message.createdAt)}
        </span>
      )}
    </motion.div>
  );
}

function TypingIndicator() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 6 }}
      className="flex items-end gap-2 mb-2"
    >
      <div className="w-7" />
      <div className="px-4 py-3 rounded-2xl rounded-bl-sm bg-radar-elevated border border-radar-border">
        <div className="flex gap-1 items-center h-3">
          {[0, 1, 2].map((i) => (
            <motion.span key={i} className="w-1.5 h-1.5 rounded-full bg-white/40"
              animate={{ y: [0, -4, 0] }}
              transition={{ duration: 0.7, repeat: Infinity, delay: i * 0.15, ease: 'easeInOut' }} />
          ))}
        </div>
      </div>
    </motion.div>
  );
}

function DaySeparator({ label }) {
  return (
    <div className="flex items-center gap-3 my-4">
      <div className="flex-1 h-px bg-radar-border" />
      <span className="text-[10px] text-white/30 font-mono uppercase tracking-wider px-2">{label}</span>
      <div className="flex-1 h-px bg-radar-border" />
    </div>
  );
}

function ChatHeader({ otherUser, isOnline, onBack }) {
  return (
    <header className="flex items-center gap-3 px-4 py-3 bg-radar-surface border-b border-radar-border flex-shrink-0">
      <button type="button" onClick={onBack}
        className="w-8 h-8 rounded-lg text-white/40 hover:text-white hover:bg-radar-elevated transition-colors flex items-center justify-center flex-shrink-0"
        aria-label="Back">
        <ArrowLeft size={18} />
      </button>
      <div className="relative flex-shrink-0">
        <div className="w-9 h-9 rounded-xl bg-radar-elevated border border-radar-border flex items-center justify-center text-sm font-semibold text-white/70">
          {otherUser?.avatar
            ? <img src={otherUser.avatar} alt="" className="w-full h-full rounded-xl object-cover" />
            : otherUser?.name?.[0]?.toUpperCase() ?? '?'}
        </div>
        <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-radar-surface"
          style={{ background: isOnline ? '#00f5c4' : '#444' }} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-white truncate">{otherUser?.name ?? 'Loading…'}</p>
        <div className="flex items-center gap-1.5">
          {isOnline
            ? <><Radio size={10} className="text-beacon" /><span className="text-[11px] text-beacon">Online</span></>
            : <span className="text-[11px] text-white/30">Offline</span>}
        </div>
      </div>
      {otherUser?.tags?.length > 0 && (
        <div className="hidden sm:flex gap-1 flex-shrink-0">
          {otherUser.tags.slice(0, 2).map((tag) => (
            <span key={tag} className="badge bg-radar-elevated text-white/40 border border-radar-border text-[10px]">{tag}</span>
          ))}
        </div>
      )}
    </header>
  );
}

function LoadMoreButton({ onClick, isLoading }) {
  return (
    <div className="flex justify-center py-3">
      <button type="button" onClick={onClick} disabled={isLoading}
        className="flex items-center gap-2 text-xs text-white/40 hover:text-white/70 transition-colors px-4 py-2 rounded-full border border-radar-border hover:border-radar-ring">
        {isLoading ? <Loader2 size={12} className="animate-spin" /> : <ChevronUp size={12} />}
        {isLoading ? 'Loading…' : 'Load earlier messages'}
      </button>
    </div>
  );
}

function MessageInput({ onSend, onTyping, disabled }) {
  const [text,         setText]         = useState('');
  const [isSending,    setIsSending]    = useState(false);
  const textareaRef    = useRef(null);
  const typingTimerRef = useRef(null);

  const handleChange = (e) => {
    setText(e.target.value);
    const el = textareaRef.current;
    if (el) { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 120)}px`; }
    onTyping(true);
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => onTyping(false), TYPING_DEBOUNCE_MS);
  };

  const handleSend = async () => {
    const content = text.trim();
    if (!content || isSending || disabled) return;
    setIsSending(true);
    setText('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
    onTyping(false);
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    try { await onSend(content); }
    finally { setIsSending(false); textareaRef.current?.focus(); }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const canSend = text.trim().length > 0 && !disabled;

  return (
    <div className="flex-shrink-0 px-4 py-3 bg-radar-surface border-t border-radar-border">
      <div className="flex items-end gap-2 bg-radar-elevated border border-radar-border rounded-2xl px-4 py-2.5 focus-within:border-beacon transition-colors duration-150">
        <textarea ref={textareaRef} value={text} onChange={handleChange} onKeyDown={handleKeyDown}
          placeholder={disabled ? 'Connecting…' : 'Type a message…'} disabled={disabled} rows={1}
          className="flex-1 bg-transparent text-white text-sm placeholder-white/25 outline-none resize-none leading-relaxed max-h-[120px] disabled:opacity-40"
          style={{ minHeight: '24px' }} />
        <motion.button type="button" onClick={handleSend} disabled={!canSend}
          whileTap={canSend ? { scale: 0.9 } : {}}
          className={`flex-shrink-0 w-8 h-8 rounded-xl flex items-center justify-center transition-all duration-150
            ${canSend ? 'bg-beacon text-radar-bg shadow-beacon hover:bg-beacon-dim' : 'bg-radar-surface text-white/20 cursor-not-allowed'}`}
          aria-label="Send message">
          {isSending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
        </motion.button>
      </div>
      <p className="text-[10px] text-white/20 text-center mt-1.5">Enter to send · Shift+Enter for new line</p>
    </div>
  );
}

function MeetZoneBanner({ zone }) {
  if (!zone) return null;
  return (
    <div className="flex justify-center pt-6 pb-2">
      <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-radar-elevated border border-radar-border">
        <MapPin size={11} className="text-beacon" />
        <span className="text-[11px] text-white/40">
          You connected at <span className="text-white/60">{zone}</span>
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN PAGE
// ─────────────────────────────────────────────────────────────────────────────
export default function ChatPage() {
  const { roomId }  = useParams();
  const navigate    = useNavigate();
  const { user }    = useAuth();
  const {
    isConnected,
    onEvent,
    joinRoom,
    sendMessage,
    sendTypingIndicator,
    markRoomRead,
    nearbyUsers,
  } = useSocket();

  const [messages,      setMessages]      = useState([]);
  const [otherUser,     setOtherUser]     = useState(null);
  const [isLoadingInit, setIsLoadingInit] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore,       setHasMore]       = useState(false);
  const [oldestId,      setOldestId]      = useState(null);
  const [otherTyping,   setOtherTyping]   = useState(false);
  const [error,         setError]         = useState(null);
  const [meetZone,      setMeetZone]      = useState(null);

  const bottomRef       = useRef(null);
  const typingTimerRef  = useRef(null);
  const isNearBottomRef = useRef(true);

  // ── Current user ID as a stable plain string ──────────────────────────────
  // Always derive once so all comparisons use the same normalised value.
  const myId = useMemo(() => user?._id?.toString() ?? '', [user]);

  // ── Other participant ID ───────────────────────────────────────────────────
  const otherUserId = useMemo(() => {
    if (!roomId) return null;
    return roomId.split('_').find((id) => id !== myId) ?? null;
  }, [roomId, myId]);

  const isOtherOnline = useMemo(
    () => nearbyUsers.some((u) => u.userId?.toString() === otherUserId),
    [nearbyUsers, otherUserId]
  );

  // ── Load initial history ───────────────────────────────────────────────────
  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;

    (async () => {
      setIsLoadingInit(true);
      setError(null);
      try {
        const { data } = await api.get(`/messages/${roomId}`, { params: { limit: MESSAGES_PER_PAGE } });
        if (cancelled) return;
        setMessages(data.messages);
        setOtherUser(data.otherUser);
        setHasMore(data.hasMore);
        setOldestId(data.oldestId);
        const requestMsg = data.messages.find((m) => m.type === 'connect_request');
        if (requestMsg?.meetZone) setMeetZone(requestMsg.meetZone);
      } catch (err) {
        if (!cancelled) {
          setError('Failed to load conversation. Please go back and try again.');
          console.error('[chat] History load error:', err.message);
        }
      } finally {
        if (!cancelled) setIsLoadingInit(false);
      }
    })();

    return () => { cancelled = true; };
  }, [roomId]);

  // ── Join Socket.io room ────────────────────────────────────────────────────
  useEffect(() => {
    if (!roomId || !isConnected) return;
    joinRoom(roomId);
    markRoomRead(roomId);
  }, [roomId, isConnected, joinRoom, markRoomRead]);

  // ── Incoming chat messages ─────────────────────────────────────────────────
  useEffect(() => {
    const cleanup = onEvent('chat:message', (msg) => {
      if (msg.roomId !== roomId) return;

      setMessages((prev) => {
        // ── FIX 1: clientId-based optimistic replacement ───────────────────
        // When the server echoes a message back to the SENDER, it includes the
        // clientId that was passed in the emit payload. We find the matching
        // optimistic bubble by clientId and replace it with the confirmed
        // server message (which now has a real _id, createdAt, etc.).
        if (msg.clientId) {
          const optimisticIndex = prev.findIndex(
            (m) => m._optimistic && m.clientId === msg.clientId
          );
          if (optimisticIndex !== -1) {
            const next = [...prev];
            // Replace the optimistic entry with the confirmed message.
            // Carry over _optimistic: false explicitly so the opacity resets.
            next[optimisticIndex] = { ...msg, _optimistic: false };
            return next;
          }
        }

        // ── Standard dedup: drop if exact _id already exists ──────────────
        // Covers: recipient receiving a message they didn't send, and any
        // edge case where the same event fires twice.
        if (prev.some((m) => m._id?.toString() === msg._id?.toString())) {
          return prev;
        }

        return [...prev, { ...msg, _optimistic: false }];
      });

      if (getSenderId(msg.senderId) !== myId) {
        markRoomRead(roomId);
      }
    });
    return cleanup;
  }, [onEvent, roomId, myId, markRoomRead]);

  // ── Read receipts ──────────────────────────────────────────────────────────
  useEffect(() => {
    const cleanup = onEvent('chat:read_receipt', ({ roomId: rid, readAt }) => {
      if (rid !== roomId) return;
      setMessages((prev) =>
        prev.map((m) =>
          getSenderId(m.senderId) === myId && !m.readAt
            ? { ...m, readAt }
            : m
        )
      );
    });
    return cleanup;
  }, [onEvent, roomId, myId]);

  // ── Typing indicator ───────────────────────────────────────────────────────
  useEffect(() => {
    const cleanup = onEvent('chat:typing', ({ roomId: rid, fromUserId, isTyping }) => {
      if (rid !== roomId || fromUserId === myId) return;
      setOtherTyping(isTyping);
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      if (isTyping) typingTimerRef.current = setTimeout(() => setOtherTyping(false), 3_000);
    });
    return cleanup;
  }, [onEvent, roomId, myId]);

  // ── Auto-scroll ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (isNearBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: messages.length > MESSAGES_PER_PAGE ? 'smooth' : 'instant' });
    }
  }, [messages, otherTyping]);

  // ── Load more ─────────────────────────────────────────────────────────────
  const loadMore = useCallback(async () => {
    if (!hasMore || isLoadingMore || !oldestId) return;
    setIsLoadingMore(true);
    try {
      const { data } = await api.get(`/messages/${roomId}`, { params: { before: oldestId, limit: MESSAGES_PER_PAGE } });
      setMessages((prev) => [...data.messages, ...prev]);
      setHasMore(data.hasMore);
      setOldestId(data.oldestId);
    } catch (err) {
      console.error('[chat] Load more error:', err.message);
    } finally {
      setIsLoadingMore(false);
    }
  }, [hasMore, isLoadingMore, oldestId, roomId]);

  // ── Send ──────────────────────────────────────────────────────────────────
const handleSend = useCallback((content) => {
  if (!isConnected) return;

  // Generate a correlation token so the server echo can locate and replace
  // the optimistic bubble in local state without a duplicate appearing.
  const clientId = generateClientId();

  // Add optimistic bubble immediately for a snappy feel
  const optimistic = {
    _id:         clientId,   // temporary — replaced by server echo
    clientId,
    roomId,
    senderId:    myId,       // plain string — getSenderId() handles this correctly
    recipientId: otherUserId,
    content,
    type:        'text',
    delivered:   false,
    readAt:      null,
    createdAt:   new Date().toISOString(),
    _optimistic: true,
  };

  setMessages((prev) => [...prev, optimistic]);
  isNearBottomRef.current = true;

  // Emit to the server — sendMessage is from SocketContext and now accepts clientId
  sendMessage(roomId, content, clientId);
}, [isConnected, roomId, myId, otherUserId, sendMessage]);

  const handleTyping = useCallback((isTyping) => {
    sendTypingIndicator(roomId, isTyping);
  }, [sendTypingIndicator, roomId]);

  const handleScroll = useCallback((e) => {
    const el = e.currentTarget;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }, []);

  // ── FIX 2: use getSenderId() for the isMine check ─────────────────────────
  const groupedItems = useMemo(() => groupMessagesByDay(messages), [messages]);

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────
  if (isLoadingInit) {
    return (
      <div className="min-h-screen bg-radar-bg flex flex-col items-center justify-center gap-4">
        <div className="relative w-12 h-12">
          <span className="absolute inset-0 rounded-full border border-beacon/30 animate-ping-slow" />
          <span className="absolute inset-3 rounded-full border border-beacon animate-ping-slow [animation-delay:0.4s]" />
        </div>
        <p className="text-white/30 text-sm font-mono">Loading conversation…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-radar-bg flex flex-col items-center justify-center gap-4 p-6">
        <div className="w-12 h-12 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center">
          <AlertTriangle size={20} className="text-red-400" />
        </div>
        <p className="text-white/50 text-sm text-center">{error}</p>
        <button type="button" onClick={() => navigate(-1)} className="btn-ghost">Go back</button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-radar-bg flex flex-col">
      <ChatHeader otherUser={otherUser} isOnline={isOtherOnline} onBack={() => navigate(-1)} />

      <AnimatePresence>
        {!isConnected && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            className="flex items-center justify-center gap-2 bg-amber-500/10 border-b border-amber-500/20 px-4 py-2 text-xs text-amber-400">
            <Clock size={12} /> Reconnecting — messages will be sent when connection is restored
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex-1 overflow-y-auto px-4" onScroll={handleScroll}>
        {hasMore && <LoadMoreButton onClick={loadMore} isLoading={isLoadingMore} />}
        <MeetZoneBanner zone={meetZone} />

        {messages.length === 0 && !isLoadingInit && (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
            <div className="w-14 h-14 rounded-2xl bg-radar-elevated border border-radar-border flex items-center justify-center">
              <Zap size={22} className="text-beacon/50" />
            </div>
            <div>
              <p className="text-sm font-medium text-white/40">No messages yet</p>
              <p className="text-xs text-white/25 mt-1">Say hello to {otherUser?.name?.split(' ')[0] ?? 'them'}!</p>
            </div>
          </div>
        )}

        <AnimatePresence initial={false}>
          {groupedItems.map((item, index) => {
            if (item.type === 'separator') {
              return <DaySeparator key={`sep-${item.day}`} label={item.label} />;
            }

            // ── FIX 2: normalise senderId before comparing ─────────────────
            // getSenderId handles: plain string, populated Mongoose object,
            // ObjectId instance — all return a plain hex string for comparison.
            const isMine = getSenderId(item.senderId) === myId;

            const nextItem    = groupedItems[index + 1];
            const isLastInRun = !nextItem ||
              nextItem.type === 'separator' ||
              getSenderId(nextItem.senderId) !== getSenderId(item.senderId);

            return (
              <MessageBubble
                key={item._id}
                message={item}
                isMine={isMine}
                showAvatar={!isMine && isLastInRun}
                otherUser={otherUser}
              />
            );
          })}
        </AnimatePresence>

        <AnimatePresence>
          {otherTyping && <TypingIndicator key="typing" />}
        </AnimatePresence>

        <div ref={bottomRef} className="h-2" />
      </div>

      <MessageInput onSend={handleSend} onTyping={handleTyping} disabled={!isConnected} />
    </div>
  );
}
// import {
//   useState,
//   useEffect,
//   useRef,
//   useCallback,
//   useMemo,
// } from 'react';
// import { useParams, useNavigate } from 'react-router-dom';
// import { motion, AnimatePresence } from 'framer-motion';
// import {
//   ArrowLeft,
//   Send,
//   MapPin,
//   Radio,
//   Check,
//   CheckCheck,
//   Clock,
//   Loader2,
//   AlertTriangle,
//   ChevronUp,
//   Zap,
//   UserCheck,
// } from 'lucide-react';

// import { useSocket }  from '../context/SocketContext';
// import { useAuth }    from '../context/AuthContext';
// import api            from '../lib/api';

// // ── Constants ─────────────────────────────────────────────────────────────────
// const TYPING_DEBOUNCE_MS  = 1_500; // stop indicator after this much silence
// const MESSAGES_PER_PAGE   = 30;

// // ── Helpers ───────────────────────────────────────────────────────────────────
// function formatMessageTime(dateStr) {
//   const d = new Date(dateStr);
//   return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
// }

// function formatDayLabel(dateStr) {
//   const d   = new Date(dateStr);
//   const now = new Date();
//   const yesterday = new Date(now);
//   yesterday.setDate(now.getDate() - 1);

//   if (d.toDateString() === now.toDateString())       return 'Today';
//   if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
//   return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
// }

// // Group messages by calendar day for day-separator rendering
// function groupMessagesByDay(messages) {
//   const groups = [];
//   let currentDay = null;

//   messages.forEach((msg) => {
//     const day = new Date(msg.createdAt).toDateString();
//     if (day !== currentDay) {
//       currentDay = day;
//       groups.push({ type: 'separator', day, label: formatDayLabel(msg.createdAt) });
//     }
//     groups.push({ type: 'message', ...msg });
//   });

//   return groups;
// }

// // ─────────────────────────────────────────────────────────────────────────────
// // SUB-COMPONENTS
// // ─────────────────────────────────────────────────────────────────────────────

// // ── Message bubble ────────────────────────────────────────────────────────────
// function MessageBubble({ message, isMine, showAvatar, otherUser }) {
//   const isRequest = message.type === 'connect_request';
//   const isAccept  = message.type === 'connect_accept';
//   const isSystem  = message.type === 'system' || isAccept;

//   // ── System / connect_accept messages ──────────────────────────────────────
//   if (isSystem) {
//     return (
//       <div className="flex justify-center my-2">
//         <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-radar-elevated border border-radar-border">
//           <UserCheck size={12} className="text-beacon" />
//           <span className="text-xs text-white/40">{message.content}</span>
//         </div>
//       </div>
//     );
//   }

//   // ── Connection request card ────────────────────────────────────────────────
//   if (isRequest) {
//     return (
//       <div className={`flex ${isMine ? 'justify-end' : 'justify-start'} mb-2`}>
//         <div
//           className="max-w-[78%] rounded-2xl border border-beacon/20 bg-beacon/5 p-4 flex flex-col gap-2"
//         >
//           <div className="flex items-center gap-2 text-beacon">
//             <Zap size={14} />
//             <span className="text-xs font-semibold uppercase tracking-wider">
//               Connection request
//             </span>
//           </div>
//           {message.content && (
//             <p className="text-sm text-white/80 leading-relaxed">{message.content}</p>
//           )}
//           <p className="text-[10px] text-white/30">{formatMessageTime(message.createdAt)}</p>
//         </div>
//       </div>
//     );
//   }

//   // ── Regular text message ──────────────────────────────────────────────────
//   return (
//     <motion.div
//       initial={{ opacity: 0, y: 6 }}
//       animate={{ opacity: 1, y: 0 }}
//       transition={{ duration: 0.2 }}
//       className={`flex items-end gap-2 mb-1 ${isMine ? 'flex-row-reverse' : 'flex-row'}`}
//     >
//       {/* Other user avatar — shown on the first message in a run */}
//       <div className="w-7 flex-shrink-0 self-end">
//         {!isMine && showAvatar && (
//           <div className="w-7 h-7 rounded-full bg-radar-elevated border border-radar-border flex items-center justify-center text-xs font-semibold text-white/60">
//             {otherUser?.avatar
//               ? <img src={otherUser.avatar} alt="" className="w-full h-full rounded-full object-cover" />
//               : otherUser?.name?.[0]?.toUpperCase() ?? '?'}
//           </div>
//         )}
//       </div>

//       {/* Bubble */}
//       <div
//         className={`
//           max-w-[75%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed
//           ${isMine
//             ? 'bg-beacon text-radar-bg rounded-br-sm font-medium'
//             : 'bg-radar-elevated text-white border border-radar-border rounded-bl-sm'}
//         `}
//       >
//         <p className="break-words whitespace-pre-wrap">{message.content}</p>
//       </div>

//       {/* Timestamp + read receipt (own messages only) */}
//       {isMine && (
//         <div className="flex flex-col items-end gap-0.5 flex-shrink-0 self-end pb-0.5">
//           <span className="text-[10px] text-white/25 font-mono">
//             {formatMessageTime(message.createdAt)}
//           </span>
//           <span className="text-[10px]">
//             {message.readAt ? (
//               <CheckCheck size={12} className="text-beacon" />
//             ) : message.delivered ? (
//               <CheckCheck size={12} className="text-white/25" />
//             ) : (
//               <Check size={12} className="text-white/20" />
//             )}
//           </span>
//         </div>
//       )}

//       {/* Timestamp (other user messages) */}
//       {!isMine && (
//         <span className="text-[10px] text-white/25 font-mono self-end pb-0.5 flex-shrink-0">
//           {formatMessageTime(message.createdAt)}
//         </span>
//       )}
//     </motion.div>
//   );
// }

// // ── Typing indicator ──────────────────────────────────────────────────────────
// function TypingIndicator() {
//   return (
//     <motion.div
//       initial={{ opacity: 0, y: 6 }}
//       animate={{ opacity: 1, y: 0 }}
//       exit={{ opacity: 0, y: 6 }}
//       className="flex items-end gap-2 mb-2"
//     >
//       <div className="w-7" /> {/* spacer matches avatar width */}
//       <div className="px-4 py-3 rounded-2xl rounded-bl-sm bg-radar-elevated border border-radar-border">
//         <div className="flex gap-1 items-center h-3">
//           {[0, 1, 2].map((i) => (
//             <motion.span
//               key={i}
//               className="w-1.5 h-1.5 rounded-full bg-white/40"
//               animate={{ y: [0, -4, 0] }}
//               transition={{
//                 duration:   0.7,
//                 repeat:     Infinity,
//                 delay:      i * 0.15,
//                 ease:       'easeInOut',
//               }}
//             />
//           ))}
//         </div>
//       </div>
//     </motion.div>
//   );
// }

// // ── Day separator ─────────────────────────────────────────────────────────────
// function DaySeparator({ label }) {
//   return (
//     <div className="flex items-center gap-3 my-4">
//       <div className="flex-1 h-px bg-radar-border" />
//       <span className="text-[10px] text-white/30 font-mono uppercase tracking-wider px-2">
//         {label}
//       </span>
//       <div className="flex-1 h-px bg-radar-border" />
//     </div>
//   );
// }

// // ── Chat header ───────────────────────────────────────────────────────────────
// function ChatHeader({ otherUser, isOnline, onBack }) {
//   return (
//     <header className="flex items-center gap-3 px-4 py-3 bg-radar-surface border-b border-radar-border flex-shrink-0">
//       <button
//         type="button"
//         onClick={onBack}
//         className="w-8 h-8 rounded-lg text-white/40 hover:text-white hover:bg-radar-elevated transition-colors flex items-center justify-center flex-shrink-0"
//         aria-label="Back"
//       >
//         <ArrowLeft size={18} />
//       </button>

//       {/* Avatar */}
//       <div className="relative flex-shrink-0">
//         <div className="w-9 h-9 rounded-xl bg-radar-elevated border border-radar-border flex items-center justify-center text-sm font-semibold text-white/70">
//           {otherUser?.avatar
//             ? <img src={otherUser.avatar} alt="" className="w-full h-full rounded-xl object-cover" />
//             : otherUser?.name?.[0]?.toUpperCase() ?? '?'}
//         </div>
//         {/* Online dot */}
//         <span
//           className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-radar-surface"
//           style={{ background: isOnline ? '#00f5c4' : '#444' }}
//         />
//       </div>

//       {/* Name and status */}
//       <div className="flex-1 min-w-0">
//         <p className="text-sm font-semibold text-white truncate">
//           {otherUser?.name ?? 'Loading…'}
//         </p>
//         <div className="flex items-center gap-1.5">
//           {isOnline ? (
//             <>
//               <Radio size={10} className="text-beacon" />
//               <span className="text-[11px] text-beacon">Online</span>
//             </>
//           ) : (
//             <span className="text-[11px] text-white/30">Offline</span>
//           )}
//         </div>
//       </div>

//       {/* Tags */}
//       {otherUser?.tags?.length > 0 && (
//         <div className="hidden sm:flex gap-1 flex-shrink-0">
//           {otherUser.tags.slice(0, 2).map((tag) => (
//             <span
//               key={tag}
//               className="badge bg-radar-elevated text-white/40 border border-radar-border text-[10px]"
//             >
//               {tag}
//             </span>
//           ))}
//         </div>
//       )}
//     </header>
//   );
// }

// // ── Load more button ───────────────────────────────────────────────────────────
// function LoadMoreButton({ onClick, isLoading }) {
//   return (
//     <div className="flex justify-center py-3">
//       <button
//         type="button"
//         onClick={onClick}
//         disabled={isLoading}
//         className="flex items-center gap-2 text-xs text-white/40 hover:text-white/70 transition-colors px-4 py-2 rounded-full border border-radar-border hover:border-radar-ring"
//       >
//         {isLoading
//           ? <Loader2 size={12} className="animate-spin" />
//           : <ChevronUp size={12} />}
//         {isLoading ? 'Loading…' : 'Load earlier messages'}
//       </button>
//     </div>
//   );
// }

// // ── Message input bar ─────────────────────────────────────────────────────────
// function MessageInput({ onSend, onTyping, disabled }) {
//   const [text,        setText]        = useState('');
//   const [isSending,   setIsSending]   = useState(false);
//   const textareaRef   = useRef(null);
//   const typingTimerRef = useRef(null);

//   const handleChange = (e) => {
//     setText(e.target.value);

//     // Grow textarea up to 5 lines
//     const el = textareaRef.current;
//     if (el) {
//       el.style.height = 'auto';
//       el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
//     }

//     // Notify parent of typing (debounced stop)
//     onTyping(true);
//     if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
//     typingTimerRef.current = setTimeout(() => onTyping(false), TYPING_DEBOUNCE_MS);
//   };

//   const handleSend = async () => {
//     const content = text.trim();
//     if (!content || isSending || disabled) return;

//     setIsSending(true);
//     setText('');
//     if (textareaRef.current) textareaRef.current.style.height = 'auto';
//     onTyping(false);
//     if (typingTimerRef.current) clearTimeout(typingTimerRef.current);

//     try {
//       await onSend(content);
//     } finally {
//       setIsSending(false);
//       textareaRef.current?.focus();
//     }
//   };

//   const handleKeyDown = (e) => {
//     // Send on Enter (not Shift+Enter — that inserts a newline)
//     if (e.key === 'Enter' && !e.shiftKey) {
//       e.preventDefault();
//       handleSend();
//     }
//   };

//   const canSend = text.trim().length > 0 && !disabled;

//   return (
//     <div className="flex-shrink-0 px-4 py-3 bg-radar-surface border-t border-radar-border">
//       <div className="flex items-end gap-2 bg-radar-elevated border border-radar-border rounded-2xl px-4 py-2.5 focus-within:border-beacon transition-colors duration-150">
//         <textarea
//           ref={textareaRef}
//           value={text}
//           onChange={handleChange}
//           onKeyDown={handleKeyDown}
//           placeholder={disabled ? 'Connecting…' : 'Type a message…'}
//           disabled={disabled}
//           rows={1}
//           className="flex-1 bg-transparent text-white text-sm placeholder-white/25 outline-none resize-none leading-relaxed max-h-[120px] disabled:opacity-40"
//           style={{ minHeight: '24px' }}
//         />
//         <motion.button
//           type="button"
//           onClick={handleSend}
//           disabled={!canSend}
//           whileTap={canSend ? { scale: 0.9 } : {}}
//           className={`
//             flex-shrink-0 w-8 h-8 rounded-xl flex items-center justify-center transition-all duration-150
//             ${canSend
//               ? 'bg-beacon text-radar-bg shadow-beacon hover:bg-beacon-dim'
//               : 'bg-radar-surface text-white/20 cursor-not-allowed'}
//           `}
//           aria-label="Send message"
//         >
//           {isSending
//             ? <Loader2 size={15} className="animate-spin" />
//             : <Send size={15} />}
//         </motion.button>
//       </div>
//       <p className="text-[10px] text-white/20 text-center mt-1.5">
//         Enter to send · Shift+Enter for new line
//       </p>
//     </div>
//   );
// }

// // ── Meet zone banner ──────────────────────────────────────────────────────────
// // Shown at the very top of the conversation — a small contextual note about
// // where the two users first connected.
// function MeetZoneBanner({ zone }) {
//   if (!zone) return null;
//   return (
//     <div className="flex justify-center pt-6 pb-2">
//       <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-radar-elevated border border-radar-border">
//         <MapPin size={11} className="text-beacon" />
//         <span className="text-[11px] text-white/40">
//           You connected at <span className="text-white/60">{zone}</span>
//         </span>
//       </div>
//     </div>
//   );
// }

// // ─────────────────────────────────────────────────────────────────────────────
// // MAIN PAGE
// // ─────────────────────────────────────────────────────────────────────────────
// export default function ChatPage() {
//   const { roomId }   = useParams();
//   const navigate     = useNavigate();
//   const { user }     = useAuth();
//   const {
//     isConnected,
//     onEvent,
//     joinRoom,
//     sendMessage,
//     sendTypingIndicator,
//     markRoomRead,
//     nearbyUsers,
//   } = useSocket();

//   // ── State ──────────────────────────────────────────────────────────────────
//   const [messages,      setMessages]      = useState([]);
//   const [otherUser,     setOtherUser]     = useState(null);
//   const [isLoadingInit, setIsLoadingInit] = useState(true);
//   const [isLoadingMore, setIsLoadingMore] = useState(false);
//   const [hasMore,       setHasMore]       = useState(false);
//   const [oldestId,      setOldestId]      = useState(null);
//   const [otherTyping,   setOtherTyping]   = useState(false);
//   const [error,         setError]         = useState(null);
//   const [meetZone,      setMeetZone]      = useState(null);

//   // ── Refs ───────────────────────────────────────────────────────────────────
//   const bottomRef        = useRef(null);
//   const typingTimerRef   = useRef(null);
//   const isNearBottomRef  = useRef(true); // track scroll position before auto-scroll

//   // ── Derive whether the other user is currently online ─────────────────────
//   const otherUserId = useMemo(() => {
//     if (!roomId) return null;
//     const parts = roomId.split('_');
//     return parts.find((id) => id !== user?._id?.toString()) ?? null;
//   }, [roomId, user]);

//   const isOtherOnline = useMemo(() => {
//     return nearbyUsers.some((u) => u.userId?.toString() === otherUserId);
//   }, [nearbyUsers, otherUserId]);

//   // ── Load initial message history ───────────────────────────────────────────
//   useEffect(() => {
//     if (!roomId) return;

//     let cancelled = false;

//     const load = async () => {
//       setIsLoadingInit(true);
//       setError(null);

//       try {
//         const { data } = await api.get(`/messages/${roomId}`, {
//           params: { limit: MESSAGES_PER_PAGE },
//         });

//         if (cancelled) return;

//         setMessages(data.messages);
//         setOtherUser(data.otherUser);
//         setHasMore(data.hasMore);
//         setOldestId(data.oldestId);

//         // Extract meet zone from the first connect_request message
//         const requestMsg = data.messages.find((m) => m.type === 'connect_request');
//         if (requestMsg?.meetZone) setMeetZone(requestMsg.meetZone);
//       } catch (err) {
//         if (!cancelled) {
//           setError('Failed to load conversation. Please go back and try again.');
//           console.error('[chat] History load error:', err.message);
//         }
//       } finally {
//         if (!cancelled) setIsLoadingInit(false);
//       }
//     };

//     load();
//     return () => { cancelled = true; };
//   }, [roomId]);

//   // ── Join Socket.io room and mark messages read ──────────────────────────────
//   useEffect(() => {
//     if (!roomId || !isConnected) return;

//     joinRoom(roomId);
//     markRoomRead(roomId);
//   }, [roomId, isConnected, joinRoom, markRoomRead]);

//   // ── Listen for incoming chat messages ──────────────────────────────────────
//   useEffect(() => {
//     const cleanup = onEvent('chat:message', (msg) => {
//       if (msg.roomId !== roomId) return;

//       setMessages((prev) => {
//         // Deduplicate — the sender's own message is echoed back from the server
//         // so the optimistic UI update and the server confirmation can both arrive
//         if (prev.some((m) => m._id?.toString() === msg._id?.toString())) return prev;
//         return [...prev, msg];
//       });

//       // Mark as read immediately if the chat window is open
//       if (msg.recipientId?.toString() === user?._id?.toString()) {
//         markRoomRead(roomId);
//       }
//     });
//     return cleanup;
//   }, [onEvent, roomId, user, markRoomRead]);

//   // ── Listen for read receipts ───────────────────────────────────────────────
//   useEffect(() => {
//     const cleanup = onEvent('chat:read_receipt', ({ roomId: rid, readAt }) => {
//       if (rid !== roomId) return;
//       // Stamp all sent (unread) messages with the read timestamp
//       setMessages((prev) =>
//         prev.map((m) =>
//           m.senderId?.toString() === user?._id?.toString() && !m.readAt
//             ? { ...m, readAt }
//             : m
//         )
//       );
//     });
//     return cleanup;
//   }, [onEvent, roomId, user]);

//   // ── Listen for typing indicators ───────────────────────────────────────────
//   useEffect(() => {
//     const cleanup = onEvent('chat:typing', ({ roomId: rid, fromUserId, isTyping }) => {
//       if (rid !== roomId) return;
//       if (fromUserId === user?._id?.toString()) return; // ignore own events

//       setOtherTyping(isTyping);

//       // Auto-clear after 3s in case the stop event is missed
//       if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
//       if (isTyping) {
//         typingTimerRef.current = setTimeout(() => setOtherTyping(false), 3_000);
//       }
//     });
//     return cleanup;
//   }, [onEvent, roomId, user]);

//   // ── Auto-scroll to bottom on new messages ─────────────────────────────────
//   useEffect(() => {
//     if (isNearBottomRef.current) {
//       bottomRef.current?.scrollIntoView({ behavior: messages.length > MESSAGES_PER_PAGE ? 'smooth' : 'instant' });
//     }
//   }, [messages, otherTyping]);

//   // ── Load more (older) messages ─────────────────────────────────────────────
//   const loadMore = useCallback(async () => {
//     if (!hasMore || isLoadingMore || !oldestId) return;

//     setIsLoadingMore(true);
//     try {
//       const { data } = await api.get(`/messages/${roomId}`, {
//         params: { before: oldestId, limit: MESSAGES_PER_PAGE },
//       });

//       setMessages((prev) => [...data.messages, ...prev]);
//       setHasMore(data.hasMore);
//       setOldestId(data.oldestId);
//     } catch (err) {
//       console.error('[chat] Load more error:', err.message);
//     } finally {
//       setIsLoadingMore(false);
//     }
//   }, [hasMore, isLoadingMore, oldestId, roomId]);

//   // ── Handle send ────────────────────────────────────────────────────────────
//   const handleSend = useCallback((content) => {
//     if (!isConnected) return;

//     // Optimistic update — add the message locally immediately so the UI feels
//     // instant. The server echo will arrive shortly and be deduplicated.
//     const optimistic = {
//       _id:         `optimistic-${Date.now()}`,
//       roomId,
//       senderId:    user._id,
//       recipientId: otherUserId,
//       content,
//       type:        'text',
//       delivered:   false,
//       readAt:      null,
//       createdAt:   new Date().toISOString(),
//       _optimistic: true,
//     };

//     setMessages((prev) => [...prev, optimistic]);
//     isNearBottomRef.current = true;

//     // Actual send via socket
//     sendMessage(roomId, content);
//   }, [isConnected, roomId, sendMessage, user, otherUserId]);

//   // ── Handle typing ──────────────────────────────────────────────────────────
//   const handleTyping = useCallback((isTyping) => {
//     sendTypingIndicator(roomId, isTyping);
//   }, [sendTypingIndicator, roomId]);

//   // ── Track scroll position ──────────────────────────────────────────────────
//   const handleScroll = useCallback((e) => {
//     const el = e.currentTarget;
//     const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
//     isNearBottomRef.current = distFromBottom < 120;
//   }, []);

//   // ── Grouped message items for rendering ────────────────────────────────────
//   const groupedItems = useMemo(() => groupMessagesByDay(messages), [messages]);

//   // ─────────────────────────────────────────────────────────────────────────
//   // RENDER
//   // ─────────────────────────────────────────────────────────────────────────

//   if (isLoadingInit) {
//     return (
//       <div className="min-h-screen bg-radar-bg flex flex-col items-center justify-center gap-4">
//         <div className="relative w-12 h-12">
//           <span className="absolute inset-0 rounded-full border border-beacon/30 animate-ping-slow" />
//           <span className="absolute inset-3 rounded-full border border-beacon animate-ping-slow [animation-delay:0.4s]" />
//         </div>
//         <p className="text-white/30 text-sm font-mono">Loading conversation…</p>
//       </div>
//     );
//   }

//   if (error) {
//     return (
//       <div className="min-h-screen bg-radar-bg flex flex-col items-center justify-center gap-4 p-6">
//         <div className="w-12 h-12 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center">
//           <AlertTriangle size={20} className="text-red-400" />
//         </div>
//         <p className="text-white/50 text-sm text-center">{error}</p>
//         <button type="button" onClick={() => navigate(-1)} className="btn-ghost">
//           Go back
//         </button>
//       </div>
//     );
//   }

//   return (
//     <div className="min-h-screen bg-radar-bg flex flex-col">
//       {/* Header */}
//       <ChatHeader
//         otherUser={otherUser}
//         isOnline={isOtherOnline}
//         onBack={() => navigate(-1)}
//       />

//       {/* Connection warning banner */}
//       <AnimatePresence>
//         {!isConnected && (
//           <motion.div
//             initial={{ height: 0, opacity: 0 }}
//             animate={{ height: 'auto', opacity: 1 }}
//             exit={{ height: 0, opacity: 0 }}
//             className="flex items-center justify-center gap-2 bg-amber-500/10 border-b border-amber-500/20 px-4 py-2 text-xs text-amber-400"
//           >
//             <Clock size={12} />
//             Reconnecting — messages will be sent when connection is restored
//           </motion.div>
//         )}
//       </AnimatePresence>

//       {/* Message list */}
//       <div
//         className="flex-1 overflow-y-auto px-4"
//         onScroll={handleScroll}
//       >
//         {/* Load more */}
//         {hasMore && (
//           <LoadMoreButton onClick={loadMore} isLoading={isLoadingMore} />
//         )}

//         {/* Meet zone context */}
//         <MeetZoneBanner zone={meetZone} />

//         {/* Empty state */}
//         {messages.length === 0 && !isLoadingInit && (
//           <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
//             <div className="w-14 h-14 rounded-2xl bg-radar-elevated border border-radar-border flex items-center justify-center">
//               <Zap size={22} className="text-beacon/50" />
//             </div>
//             <div>
//               <p className="text-sm font-medium text-white/40">No messages yet</p>
//               <p className="text-xs text-white/25 mt-1">
//                 Say hello to {otherUser?.name?.split(' ')[0] ?? 'them'}!
//               </p>
//             </div>
//           </div>
//         )}

//         {/* Messages */}
//         <AnimatePresence initial={false}>
//           {groupedItems.map((item, index) => {
//             if (item.type === 'separator') {
//               return <DaySeparator key={`sep-${item.day}`} label={item.label} />;
//             }

//             const isMine = item.senderId?.toString() === user?._id?.toString();

//             // Show avatar on the last message in a consecutive run from the other user
//             const nextItem   = groupedItems[index + 1];
//             const isLastInRun = !nextItem ||
//               nextItem.type === 'separator' ||
//               nextItem.senderId?.toString() !== item.senderId?.toString();

//             return (
//               <MessageBubble
//                 key={item._id}
//                 message={item}
//                 isMine={isMine}
//                 showAvatar={!isMine && isLastInRun}
//                 otherUser={otherUser}
//               />
//             );
//           })}
//         </AnimatePresence>

//         {/* Typing indicator */}
//         <AnimatePresence>
//           {otherTyping && <TypingIndicator key="typing" />}
//         </AnimatePresence>

//         {/* Invisible scroll anchor */}
//         <div ref={bottomRef} className="h-2" />
//       </div>

//       {/* Input */}
//       <MessageInput
//         onSend={handleSend}
//         onTyping={handleTyping}
//         disabled={!isConnected}
//       />
//     </div>
//   );
// }