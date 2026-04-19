import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';

import User from '../models/User.js';

const router = express.Router();

// ── Auth-specific rate limiters ───────────────────────────────────────────────
// Tighter than the global API limiter — auth endpoints are the primary target
// for credential stuffing and brute-force attacks.

// Registration: max 5 accounts per IP per hour
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many accounts created from this IP. Try again in an hour.' },
});

// Login: max 10 attempts per IP per 15 minutes
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please wait 15 minutes.' },
});

// ── Token helpers ─────────────────────────────────────────────────────────────

function signAccessToken(userId) {
  return jwt.sign(
    { userId: userId.toString() },
    process.env.JWT_SECRET,
    {
      expiresIn:  process.env.JWT_EXPIRES_IN  || '7d',
      issuer:     'proximity-api',
      audience:   'proximity-client',
    }
  );
}

function signRefreshToken(userId) {
  return jwt.sign(
    { userId: userId.toString() },
    process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET + '_refresh',
    {
      expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
      issuer:    'proximity-api',
      audience:  'proximity-client',
    }
  );
}

// Shape the user object that is safe to send to the client.
// Never include password, refreshToken, or internal flags.
function buildPublicUser(userDoc) {
  return {
    _id:            userDoc._id,
    name:           userDoc.name,
    email:          userDoc.email,
    avatar:         userDoc.avatar,
    bio:            userDoc.bio,
    tags:           userDoc.tags,
    isVisible:      userDoc.isVisible,
    beaconExpiresAt:userDoc.beaconExpiresAt,
    beaconDuration: userDoc.beaconDuration,
    connections:    userDoc.connections,
    createdAt:      userDoc.createdAt,
  };
}

