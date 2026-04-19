import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Eye, EyeOff, Radio, Loader2, AlertCircle, User, Mail, Lock, Tag } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

// ── Animation variants ────────────────────────────────────────────────────────
const formVariants = {
  hidden:  { opacity: 0, x: 40 },
  visible: { opacity: 1, x: 0, transition: { duration: 0.3, ease: 'easeOut' } },
  exit:    { opacity: 0, x: -40, transition: { duration: 0.2, ease: 'easeIn' } },
};

const fieldVariants = {
  hidden:  { opacity: 0, y: 12 },
  visible: (i) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.07, duration: 0.3, ease: 'easeOut' },
  }),
};

// ── Sub-components ────────────────────────────────────────────────────────────

function InputField({
  id,
  label,
  type = 'text',
  value,
  onChange,
  placeholder,
  error,
  icon: Icon,
  autoComplete,
  index = 0,
  rightElement,
}) {
  return (
    <motion.div
      custom={index}
      variants={fieldVariants}
      initial="hidden"
      animate="visible"
      className="flex flex-col gap-1.5"
    >
      <label htmlFor={id} className="text-sm font-medium text-white/70">
        {label}
      </label>
      <div className="relative">
        {Icon && (
          <Icon
            size={16}
            className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/30 pointer-events-none"
          />
        )}
        <input
          id={id}
          type={type}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          autoComplete={autoComplete}
          className={`
            input pl-10 pr-${rightElement ? '10' : '4'}
            ${error ? 'border-red-500/70 focus:border-red-500 focus:ring-red-500/30' : ''}
          `}
        />
        {rightElement && (
          <div className="absolute right-3.5 top-1/2 -translate-y-1/2">
            {rightElement}
          </div>
        )}
      </div>
      <AnimatePresence mode="wait">
        {error && (
          <motion.p
            key={error}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="flex items-center gap-1.5 text-xs text-red-400"
          >
            <AlertCircle size={12} />
            {error}
          </motion.p>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function TagInput({ tags, onChange }) {
  const [inputValue, setInputValue] = useState('');

  const addTag = (raw) => {
    const tag = raw.trim().toLowerCase().replace(/[^a-z0-9+#.\-]/g, '');
    if (tag && !tags.includes(tag) && tags.length < 10) {
      onChange([...tags, tag]);
    }
    setInputValue('');
  };

  const removeTag = (index) => {
    onChange(tags.filter((_, i) => i !== index));
  };

  const handleKeyDown = (e) => {
    if (['Enter', ',', ' '].includes(e.key)) {
      e.preventDefault();
      addTag(inputValue);
    }
    if (e.key === 'Backspace' && !inputValue && tags.length > 0) {
      removeTag(tags.length - 1);
    }
  };

  return (
    <motion.div
      custom={4}
      variants={fieldVariants}
      initial="hidden"
      animate="visible"
      className="flex flex-col gap-1.5"
    >
      <label className="text-sm font-medium text-white/70">
        Skills / interests
        <span className="text-white/30 font-normal ml-1">(optional, up to 10)</span>
      </label>
      <div
        className={`
          min-h-[44px] flex flex-wrap gap-1.5 p-2 pl-3
          bg-radar-elevated border border-radar-border rounded-xl
          focus-within:border-beacon focus-within:ring-1 focus-within:ring-beacon
          transition-colors duration-150 cursor-text
        `}
        onClick={() => document.getElementById('tag-input')?.focus()}
      >
        {tags.map((tag, i) => (
          <span
            key={tag}
            className="flex items-center gap-1 badge bg-beacon/10 text-beacon border border-beacon/20"
          >
            <Tag size={10} />
            {tag}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); removeTag(i); }}
              className="ml-0.5 text-beacon/60 hover:text-beacon transition-colors"
              aria-label={`Remove tag ${tag}`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          id="tag-input"
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => inputValue && addTag(inputValue)}
          placeholder={tags.length === 0 ? 'e.g. React, ML, Guitar…' : ''}
          className="flex-1 min-w-[120px] bg-transparent text-white text-sm outline-none placeholder-white/25"
        />
      </div>
      <p className="text-xs text-white/30">Press Enter or comma to add a tag</p>
    </motion.div>
  );
}

// ── Radar logo animation ──────────────────────────────────────────────────────
function RadarLogo() {
  return (
    <div className="relative w-14 h-14 mx-auto mb-6">
      {/* Static rings */}
      <div className="absolute inset-0 rounded-full border border-beacon/10" />
      <div className="absolute inset-2 rounded-full border border-beacon/15" />
      <div className="absolute inset-4 rounded-full border border-beacon/25" />
      {/* Rotating sweep */}
      <div className="absolute inset-0 rounded-full radar-sweep-gradient animate-sweep" />
      {/* Centre dot */}
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="w-2 h-2 rounded-full bg-beacon glow-beacon" />
      </div>
      {/* Pulsing blip */}
      <div className="absolute top-2 right-3 w-1.5 h-1.5">
        <span className="absolute inset-0 rounded-full bg-beacon animate-ping-slow opacity-75" />
        <span className="relative block w-1.5 h-1.5 rounded-full bg-beacon" />
      </div>
    </div>
  );
}

// ── Login form ────────────────────────────────────────────────────────────────
function LoginForm({ onSwitch, onSuccess }) {
  const { login, isLoading } = useAuth();

  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [error,    setError]    = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!email.trim() || !password) {
      setError('Please fill in all fields.');
      return;
    }

    const result = await login({ email: email.trim(), password });

    if (result.success) {
      onSuccess();
    } else {
      setError(result.error);
    }
  };

  return (
    <motion.div
      key="login"
      variants={formVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-5" noValidate>
        <InputField
          id="login-email"
          label="Email address"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          icon={Mail}
          autoComplete="email"
          index={0}
        />

        <InputField
          id="login-password"
          label="Password"
          type={showPass ? 'text' : 'password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          icon={Lock}
          autoComplete="current-password"
          index={1}
          rightElement={
            <button
              type="button"
              onClick={() => setShowPass((p) => !p)}
              className="text-white/30 hover:text-white/70 transition-colors"
              aria-label={showPass ? 'Hide password' : 'Show password'}
            >
              {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          }
        />

        <AnimatePresence mode="wait">
          {error && (
            <motion.div
              key="login-error"
              initial={{ opacity: 0, y: -8, scale: 0.97 }}
              animate={{ opacity: 1, y: 0,  scale: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-start gap-2.5 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm"
            >
              <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
              {error}
            </motion.div>
          )}
        </AnimatePresence>

        <motion.button
          type="submit"
          disabled={isLoading}
          className="btn-primary h-11 flex items-center justify-center gap-2 mt-1"
          whileTap={{ scale: 0.98 }}
        >
          {isLoading ? (
            <><Loader2 size={16} className="animate-spin" /> Signing in…</>
          ) : (
            'Sign in'
          )}
        </motion.button>
      </form>

      <p className="text-center text-sm text-white/40 mt-6">
        Don't have an account?{' '}
        <button
          type="button"
          onClick={onSwitch}
          className="text-beacon hover:text-beacon-dim transition-colors font-medium"
        >
          Create one
        </button>
      </p>
    </motion.div>
  );
}

// ── Register form ─────────────────────────────────────────────────────────────
function RegisterForm({ onSwitch, onSuccess }) {
  const { register, isLoading } = useAuth();

  const [name,     setName]     = useState('');
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [bio,      setBio]      = useState('');
  const [tags,     setTags]     = useState([]);
  const [showPass, setShowPass] = useState(false);

  // Per-field and global errors
  const [errors,      setErrors]      = useState({});
  const [globalError, setGlobalError] = useState('');

  const validate = () => {
    const e = {};
    if (!name.trim() || name.trim().length < 2) {
      e.name = 'Name must be at least 2 characters.';
    }
    if (!email.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      e.email = 'Please enter a valid email address.';
    }
    if (!password || password.length < 8) {
      e.password = 'Password must be at least 8 characters.';
    }
    if (password && !/(?=.*[a-zA-Z])(?=.*\d)/.test(password)) {
      e.password = 'Must contain at least one letter and one number.';
    }
    return e;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setGlobalError('');

    const clientErrors = validate();
    if (Object.keys(clientErrors).length > 0) {
      setErrors(clientErrors);
      return;
    }
    setErrors({});

    const result = await register({
      name:     name.trim(),
      email:    email.trim(),
      password,
      bio:      bio.trim(),
      tags,
    });

    if (result.success) {
      onSuccess();
    } else {
      // Server-side field errors (e.g. duplicate email) or a global error
      if (result.fields && Object.keys(result.fields).length > 0) {
        setErrors(result.fields);
      } else {
        setGlobalError(result.error);
      }
    }
  };

  return (
    <motion.div
      key="register"
      variants={formVariants}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
        <InputField
          id="reg-name"
          label="Full name"
          value={name}
          onChange={(e) => { setName(e.target.value); setErrors((p) => ({ ...p, name: '' })); }}
          placeholder="Ada Lovelace"
          icon={User}
          autoComplete="name"
          error={errors.name}
          index={0}
        />

        <InputField
          id="reg-email"
          label="Email address"
          type="email"
          value={email}
          onChange={(e) => { setEmail(e.target.value); setErrors((p) => ({ ...p, email: '' })); }}
          placeholder="ada@example.com"
          icon={Mail}
          autoComplete="email"
          error={errors.email}
          index={1}
        />

        <InputField
          id="reg-password"
          label="Password"
          type={showPass ? 'text' : 'password'}
          value={password}
          onChange={(e) => { setPassword(e.target.value); setErrors((p) => ({ ...p, password: '' })); }}
          placeholder="Min 8 chars, one letter + one number"
          icon={Lock}
          autoComplete="new-password"
          error={errors.password}
          index={2}
          rightElement={
            <button
              type="button"
              onClick={() => setShowPass((p) => !p)}
              className="text-white/30 hover:text-white/70 transition-colors"
              aria-label={showPass ? 'Hide password' : 'Show password'}
            >
              {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          }
        />

        {/* Bio — optional, shown collapsed */}
        <motion.div
          custom={3}
          variants={fieldVariants}
          initial="hidden"
          animate="visible"
          className="flex flex-col gap-1.5"
        >
          <label htmlFor="reg-bio" className="text-sm font-medium text-white/70">
            Bio
            <span className="text-white/30 font-normal ml-1">(optional)</span>
          </label>
          <textarea
            id="reg-bio"
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            placeholder="What brings you here? What are you working on?"
            rows={2}
            maxLength={160}
            className="input resize-none leading-relaxed py-3"
          />
          <p className="text-xs text-white/25 text-right">{bio.length}/160</p>
        </motion.div>

        <TagInput tags={tags} onChange={setTags} />

        <AnimatePresence mode="wait">
          {globalError && (
            <motion.div
              key="reg-error"
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex items-start gap-2.5 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm"
            >
              <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
              {globalError}
            </motion.div>
          )}
        </AnimatePresence>

        <motion.button
          type="submit"
          disabled={isLoading}
          className="btn-primary h-11 flex items-center justify-center gap-2 mt-1"
          whileTap={{ scale: 0.98 }}
        >
          {isLoading ? (
            <><Loader2 size={16} className="animate-spin" /> Creating account…</>
          ) : (
            'Create account'
          )}
        </motion.button>
      </form>

      <p className="text-center text-sm text-white/40 mt-6">
        Already have an account?{' '}
        <button
          type="button"
          onClick={onSwitch}
          className="text-beacon hover:text-beacon-dim transition-colors font-medium"
        >
          Sign in
        </button>
      </p>
    </motion.div>
  );
}

// ── Page root ─────────────────────────────────────────────────────────────────
export default function LoginPage() {
  const navigate      = useNavigate();
  const [searchParams] = useSearchParams();

  // Toggle between 'login' and 'register' modes
  const [mode, setMode] = useState(() =>
    searchParams.get('mode') === 'register' ? 'register' : 'login'
  );

  // Where to redirect after successful auth
  const next = searchParams.get('next') || '/radar';

  // Show session-expired message if redirected from the axios interceptor
  const reason = searchParams.get('reason');

  const handleSuccess = () => {
    navigate(decodeURIComponent(next), { replace: true });
  };

  const switchMode = () => {
    setMode((m) => (m === 'login' ? 'register' : 'login'));
  };

  return (
    <div className="min-h-screen bg-radar-bg flex items-center justify-center p-4">
      {/*
        Background radial decoration — purely visual, does not affect layout.
        The large circle gives the radar feel without a canvas element.
      */}
      <div
        className="pointer-events-none fixed inset-0 overflow-hidden"
        aria-hidden="true"
      >
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          {[280, 480, 680, 880].map((size) => (
            <div
              key={size}
              className="absolute rounded-full border border-radar-ring/20"
              style={{
                width:  size,
                height: size,
                top:    -size / 2,
                left:   -size / 2,
              }}
            />
          ))}
        </div>
      </div>

      {/* Card */}
      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.97 }}
        animate={{ opacity: 1, y: 0,  scale: 1 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
        className="relative w-full max-w-md"
      >
        {/* Session expired banner */}
        <AnimatePresence>
          {reason === 'session_expired' && (
            <motion.div
              initial={{ opacity: 0, y: -12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mb-3 flex items-center gap-2 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400 text-sm"
            >
              <AlertCircle size={15} className="flex-shrink-0" />
              Your session expired. Please sign in again.
            </motion.div>
          )}
        </AnimatePresence>

        <div className="card p-8">
          {/* Header */}
          <div className="text-center mb-8">
            <RadarLogo />

            <h1 className="text-2xl font-semibold text-white">
              {mode === 'login' ? 'Welcome back' : 'Join the network'}
            </h1>
            <p className="text-white/40 text-sm mt-1">
              {mode === 'login'
                ? 'Sign in to find people nearby'
                : 'Create your proximity profile'}
            </p>
          </div>

          {/* Mode toggle pills */}
          <div className="flex gap-1 p-1 bg-radar-elevated rounded-xl mb-8">
            {['login', 'register'].map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`
                  flex-1 py-2 rounded-lg text-sm font-medium transition-all duration-200
                  ${mode === m
                    ? 'bg-beacon text-radar-bg shadow-beacon'
                    : 'text-white/40 hover:text-white/70'
                  }
                `}
              >
                {m === 'login' ? 'Sign in' : 'Register'}
              </button>
            ))}
          </div>

          {/* Form — AnimatePresence handles the slide transition between modes */}
          <AnimatePresence mode="wait" initial={false}>
            {mode === 'login' ? (
              <LoginForm key="login" onSwitch={switchMode} onSuccess={handleSuccess} />
            ) : (
              <RegisterForm key="register" onSwitch={switchMode} onSuccess={handleSuccess} />
            )}
          </AnimatePresence>
        </div>

        {/* Footer */}
        <p className="text-center text-xs text-white/20 mt-4">
          By continuing, you agree to the{' '}
          <span className="text-white/40 cursor-pointer hover:text-beacon transition-colors">
            Terms of Service
          </span>{' '}
          and{' '}
          <span className="text-white/40 cursor-pointer hover:text-beacon transition-colors">
            Privacy Policy
          </span>
        </p>
      </motion.div>
    </div>
  );
}