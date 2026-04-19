import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate }    from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  Zap,
  MessageCircle,
  Check,
  UserX,
  Clock,
  MapPin,
  ChevronRight,
  Loader2,
  Inbox,
  Bell,
  RefreshCw,
} from 'lucide-react';

import { useSocket } from '../context/SocketContext';
import { useAuth }   from '../context/AuthContext';
import api           from '../lib/api';

// ── Helpers ───────────────────────────────────────────────────────────────────
function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60)   return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60)   return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)   return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatPreview(message, isMine) {
  if (!message) return '';
  const prefix = isMine ? 'You: ' : '';
  const content = message.content ?? '';
  if (message.type === 'connect_request') return `${prefix}Connection request`;
  if (message.type === 'connect_accept')  return '✓ Connected';
  return `${prefix}${content.slice(0, 55)}${content.length > 55 ? '…' : ''}`;
}

// ── Connection request card ────────────────────────────────────────────────────
function RequestCard({ request, onAccept, onDecline, isActing }) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8, scale: 0.97 }}
      animate={{ opacity: 1, y: 0,  scale: 1 }}
      exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.15 } }}
      className="card p-4 flex flex-col gap-3 border-beacon/20"
    >
      {/* User info row */}
      <div className="flex items-start gap-3">
        {/* Avatar */}
        <div className="w-11 h-11 rounded-xl bg-beacon/10 border border-beacon/20 flex items-center justify-center text-base font-semibold text-beacon flex-shrink-0">
          {request.fromAvatar
            ? <img src={request.fromAvatar} alt="" className="w-full h-full rounded-xl object-cover" />
            : request.fromName?.[0]?.toUpperCase() ?? '?'}
        </div>

        {/* Name + meta */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-white truncate">
              {request.fromName}
            </p>
            <span className="text-[10px] text-white/30 font-mono flex-shrink-0">
              {timeAgo(request.sentAt || request.receivedAt)}
            </span>
          </div>
          {request.fromBio && (
            <p className="text-xs text-white/40 mt-0.5 line-clamp-1">{request.fromBio}</p>
          )}
          {/* Tags */}
          {request.fromTags?.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {request.fromTags.slice(0, 4).map((tag) => (
                <span
                  key={tag}
                  className="badge bg-radar-elevated text-white/40 border border-radar-border text-[10px]"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Message content */}
      {request.message && (
        <div className="px-3 py-2.5 rounded-xl bg-radar-elevated border border-radar-border">
          <p className="text-sm text-white/70 leading-relaxed italic">
            "{request.message}"
          </p>
        </div>
      )}

      {/* Accept / Decline */}
      <div className="flex gap-2">
        <motion.button
          type="button"
          whileTap={{ scale: 0.96 }}
          onClick={() => onDecline(request.fromUserId, request.messageId)}
          disabled={isActing}
          className="flex-1 h-9 btn-ghost flex items-center justify-center gap-1.5 text-sm"
        >
          {isActing ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <>
              <UserX size={14} />
              Decline
            </>
          )}
        </motion.button>

        <motion.button
          type="button"
          whileTap={{ scale: 0.96 }}
          onClick={() => onAccept(request.fromUserId, request.messageId)}
          disabled={isActing}
          className="flex-2 h-9 btn-primary flex items-center justify-center gap-1.5 text-sm px-6"
        >
          {isActing ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <>
              <Check size={14} />
              Accept
            </>
          )}
        </motion.button>
      </div>
    </motion.div>
  );
}

