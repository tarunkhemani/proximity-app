import express        from 'express';
import mongoose       from 'mongoose';
import rateLimit      from 'express-rate-limit';

import User           from '../models/User.js';
import Message        from '../models/Message.js';
import Location       from '../models/Location.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// All user routes require authentication
router.use(authenticateToken);

// Tighter rate limit for profile writes
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      20,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many profile updates. Please wait.' },
});

// ── GET /api/users/me ──────────────────────────────────────────────────────────
// Returns the authenticated user's full profile including connection count
// and current beacon state. Used by ProfilePage on mount.
router.get('/me', async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .select('-password -refreshToken')
      .lean();

    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // Attach live beacon state — beaconExpiresAt may be stale if server
    // restarted, so also compute isBeaconCurrentlyActive here
    const isBeaconCurrentlyActive =
      user.isVisible &&
      user.beaconExpiresAt &&
      new Date(user.beaconExpiresAt) > new Date();

    // Count accepted connections
    const connectionCount = user.connections?.length ?? 0;

    // Check whether a live Location document exists for this user
    const hasActiveLocation = await Location.exists({ userId: user._id });

    return res.status(200).json({
      user: {
        ...user,
        isBeaconCurrentlyActive,
        connectionCount,
        hasActiveLocation: Boolean(hasActiveLocation),
      },
    });
  } catch (err) {
    console.error('[users/me]', err.message);
    res.status(500).json({ error: 'Failed to load profile.' });
  }
});

// ── PATCH /api/users/me ────────────────────────────────────────────────────────
// Updates editable profile fields. Password changes are a separate endpoint
// (below) to enforce the current-password requirement.
// Accepted fields: name, bio, tags, avatar
router.patch('/me', writeLimiter, async (req, res) => {
  try {
    const { name, bio, tags, avatar } = req.body;
    const updates = {};

    // ── Validate and collect allowed fields ─────────────────────────────────
    const errors = {};

    if (name !== undefined) {
      if (typeof name !== 'string' || name.trim().length < 2) {
        errors.name = 'Name must be at least 2 characters.';
      } else if (name.trim().length > 50) {
        errors.name = 'Name cannot exceed 50 characters.';
      } else {
        updates.name = name.trim();
      }
    }

    if (bio !== undefined) {
      if (typeof bio !== 'string') {
        errors.bio = 'Bio must be a string.';
      } else {
        updates.bio = bio.trim().slice(0, 160);
      }
    }

    if (tags !== undefined) {
      if (!Array.isArray(tags)) {
        errors.tags = 'Tags must be an array.';
      } else if (tags.length > 10) {
        errors.tags = 'Cannot have more than 10 tags.';
      } else {
        updates.tags = tags.map((t) => String(t).trim().toLowerCase().slice(0, 30)).filter(Boolean);
      }
    }

    if (avatar !== undefined) {
      if (avatar !== null && typeof avatar !== 'string') {
        errors.avatar = 'Avatar must be a URL string or null.';
      } else {
        updates.avatar = avatar;
      }
    }

    if (Object.keys(errors).length > 0) {
      return res.status(422).json({ error: 'Validation failed.', fields: errors });
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields provided.' });
    }

    const updated = await User.findByIdAndUpdate(
      req.user._id,
      { $set: updates },
      { new: true, runValidators: true }
    ).select('-password -refreshToken');

    console.log(`[users] Profile updated for ${req.user._id}`);
    return res.status(200).json({ user: updated, message: 'Profile updated.' });
  } catch (err) {
    if (err.name === 'ValidationError') {
      const fields = Object.fromEntries(Object.entries(err.errors).map(([k, v]) => [k, v.message]));
      return res.status(422).json({ error: 'Validation failed.', fields });
    }
    console.error('[users/me PATCH]', err.message);
    res.status(500).json({ error: 'Failed to update profile.' });
  }
});

