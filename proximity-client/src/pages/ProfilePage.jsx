import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, Link }   from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft,
  Save,
  Loader2,
  LogOut,
  Radio,
  Users,
  Tag,
  Edit3,
  Check,
  X,
  AlertTriangle,
  Lock,
  Trash2,
  ChevronRight,
  MessageCircle,
  Eye,
  EyeOff,
  User,
  FileText,
} from 'lucide-react';

import { useAuth }   from '../context/AuthContext';
import { useSocket } from '../context/SocketContext';
import api           from '../lib/api';

// ── Helpers ───────────────────────────────────────────────────────────────────
function getInitials(name) {
  if (!name) return '?';
  return name.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 2);
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const d    = Math.floor(diff / 86_400_000);
  if (d === 0)  return 'Today';
  if (d === 1)  return 'Yesterday';
  if (d < 30)   return `${d} days ago`;
  if (d < 365)  return `${Math.floor(d / 30)} months ago`;
  return `${Math.floor(d / 365)} years ago`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

// ── Avatar ────────────────────────────────────────────────────────────────────
function Avatar({ name, avatar, size = 80 }) {
  return (
    <div
      className="rounded-2xl border-2 border-beacon/30 flex items-center justify-center flex-shrink-0 overflow-hidden"
      style={{
        width:      size,
        height:     size,
        background: 'rgba(0,245,196,0.08)',
        fontSize:   size / 2.8,
        fontWeight: 600,
        color:      '#00f5c4',
      }}
    >
      {avatar
        ? <img src={avatar} alt={name} className="w-full h-full object-cover" />
        : getInitials(name)}
    </div>
  );
}

// ── Section card ──────────────────────────────────────────────────────────────
function SectionCard({ title, icon: Icon, children, action }) {
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-radar-border">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-radar-elevated border border-radar-border flex items-center justify-center">
            <Icon size={14} className="text-white/50" />
          </div>
          <h2 className="text-sm font-semibold text-white">{title}</h2>
        </div>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

// ── Inline editable field ──────────────────────────────────────────────────────
function EditableField({ label, value, onSave, type = 'text', maxLength, placeholder, multiline }) {
  const [editing,    setEditing]    = useState(false);
  const [draft,      setDraft]      = useState(value ?? '');
  const [isSaving,   setIsSaving]   = useState(false);
  const [localError, setLocalError] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (editing) setTimeout(() => inputRef.current?.focus(), 50);
  }, [editing]);

  const handleSave = async () => {
    if (draft === value) { setEditing(false); return; }
    setIsSaving(true);
    setLocalError('');
    const result = await onSave(draft);
    if (result?.error) {
      setLocalError(result.error);
    } else {
      setEditing(false);
    }
    setIsSaving(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !multiline) { e.preventDefault(); handleSave(); }
    if (e.key === 'Escape') { setDraft(value ?? ''); setEditing(false); setLocalError(''); }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-white/40 uppercase tracking-wider">{label}</label>
        {!editing && (
          <button type="button" onClick={() => { setDraft(value ?? ''); setEditing(true); }}
            className="text-white/30 hover:text-beacon transition-colors flex items-center gap-1 text-xs">
            <Edit3 size={11} /> Edit
          </button>
        )}
      </div>

      {editing ? (
        <div className="flex flex-col gap-2">
          {multiline ? (
            <textarea ref={inputRef} value={draft} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown} maxLength={maxLength} rows={3} placeholder={placeholder}
              className="input resize-none text-sm leading-relaxed py-2.5" />
          ) : (
            <input ref={inputRef} type={type} value={draft} onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown} maxLength={maxLength} placeholder={placeholder}
              className="input text-sm" />
          )}
          {maxLength && (
            <p className="text-[10px] text-white/25 text-right">{draft.length}/{maxLength}</p>
          )}
          {localError && (
            <p className="text-xs text-red-400 flex items-center gap-1">
              <AlertTriangle size={11} />{localError}
            </p>
          )}
          <div className="flex gap-2">
            <button type="button" onClick={() => { setDraft(value ?? ''); setEditing(false); setLocalError(''); }}
              disabled={isSaving}
              className="flex-1 h-8 btn-ghost text-xs flex items-center justify-center gap-1">
              <X size={13} /> Cancel
            </button>
            <button type="button" onClick={handleSave} disabled={isSaving}
              className="flex-1 h-8 btn-primary text-xs flex items-center justify-center gap-1">
              {isSaving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
              Save
            </button>
          </div>
        </div>
      ) : (
        <p className={`text-sm leading-relaxed ${value ? 'text-white/80' : 'text-white/25 italic'}`}>
          {value || placeholder}
        </p>
      )}
    </div>
  );
}