// ── Conversation row ───────────────────────────────────────────────────────────
function ConversationRow({ conversation, currentUserId, onOpen }) {
  const { otherUser, lastMessage, unreadCount, roomId } = conversation;
  const isMine = lastMessage?.senderId?.toString() === currentUserId?.toString();

  return (
    <motion.button
      type="button"
      layout
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0 }}
      onClick={() => onOpen(roomId)}
      className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-radar-elevated transition-colors duration-150 text-left group"
    >
      {/* Avatar */}
      <div className="relative flex-shrink-0">
        <div className="w-11 h-11 rounded-xl bg-radar-elevated border border-radar-border flex items-center justify-center text-sm font-semibold text-white/60">
          {otherUser?.avatar
            ? <img src={otherUser.avatar} alt="" className="w-full h-full rounded-xl object-cover" />
            : otherUser?.name?.[0]?.toUpperCase() ?? '?'}
        </div>
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] rounded-full bg-beacon text-radar-bg text-[10px] font-bold flex items-center justify-center px-1">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </div>

      {/* Text */}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between gap-2">
          <p className={`text-sm truncate ${unreadCount > 0 ? 'font-semibold text-white' : 'font-medium text-white/80'}`}>
            {otherUser?.name ?? 'Unknown'}
          </p>
          {lastMessage?.createdAt && (
            <span className="text-[10px] text-white/30 font-mono flex-shrink-0">
              {timeAgo(lastMessage.createdAt)}
            </span>
          )}
        </div>
        <p className={`text-xs truncate mt-0.5 ${unreadCount > 0 ? 'text-white/60' : 'text-white/35'}`}>
          {formatPreview(lastMessage, isMine)}
        </p>
      </div>

      <ChevronRight
        size={16}
        className="text-white/20 group-hover:text-white/50 transition-colors flex-shrink-0"
      />
    </motion.button>
  );
}

// ── Empty state ────────────────────────────────────────────────────────────────
function EmptyState({ icon: Icon, title, body }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3 text-center px-6">
      <div className="w-14 h-14 rounded-2xl bg-radar-elevated border border-radar-border flex items-center justify-center">
        <Icon size={22} className="text-white/20" />
      </div>
      <div>
        <p className="text-sm font-medium text-white/40">{title}</p>
        <p className="text-xs text-white/25 mt-1 leading-relaxed">{body}</p>
      </div>
    </div>
  );
}