// ── POST /api/auth/register ───────────────────────────────────────────────────
router.post('/register', registerLimiter, async (req, res) => {
  try {
    const { name, email, password, bio = '', tags = [] } = req.body;

    // ── Field-level validation ────────────────────────────────────────────────
    const errors = {};

    if (!name || typeof name !== 'string' || name.trim().length < 2) {
      errors.name = 'Name must be at least 2 characters.';
    }
    if (!email || typeof email !== 'string') {
      errors.email = 'A valid email address is required.';
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      errors.password = 'Password must be at least 8 characters.';
    }
    // Basic password strength: at least one letter and one number
    if (password && !/(?=.*[a-zA-Z])(?=.*\d)/.test(password)) {
      errors.password = 'Password must contain at least one letter and one number.';
    }
    if (!Array.isArray(tags) || tags.length > 10) {
      errors.tags = 'Tags must be an array of up to 10 items.';
    }

    if (Object.keys(errors).length > 0) {
      return res.status(422).json({ error: 'Validation failed', fields: errors });
    }

    // ── Duplicate email check ─────────────────────────────────────────────────
    // Check before attempting to save so we can return a clean error instead of
    // letting Mongoose throw an E11000 duplicate key error from the unique index.
    const existingUser = await User.findOne({ email: email.toLowerCase().trim() }).lean();
    if (existingUser) {
      return res.status(409).json({
        error: 'An account with this email already exists.',
        fields: { email: 'Email is already registered.' },
      });
    }

    // ── Create user ───────────────────────────────────────────────────────────
    // Password hashing is handled by the pre-save hook in User.js (bcrypt, 12 rounds).
    const user = await User.create({
      name:     name.trim(),
      email:    email.toLowerCase().trim(),
      password,
      bio:      bio.trim().slice(0, 160),
      tags:     tags.map(String).slice(0, 10),
    });

    // ── Issue tokens ──────────────────────────────────────────────────────────
    const accessToken  = signAccessToken(user._id);
    const refreshToken = signRefreshToken(user._id);

    // Store hashed refresh token on the user document for rotation validation.
    // We import bcrypt here rather than at the top to keep the dependency explicit.
    const { default: bcrypt } = await import('bcryptjs');
    const hashedRefresh = await bcrypt.hash(refreshToken, 10);
    await User.findByIdAndUpdate(user._id, { refreshToken: hashedRefresh });

    // ── Set refresh token in httpOnly cookie ──────────────────────────────────
    // HttpOnly + Secure + SameSite=Strict means JS cannot read this cookie,
    // which protects against XSS token theft.
    res.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge:   30 * 24 * 60 * 60 * 1000, // 30 days in ms
      path:     '/api/auth',               // only sent to auth endpoints
    });

    console.log(`[auth] New user registered: ${user.email} (${user._id})`);

    return res.status(201).json({
      message:     'Account created successfully.',
      accessToken,
      user:        buildPublicUser(user),
    });
  } catch (err) {
    // Mongoose validation errors (from schema validators)
    if (err.name === 'ValidationError') {
      const fields = Object.fromEntries(
        Object.entries(err.errors).map(([k, v]) => [k, v.message])
      );
      return res.status(422).json({ error: 'Validation failed', fields });
    }
    console.error('[auth/register]', err.message);
    return res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────────────────────
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    // ── Basic presence check ──────────────────────────────────────────────────
    if (!email || !password) {
      return res.status(422).json({ error: 'Email and password are required.' });
    }

    // ── Fetch user with password (select:false by default) ────────────────────
    const user = await User.findByEmail(email); // defined as a static in User.js

    // Use a constant-time comparison path regardless of whether the user exists.
    // This prevents timing attacks from revealing whether an email is registered.
    const dummyHash = '$2b$12$invalidhashfortimingnormalization00000000000000000';
    const isValid   = user
      ? await user.comparePassword(password)
      : await (await import('bcryptjs')).default.compare(password, dummyHash);

    if (!user || !isValid) {
      // Generic message — do NOT reveal which field was wrong
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    if (!user.isActive) {
      return res.status(403).json({ error: 'Your account has been deactivated. Please contact support.' });
    }

    // ── Issue tokens ──────────────────────────────────────────────────────────
    const accessToken  = signAccessToken(user._id);
    const refreshToken = signRefreshToken(user._id);

    const { default: bcrypt } = await import('bcryptjs');
    const hashedRefresh = await bcrypt.hash(refreshToken, 10);

    // Update last seen and refresh token atomically
    await User.findByIdAndUpdate(user._id, {
      refreshToken: hashedRefresh,
      lastSeen:     new Date(),
    });

    res.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge:   30 * 24 * 60 * 60 * 1000,
      path:     '/api/auth',
    });

    console.log(`[auth] Login: ${user.email} (${user._id})`);

    return res.status(200).json({
      message:     'Logged in successfully.',
      accessToken,
      user:        buildPublicUser(user),
    });
  } catch (err) {
    console.error('[auth/login]', err.message);
    return res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ── POST /api/auth/refresh ────────────────────────────────────────────────────
// Issues a new access token using the httpOnly refresh token cookie.
// Called automatically by the axios interceptor in api.js when a 401 is received.
router.post('/refresh', async (req, res) => {
  try {
    const token = req.cookies?.refresh_token;

    if (!token) {
      return res.status(401).json({ error: 'No refresh token provided.' });
    }

    // Verify refresh token signature
    let payload;
    try {
      payload = jwt.verify(
        token,
        process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET + '_refresh',
        { issuer: 'proximity-api', audience: 'proximity-client' }
      );
    } catch {
      return res.status(401).json({ error: 'Invalid or expired refresh token.' });
    }

    // Fetch user and validate stored hash (refresh token rotation)
    const user = await User.findById(payload.userId).select('+refreshToken');
    if (!user || !user.refreshToken) {
      return res.status(401).json({ error: 'Session revoked. Please log in again.' });
    }

    const { default: bcrypt } = await import('bcryptjs');
    const tokenMatches = await bcrypt.compare(token, user.refreshToken);
    if (!tokenMatches) {
      // Token reuse detected — revoke all sessions for this user
      await User.findByIdAndUpdate(payload.userId, { refreshToken: null });
      return res.status(401).json({ error: 'Token reuse detected. Please log in again.' });
    }

    // Issue a new pair
    const newAccessToken  = signAccessToken(user._id);
    const newRefreshToken = signRefreshToken(user._id);
    const newHash = await bcrypt.hash(newRefreshToken, 10);
    await User.findByIdAndUpdate(user._id, { refreshToken: newHash });

    res.cookie('refresh_token', newRefreshToken, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge:   30 * 24 * 60 * 60 * 1000,
      path:     '/api/auth',
    });

    return res.status(200).json({ accessToken: newAccessToken });
  } catch (err) {
    console.error('[auth/refresh]', err.message);
    return res.status(500).json({ error: 'Could not refresh session.' });
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
router.post('/logout', async (req, res) => {
  try {
    const token = req.cookies?.refresh_token;

    if (token) {
      // Best-effort: decode without verifying (token may be expired) to get userId
      try {
        const payload = jwt.decode(token);
        if (payload?.userId && mongoose.Types.ObjectId.isValid(payload.userId)) {
          await User.findByIdAndUpdate(payload.userId, { refreshToken: null });
        }
      } catch {
        // Ignore — we clear the cookie regardless
      }
    }

    // Clear the cookie by setting maxAge to 0
    res.cookie('refresh_token', '', {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge:   0,
      path:     '/api/auth',
    });

    return res.status(200).json({ message: 'Logged out successfully.' });
  } catch (err) {
    console.error('[auth/logout]', err.message);
    return res.status(500).json({ error: 'Logout failed.' });
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────────────────────
// Returns the currently authenticated user's profile.
// Used by the frontend on app load to re-hydrate the auth context from a stored token.
router.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided.' });
    }

    const token = authHeader.slice(7);
    let payload;

    try {
      payload = jwt.verify(token, process.env.JWT_SECRET, {
        issuer:   'proximity-api',
        audience: 'proximity-client',
      });
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token.' });
    }

    const user = await User.findById(payload.userId).lean();
    if (!user || !user.isActive) {
      return res.status(404).json({ error: 'User not found.' });
    }

    return res.status(200).json({ user: buildPublicUser(user) });
  } catch (err) {
    console.error('[auth/me]', err.message);
    return res.status(500).json({ error: 'Could not fetch profile.' });
  }
});

export default router;