// ── POST /api/users/me/change-password ────────────────────────────────────────
// Requires the current password before setting a new one.
router.post('/me/change-password', writeLimiter, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(422).json({ error: 'Both currentPassword and newPassword are required.' });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      return res.status(422).json({ error: 'New password must be at least 8 characters.' });
    }
    if (!/(?=.*[a-zA-Z])(?=.*\d)/.test(newPassword)) {
      return res.status(422).json({ error: 'New password must contain at least one letter and one number.' });
    }

    // Fetch with password field (select: false by default)
    const user = await User.findById(req.user._id).select('+password');
    const isMatch = await user.comparePassword(currentPassword);

    if (!isMatch) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    user.password = newPassword; // pre-save hook hashes it
    await user.save();

    console.log(`[users] Password changed for ${req.user._id}`);
    return res.status(200).json({ message: 'Password updated successfully.' });
  } catch (err) {
    console.error('[users/change-password]', err.message);
    res.status(500).json({ error: 'Failed to change password.' });
  }
});

// ── GET /api/users/connections ─────────────────────────────────────────────────
// Returns the authenticated user's accepted connections with public profiles.
router.get('/connections', async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .populate('connections', 'name avatar bio tags isVisible beaconExpiresAt')
      .lean();

    if (!user) return res.status(404).json({ error: 'User not found.' });

    // Annotate each connection with whether they have an active beacon
    const now = new Date();
    const connections = (user.connections ?? []).map((c) => ({
      ...c,
      isBeaconActive: c.isVisible && c.beaconExpiresAt && new Date(c.beaconExpiresAt) > now,
    }));

    return res.status(200).json({ connections });
  } catch (err) {
    console.error('[users/connections]', err.message);
    res.status(500).json({ error: 'Failed to load connections.' });
  }
});

// ── GET /api/users/:id ─────────────────────────────────────────────────────────
// Returns any user's public profile. Used when viewing another user's card.
// Only exposes safe fields — never password, email, refreshToken.
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid user ID.' });
    }

    const user = await User.findById(id)
      .select('name avatar bio tags isVisible beaconExpiresAt createdAt')
      .lean();

    if (!user || !user.isActive) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // Find shared conversation room if one exists with the requesting user
    const roomId = Message.buildRoomId(req.user._id.toString(), id);
    const hasConversation = await Message.exists({ roomId });

    return res.status(200).json({
      user: {
        ...user,
        isBeaconActive: user.isVisible && user.beaconExpiresAt && new Date(user.beaconExpiresAt) > new Date(),
      },
      roomId:          hasConversation ? roomId : null,
      hasConversation: Boolean(hasConversation),
    });
  } catch (err) {
    console.error('[users/:id]', err.message);
    res.status(500).json({ error: 'Failed to load user.' });
  }
});

// ── DELETE /api/users/me ───────────────────────────────────────────────────────
// Soft-deletes the account. Sets isActive: false and clears sensitive fields.
// A hard-delete job can clean up MongoDB documents later.
router.delete('/me', writeLimiter, async (req, res) => {
  try {
    const { password } = req.body;

    if (!password) {
      return res.status(422).json({ error: 'Password confirmation is required.' });
    }

    const user    = await User.findById(req.user._id).select('+password');
    const isMatch = await user.comparePassword(password);

    if (!isMatch) {
      return res.status(401).json({ error: 'Password is incorrect.' });
    }

    // Soft delete — preserves message history for the other participant
    await User.findByIdAndUpdate(req.user._id, {
      isActive:      false,
      isVisible:     false,
      beaconExpiresAt: null,
      refreshToken:  null,
      email:         `deleted_${req.user._id}@removed.invalid`,
    });

    // Immediately remove their location document
    await Location.deleteOne({ userId: req.user._id });

    console.log(`[users] Account deactivated: ${req.user._id}`);
    return res.status(200).json({ message: 'Account deleted.' });
  } catch (err) {
    console.error('[users/delete]', err.message);
    res.status(500).json({ error: 'Failed to delete account.' });
  }
});

export default router;