// ── Tab button ─────────────────────────────────────────────────────────────────
function TabButton({ active, onClick, children, badge }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        relative flex-1 py-2.5 text-sm font-medium transition-all duration-200
        ${active
          ? 'text-white border-b-2 border-beacon'
          : 'text-white/40 border-b-2 border-transparent hover:text-white/70'}
      `}
    >
      {children}
      {badge > 0 && (
        <span className="ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] rounded-full bg-beacon text-radar-bg text-[10px] font-bold px-1">
          {badge > 9 ? '9+' : badge}
        </span>
      )}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
export default function InboxDrawer({ isOpen, onClose }) {
  const navigate     = useNavigate();
  const { user }     = useAuth();
  const {
    pendingIncomingRequests,
    acceptConnectionRequest,
    declineConnectionRequest,
    onEvent,
  } = useSocket();

  // ── Tab state ──────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState('requests');

  // ── Conversations state ────────────────────────────────────────────────────
  const [conversations,      setConversations]      = useState([]);
  const [isLoadingConvos,    setIsLoadingConvos]    = useState(false);
  const [convoError,         setConvoError]         = useState(null);
  const [lastFetchedAt,      setLastFetchedAt]      = useState(null);

  // ── Per-request acting state ───────────────────────────────────────────────
  // Tracks which request IDs are in the middle of an accept/decline action
  // so we can show a spinner on the right card without blocking the others.
  const [actingOn, setActingOn] = useState(new Set());

  const hasFetchedRef = useRef(false);

  // ── Fetch conversations when Messages tab is opened ────────────────────────
  const fetchConversations = useCallback(async () => {
    setIsLoadingConvos(true);
    setConvoError(null);
    try {
      const { data } = await api.get('/messages/inbox');
      setConversations(data.conversations ?? []);
      setLastFetchedAt(new Date());
    } catch (err) {
      console.error('[inbox] Failed to load conversations:', err.message);
      setConvoError('Failed to load conversations.');
    } finally {
      setIsLoadingConvos(false);
    }
  }, []);

  // Fetch on first open and whenever the user switches to Messages tab
  useEffect(() => {
    if (!isOpen) return;

    if (activeTab === 'messages') {
      fetchConversations();
    } else if (!hasFetchedRef.current) {
      // Pre-fetch conversations in the background on first drawer open
      // so the Messages tab feels instant when the user switches to it.
      hasFetchedRef.current = true;
      fetchConversations();
    }
  }, [isOpen, activeTab, fetchConversations]);

  // ── Live inbox updates: refresh conversations on new chat:message ─────────
  // When a new message arrives while the drawer is open, refetch the inbox
  // so the preview and unread count stay current.
  useEffect(() => {
    if (!isOpen) return;
    const cleanup = onEvent('chat:message', () => {
      // Debounce: only refetch if the last fetch was more than 3s ago
      if (!lastFetchedAt || Date.now() - lastFetchedAt > 3_000) {
        fetchConversations();
      }
    });
    return cleanup;
  }, [isOpen, onEvent, fetchConversations, lastFetchedAt]);

  // ── Update conversation list when a new connection is accepted ────────────
  useEffect(() => {
    if (!isOpen) return;
    const cleanup = onEvent('connect:accepted', () => {
      fetchConversations();
    });
    return cleanup;
  }, [isOpen, onEvent, fetchConversations]);

  // ── Switch to requests tab automatically when a new request arrives ────────
  useEffect(() => {
    if (isOpen && pendingIncomingRequests.length > 0) {
      setActiveTab('requests');
    }
  }, [isOpen, pendingIncomingRequests.length]);

  // ── Handle accept ─────────────────────────────────────────────────────────
  const handleAccept = useCallback(async (fromUserId, messageId) => {
    setActingOn((prev) => new Set([...prev, messageId]));
    try {
      acceptConnectionRequest(fromUserId, messageId);
      // After accepting, immediately switch to Messages tab and refresh —
      // the new conversation will appear there.
      setTimeout(() => {
        setActiveTab('messages');
        fetchConversations();
      }, 400);
    } finally {
      setActingOn((prev) => {
        const next = new Set(prev);
        next.delete(messageId);
        return next;
      });
    }
  }, [acceptConnectionRequest, fetchConversations]);

  // ── Handle decline ────────────────────────────────────────────────────────
  const handleDecline = useCallback((fromUserId, messageId) => {
    setActingOn((prev) => new Set([...prev, messageId]));
    declineConnectionRequest(fromUserId, messageId);
    // Remove from acting set after animation
    setTimeout(() => {
      setActingOn((prev) => {
        const next = new Set(prev);
        next.delete(messageId);
        return next;
      });
    }, 400);
  }, [declineConnectionRequest]);

  // ── Navigate to chat ──────────────────────────────────────────────────────
  const handleOpenConversation = useCallback((roomId) => {
    onClose();
    navigate(`/chat/${roomId}`);
  }, [navigate, onClose]);

  // ── Close on Escape ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  // ── Unread totals for tab badges ──────────────────────────────────────────
  const requestBadge = pendingIncomingRequests.length;
  const messageBadge = conversations.reduce((sum, c) => sum + (c.unreadCount ?? 0), 0);

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-40"
            style={{ background: 'rgba(5,13,26,0.7)' }}
            onClick={onClose}
            aria-hidden="true"
          />

          {/* Drawer panel — slides in from the right */}
          <motion.div
            key="drawer"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 320, damping: 32 }}
            className="fixed right-0 top-0 bottom-0 z-50 w-full max-w-sm flex flex-col bg-radar-surface border-l border-radar-border shadow-card"
            role="dialog"
            aria-modal="true"
            aria-label="Inbox"
          >
            {/* ── Header ─────────────────────────────────────────────── */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-radar-border flex-shrink-0">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-beacon/10 border border-beacon/20 flex items-center justify-center">
                  <Inbox size={14} className="text-beacon" />
                </div>
                <h2 className="text-base font-semibold text-white">Inbox</h2>
              </div>

              <div className="flex items-center gap-2">
                {/* Refresh button (Messages tab only) */}
                {activeTab === 'messages' && (
                  <button
                    type="button"
                    onClick={fetchConversations}
                    disabled={isLoadingConvos}
                    className="w-8 h-8 rounded-lg text-white/30 hover:text-white/70 hover:bg-radar-elevated transition-colors flex items-center justify-center"
                    aria-label="Refresh conversations"
                  >
                    <RefreshCw
                      size={14}
                      className={isLoadingConvos ? 'animate-spin' : ''}
                    />
                  </button>
                )}

                {/* Close */}
                <button
                  type="button"
                  onClick={onClose}
                  className="w-8 h-8 rounded-lg text-white/30 hover:text-white/70 hover:bg-radar-elevated transition-colors flex items-center justify-center"
                  aria-label="Close inbox"
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            {/* ── Tabs ───────────────────────────────────────────────── */}
            <div className="flex border-b border-radar-border flex-shrink-0 px-2">
              <TabButton
                active={activeTab === 'requests'}
                onClick={() => setActiveTab('requests')}
                badge={requestBadge}
              >
                Requests
              </TabButton>
              <TabButton
                active={activeTab === 'messages'}
                onClick={() => setActiveTab('messages')}
                badge={messageBadge}
              >
                Messages
              </TabButton>
            </div>

            {/* ── Tab content ────────────────────────────────────────── */}
            <div className="flex-1 overflow-y-auto">
              <AnimatePresence mode="wait" initial={false}>

                {/* REQUESTS TAB */}
                {activeTab === 'requests' && (
                  <motion.div
                    key="requests"
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    transition={{ duration: 0.2 }}
                    className="p-4 flex flex-col gap-3"
                  >
                    {pendingIncomingRequests.length === 0 ? (
                      <EmptyState
                        icon={Bell}
                        title="No pending requests"
                        body="When someone on the radar sends you a connection request, it will appear here."
                      />
                    ) : (
                      <>
                        <p className="text-xs text-white/30 font-mono uppercase tracking-wider px-1">
                          {pendingIncomingRequests.length} pending
                        </p>
                        <AnimatePresence mode="popLayout">
                          {pendingIncomingRequests.map((req) => (
                            <RequestCard
                              key={req.messageId}
                              request={req}
                              onAccept={handleAccept}
                              onDecline={handleDecline}
                              isActing={actingOn.has(req.messageId)}
                            />
                          ))}
                        </AnimatePresence>
                      </>
                    )}
                  </motion.div>
                )}

                {/* MESSAGES TAB */}
                {activeTab === 'messages' && (
                  <motion.div
                    key="messages"
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    transition={{ duration: 0.2 }}
                    className="flex flex-col"
                  >
                    {isLoadingConvos && conversations.length === 0 ? (
                      <div className="flex flex-col items-center justify-center py-16 gap-3">
                        <Loader2 size={20} className="animate-spin text-white/30" />
                        <p className="text-xs text-white/30">Loading conversations…</p>
                      </div>
                    ) : convoError ? (
                      <div className="p-6 flex flex-col items-center gap-3">
                        <p className="text-sm text-red-400 text-center">{convoError}</p>
                        <button
                          type="button"
                          onClick={fetchConversations}
                          className="btn-ghost text-xs py-1.5 px-3 h-auto"
                        >
                          Retry
                        </button>
                      </div>
                    ) : conversations.length === 0 ? (
                      <EmptyState
                        icon={MessageCircle}
                        title="No conversations yet"
                        body="Accept a connection request to start chatting with people nearby."
                      />
                    ) : (
                      <>
                        {/* Refresh timestamp */}
                        {lastFetchedAt && (
                          <p className="text-[10px] text-white/20 font-mono text-center py-2">
                            Updated {timeAgo(lastFetchedAt.toISOString())}
                          </p>
                        )}
                        <AnimatePresence mode="popLayout">
                          {conversations.map((conv) => (
                            <ConversationRow
                              key={conv.roomId}
                              conversation={conv}
                              currentUserId={user?._id?.toString()}
                              onOpen={handleOpenConversation}
                            />
                          ))}
                        </AnimatePresence>
                      </>
                    )}
                  </motion.div>
                )}

              </AnimatePresence>
            </div>

            {/* ── Footer hint ─────────────────────────────────────────── */}
            <div className="flex-shrink-0 px-5 py-3 border-t border-radar-border">
              <p className="text-[10px] text-white/20 text-center leading-relaxed">
                Connection requests expire when the sender's beacon turns off
              </p>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}