// ── Tag editor ────────────────────────────────────────────────────────────────
function TagEditor({ tags, onSave }) {
  const [editing,  setEditing]  = useState(false);
  const [draft,    setDraft]    = useState([...(tags ?? [])]);
  const [input,    setInput]    = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [error,    setError]    = useState('');

  useEffect(() => { if (!editing) setDraft([...(tags ?? [])]); }, [tags, editing]);

  const addTag = (raw) => {
    const tag = raw.trim().toLowerCase().replace(/[^a-z0-9+#.\-]/g, '');
    if (tag && !draft.includes(tag) && draft.length < 10) {
      setDraft((p) => [...p, tag]);
    }
    setInput('');
  };

  const handleKeyDown = (e) => {
    if (['Enter', ',', ' '].includes(e.key)) { e.preventDefault(); addTag(input); }
    if (e.key === 'Backspace' && !input && draft.length > 0) {
      setDraft((p) => p.slice(0, -1));
    }
  };

  const handleSave = async () => {
    if (input.trim()) addTag(input);
    setIsSaving(true);
    setError('');
    const result = await onSave(draft);
    if (result?.error) setError(result.error);
    else setEditing(false);
    setIsSaving(false);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-white/40 uppercase tracking-wider">Skills / interests</label>
        {!editing && (
          <button type="button" onClick={() => setEditing(true)}
            className="text-white/30 hover:text-beacon transition-colors flex items-center gap-1 text-xs">
            <Edit3 size={11} /> Edit
          </button>
        )}
      </div>

      {editing ? (
        <div className="flex flex-col gap-2">
          <div className="min-h-[44px] flex flex-wrap gap-1.5 p-2 pl-3 bg-radar-elevated border border-radar-border rounded-xl
            focus-within:border-beacon focus-within:ring-1 focus-within:ring-beacon transition-colors cursor-text"
            onClick={() => document.getElementById('tag-editor-input')?.focus()}>
            {draft.map((tag, i) => (
              <span key={tag} className="flex items-center gap-1 badge bg-beacon/10 text-beacon border border-beacon/20">
                {tag}
                <button type="button" onClick={(e) => { e.stopPropagation(); setDraft((p) => p.filter((_, j) => j !== i)); }}
                  className="text-beacon/60 hover:text-beacon ml-0.5">×</button>
              </span>
            ))}
            <input id="tag-editor-input" value={input} onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown} onBlur={() => input && addTag(input)}
              placeholder={draft.length === 0 ? 'e.g. React, ML, Guitar…' : ''}
              className="flex-1 min-w-[100px] bg-transparent text-white text-sm outline-none placeholder-white/25" />
          </div>
          <p className="text-xs text-white/25">Press Enter or comma to add · {draft.length}/10 tags</p>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={() => { setDraft([...(tags ?? [])]); setEditing(false); setError(''); }}
              disabled={isSaving} className="flex-1 h-8 btn-ghost text-xs flex items-center justify-center gap-1">
              <X size={13} /> Cancel
            </button>
            <button type="button" onClick={handleSave} disabled={isSaving}
              className="flex-1 h-8 btn-primary text-xs flex items-center justify-center gap-1">
              {isSaving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
              Save
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5 min-h-[28px] items-center">
          {(tags ?? []).length > 0
            ? tags.map((tag) => (
                <span key={tag} className="badge bg-radar-elevated text-white/50 border border-radar-border">{tag}</span>
              ))
            : <span className="text-sm text-white/25 italic">No tags added yet</span>}
        </div>
      )}
    </div>
  );
}

// ── Change password form ───────────────────────────────────────────────────────
function ChangePasswordForm({ onClose }) {
  const [current,  setCurrent]  = useState('');
  const [next,     setNext]     = useState('');
  const [showCurr, setShowCurr] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error,    setError]    = useState('');
  const [success,  setSuccess]  = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!current || !next) { setError('Both fields are required.'); return; }
    if (next.length < 8)   { setError('New password must be at least 8 characters.'); return; }
    if (!/(?=.*[a-zA-Z])(?=.*\d)/.test(next)) {
      setError('Must contain at least one letter and one number.');
      return;
    }
    setIsSaving(true);
    setError('');
    try {
      await api.post('/users/me/change-password', { currentPassword: current, newPassword: next });
      setSuccess(true);
      setTimeout(onClose, 1500);
    } catch (err) {
      setError(err.response?.data?.error ?? 'Failed to change password.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }} className="overflow-hidden mt-4">
      <form onSubmit={handleSubmit} className="flex flex-col gap-3 pt-4 border-t border-radar-border">
        {/* Current password */}
        <div className="relative">
          <input type={showCurr ? 'text' : 'password'} value={current}
            onChange={(e) => setCurrent(e.target.value)} placeholder="Current password"
            className="input text-sm pr-10" autoComplete="current-password" />
          <button type="button" onClick={() => setShowCurr((p) => !p)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60">
            {showCurr ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </div>
        {/* New password */}
        <div className="relative">
          <input type={showNext ? 'text' : 'password'} value={next}
            onChange={(e) => setNext(e.target.value)} placeholder="New password (min 8 chars)"
            className="input text-sm pr-10" autoComplete="new-password" />
          <button type="button" onClick={() => setShowNext((p) => !p)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60">
            {showNext ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </div>
        {error && (
          <p className="text-xs text-red-400 flex items-center gap-1.5">
            <AlertTriangle size={12} />{error}
          </p>
        )}
        {success && (
          <p className="text-xs text-green-400 flex items-center gap-1.5">
            <Check size={12} />Password updated!
          </p>
        )}
        <div className="flex gap-2">
          <button type="button" onClick={onClose} disabled={isSaving}
            className="flex-1 h-9 btn-ghost text-sm flex items-center justify-center gap-1">
            Cancel
          </button>
          <button type="submit" disabled={isSaving}
            className="flex-1 h-9 btn-primary text-sm flex items-center justify-center gap-2">
            {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Lock size={14} />}
            Update
          </button>
        </div>
      </form>
    </motion.div>
  );
}

// ── Delete account dialog ──────────────────────────────────────────────────────
function DeleteAccountDialog({ onConfirm, onCancel, isDeleting }) {
  const [password, setPassword] = useState('');
  const [show,     setShow]     = useState(false);
  const [error,    setError]    = useState('');

  const handleConfirm = async () => {
    if (!password) { setError('Please enter your password to confirm.'); return; }
    setError('');
    const result = await onConfirm(password);
    if (result?.error) setError(result.error);
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(5,13,26,0.9)' }}>
      <motion.div initial={{ scale: 0.95, y: 12 }} animate={{ scale: 1, y: 0 }}
        className="card-elevated w-full max-w-sm p-6 flex flex-col gap-5">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center flex-shrink-0">
            <Trash2 size={18} className="text-red-400" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-white">Delete account</h2>
            <p className="text-xs text-white/40 mt-1 leading-relaxed">
              This will deactivate your account and remove your location data.
              Your chat history will remain visible to your connections.
              This cannot be undone.
            </p>
          </div>
        </div>
        <div className="relative">
          <input type={show ? 'text' : 'password'} value={password}
            onChange={(e) => setPassword(e.target.value)} placeholder="Confirm your password"
            className="input text-sm pr-10" />
          <button type="button" onClick={() => setShow((p) => !p)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-white/30 hover:text-white/60">
            {show ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </div>
        {error && (
          <p className="text-xs text-red-400 flex items-center gap-1.5">
            <AlertTriangle size={12} />{error}
          </p>
        )}
        <div className="flex gap-2">
          <button type="button" onClick={onCancel} disabled={isDeleting}
            className="flex-1 h-10 btn-ghost flex items-center justify-center">
            Cancel
          </button>
          <button type="button" onClick={handleConfirm} disabled={isDeleting}
            className="flex-1 h-10 flex items-center justify-center gap-2 bg-red-500/10 text-red-400 border border-red-500/20 rounded-xl hover:bg-red-500/20 transition-colors text-sm font-medium disabled:opacity-40">
            {isDeleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            Delete
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── Connection card ────────────────────────────────────────────────────────────
function ConnectionCard({ connection, currentUserId }) {
  const navigate  = useNavigate();
  const roomId    = [connection._id.toString(), currentUserId].sort().join('_');
  const isActive  = connection.isBeaconActive;

  return (
    <button type="button" onClick={() => navigate(`/chat/${roomId}`)}
      className="w-full flex items-center gap-3 py-3 hover:bg-radar-elevated/50 rounded-xl px-2 -mx-2 transition-colors group text-left">
      <div className="relative flex-shrink-0">
        <div className="w-10 h-10 rounded-xl bg-radar-elevated border border-radar-border flex items-center justify-center text-sm font-semibold text-white/60">
          {connection.avatar
            ? <img src={connection.avatar} alt="" className="w-full h-full rounded-xl object-cover" />
            : getInitials(connection.name)}
        </div>
        {isActive && (
          <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-beacon border-2 border-radar-surface" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-white truncate">{connection.name}</p>
        <div className="flex items-center gap-1.5 mt-0.5">
          {isActive ? (
            <><Radio size={9} className="text-beacon" /><span className="text-[10px] text-beacon">Broadcasting</span></>
          ) : (
            <span className="text-[10px] text-white/30">Offline</span>
          )}
        </div>
        {connection.tags?.length > 0 && (
          <div className="flex gap-1 mt-1 flex-wrap">
            {connection.tags.slice(0, 3).map((tag) => (
              <span key={tag} className="badge bg-radar-elevated text-white/35 border border-radar-border text-[9px]">{tag}</span>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <MessageCircle size={14} className="text-white/20 group-hover:text-white/50 transition-colors" />
        <ChevronRight size={14} className="text-white/20 group-hover:text-white/50 transition-colors" />
      </div>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN PAGE
// ─────────────────────────────────────────────────────────────────────────────
export default function ProfilePage() {
  const navigate  = useNavigate();
  const { user, logout, updateUserState } = useAuth();
  const { stopBeacon, beaconActive }      = useSocket();

  // ── State ──────────────────────────────────────────────────────────────────
  const [profile,         setProfile]         = useState(null);
  const [connections,     setConnections]      = useState([]);
  const [isLoadingInit,   setIsLoadingInit]    = useState(true);
  const [loadError,       setLoadError]        = useState(null);
  const [showPasswordForm,setShowPasswordForm] = useState(false);
  const [showDeleteDialog,setShowDeleteDialog] = useState(false);
  const [isDeleting,      setIsDeleting]       = useState(false);
  const [saveSuccess,     setSaveSuccess]      = useState('');

  // ── Load profile and connections on mount ─────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    (async () => {
      setIsLoadingInit(true);
      setLoadError(null);
      try {
        const [profileRes, connectionsRes] = await Promise.all([
          api.get('/users/me'),
          api.get('/users/connections'),
        ]);
        if (cancelled) return;
        setProfile(profileRes.data.user);
        setConnections(connectionsRes.data.connections ?? []);
      } catch (err) {
        if (!cancelled) setLoadError('Failed to load profile. Please try again.');
        console.error('[profile] Load error:', err.message);
      } finally {
        if (!cancelled) setIsLoadingInit(false);
      }
    })();

    return () => { cancelled = true; };
  }, []);

  // ── Flash a success message for 2.5 seconds ────────────────────────────────
  const flashSuccess = useCallback((msg) => {
    setSaveSuccess(msg);
    setTimeout(() => setSaveSuccess(''), 2500);
  }, []);

  // ── Generic field saver ────────────────────────────────────────────────────
  // Returns { error } on failure or null on success.
  const saveField = useCallback(async (updates) => {
    try {
      const { data } = await api.patch('/users/me', updates);
      setProfile(data.user);
      updateUserState(updates); // keep AuthContext in sync
      flashSuccess('Saved');
      return null;
    } catch (err) {
      return { error: err.response?.data?.error ?? 'Failed to save.' };
    }
  }, [updateUserState, flashSuccess]);

  // ── Delete account ─────────────────────────────────────────────────────────
  const handleDelete = useCallback(async (password) => {
    setIsDeleting(true);
    try {
      await api.delete('/users/me', { data: { password } });
      stopBeacon();
      await logout();
      navigate('/login', { replace: true });
      return null;
    } catch (err) {
      setIsDeleting(false);
      return { error: err.response?.data?.error ?? 'Failed to delete account.' };
    }
  }, [stopBeacon, logout, navigate]);

  // ── Logout ─────────────────────────────────────────────────────────────────
  const handleLogout = useCallback(async () => {
    stopBeacon();
    await logout();
    navigate('/login', { replace: true });
  }, [stopBeacon, logout, navigate]);

  // ─────────────────────────────────────────────────────────────────────────
  // LOADING / ERROR STATES
  // ─────────────────────────────────────────────────────────────────────────
  if (isLoadingInit) {
    return (
      <div className="min-h-screen bg-radar-bg flex flex-col items-center justify-center gap-4">
        <div className="relative w-12 h-12">
          <span className="absolute inset-0 rounded-full border border-beacon/30 animate-ping-slow" />
          <span className="absolute inset-3 rounded-full border border-beacon animate-ping-slow [animation-delay:0.4s]" />
        </div>
        <p className="text-white/30 text-sm font-mono">Loading profile…</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="min-h-screen bg-radar-bg flex flex-col items-center justify-center gap-4 p-6">
        <div className="w-12 h-12 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center">
          <AlertTriangle size={20} className="text-red-400" />
        </div>
        <p className="text-white/50 text-sm text-center">{loadError}</p>
        <button type="button" onClick={() => window.location.reload()} className="btn-ghost">Retry</button>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-radar-bg flex flex-col">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-3 bg-radar-surface border-b border-radar-border flex-shrink-0">
        <button type="button" onClick={() => navigate('/radar')}
          className="w-8 h-8 rounded-lg text-white/40 hover:text-white hover:bg-radar-elevated transition-colors flex items-center justify-center"
          aria-label="Back to radar">
          <ArrowLeft size={18} />
        </button>
        <h1 className="text-base font-semibold text-white flex-1">Profile</h1>

        {/* Save success flash */}
        <AnimatePresence>
          {saveSuccess && (
            <motion.span initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center gap-1 text-xs text-beacon">
              <Check size={12} />{saveSuccess}
            </motion.span>
          )}
        </AnimatePresence>

        <button type="button" onClick={handleLogout}
          className="w-8 h-8 rounded-lg text-white/40 hover:text-red-400 hover:bg-red-500/10 transition-colors flex items-center justify-center"
          aria-label="Log out">
          <LogOut size={16} />
        </button>
      </header>

      {/* Scrollable body */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-md mx-auto px-4 py-6 flex flex-col gap-5">

          {/* ── Hero card ──────────────────────────────────────────────── */}
          <div className="card p-6 flex flex-col items-center gap-4 text-center">
            <Avatar name={profile?.name} avatar={profile?.avatar} size={88} />

            <div>
              <h2 className="text-xl font-semibold text-white">{profile?.name}</h2>
              <p className="text-sm text-white/40 mt-0.5">{profile?.email}</p>
            </div>

            {/* Stats row */}
            <div className="flex items-center gap-6 pt-2 border-t border-radar-border w-full justify-center">
              <div className="flex flex-col items-center gap-0.5">
                <span className="text-lg font-semibold text-white">{profile?.connectionCount ?? 0}</span>
                <span className="text-[10px] text-white/30 uppercase tracking-wider">Connections</span>
              </div>
              <div className="w-px h-8 bg-radar-border" />
              <div className="flex flex-col items-center gap-0.5">
                <span className="text-lg font-semibold text-white">{profile?.beaconDuration ?? 60}m</span>
                <span className="text-[10px] text-white/30 uppercase tracking-wider">Default beacon</span>
              </div>
              <div className="w-px h-8 bg-radar-border" />
              <div className="flex flex-col items-center gap-0.5">
                <span className={`text-lg font-semibold ${beaconActive ? 'text-beacon' : 'text-white/40'}`}>
                  {beaconActive ? 'On' : 'Off'}
                </span>
                <span className="text-[10px] text-white/30 uppercase tracking-wider">Beacon</span>
              </div>
            </div>
          </div>

          {/* ── Profile info (editable) ────────────────────────────────── */}
          <SectionCard title="Profile info" icon={User}>
            <div className="flex flex-col gap-5">
              <EditableField
                label="Display name"
                value={profile?.name}
                placeholder="Your name"
                maxLength={50}
                onSave={(v) => saveField({ name: v })}
              />
              <div className="h-px bg-radar-border" />
              <EditableField
                label="Bio"
                value={profile?.bio}
                placeholder="Tell others what you're working on…"
                maxLength={160}
                multiline
                onSave={(v) => saveField({ bio: v })}
              />
              <div className="h-px bg-radar-border" />
              <TagEditor
                tags={profile?.tags}
                onSave={(tags) => saveField({ tags })}
              />
            </div>
          </SectionCard>

          {/* ── Connections ────────────────────────────────────────────── */}
          <SectionCard
            title="Connections"
            icon={Users}
            action={
              <span className="badge bg-radar-elevated text-white/40 border border-radar-border">
                {connections.length}
              </span>
            }
          >
            {connections.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-6 text-center">
                <Users size={24} className="text-white/15" />
                <p className="text-sm text-white/30">No connections yet</p>
                <p className="text-xs text-white/20">
                  Enable your beacon on the radar to meet people nearby
                </p>
                <Link to="/radar" className="mt-2 btn-ghost text-xs py-1.5 px-3 h-auto">
                  Go to radar
                </Link>
              </div>
            ) : (
              <div className="flex flex-col divide-y divide-radar-border/50">
                {connections.map((c) => (
                  <ConnectionCard key={c._id} connection={c} currentUserId={user?._id?.toString()} />
                ))}
              </div>
            )}
          </SectionCard>

          {/* ── Account & security ─────────────────────────────────────── */}
          <SectionCard title="Account & security" icon={Lock}>
            <div className="flex flex-col gap-4">
              {/* Member since */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-white/40">Member since</span>
                <span className="text-xs text-white/60 font-mono">{timeAgo(profile?.createdAt)}</span>
              </div>
              <div className="h-px bg-radar-border" />

              {/* Change password toggle */}
              <div>
                <button type="button" onClick={() => setShowPasswordForm((p) => !p)}
                  className="w-full flex items-center justify-between text-sm text-white/70 hover:text-white transition-colors">
                  <span className="flex items-center gap-2"><Lock size={14} />Change password</span>
                  <ChevronRight size={14} className={`transition-transform ${showPasswordForm ? 'rotate-90' : ''}`} />
                </button>
                <AnimatePresence>
                  {showPasswordForm && (
                    <ChangePasswordForm onClose={() => setShowPasswordForm(false)} />
                  )}
                </AnimatePresence>
              </div>

              <div className="h-px bg-radar-border" />

              {/* Logout */}
              <button type="button" onClick={handleLogout}
                className="w-full flex items-center gap-2 text-sm text-white/70 hover:text-white transition-colors">
                <LogOut size={14} />Log out
              </button>

              <div className="h-px bg-radar-border" />

              {/* Delete account */}
              <button type="button" onClick={() => setShowDeleteDialog(true)}
                className="w-full flex items-center gap-2 text-sm text-red-400/70 hover:text-red-400 transition-colors">
                <Trash2 size={14} />Delete account
              </button>
            </div>
          </SectionCard>

          <div className="h-6" />
        </div>
      </main>

      {/* Delete account dialog */}
      <AnimatePresence>
        {showDeleteDialog && (
          <DeleteAccountDialog
            onConfirm={handleDelete}
            onCancel={() => setShowDeleteDialog(false)}
            isDeleting={isDeleting}
          />
        )}
      </AnimatePresence>
    </div>
  );
}