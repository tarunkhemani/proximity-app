import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import validator from 'validator';

const UserSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters'],
      maxlength: [50, 'Name cannot exceed 50 characters'],
    },

    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      validate: {
        validator: (v) => validator.isEmail(v),
        message: 'Please provide a valid email address',
      },
    },

    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [8, 'Password must be at least 8 characters'],
      select: false, // never returned in queries unless explicitly requested with .select('+password')
    },

    avatar: {
      type: String,
      default: null,
      validate: {
        validator: (v) => v === null || validator.isURL(v),
        message: 'Avatar must be a valid URL',
      },
    },

    // ── Profile fields shown to nearby users ────────────────────────────────
    bio: {
      type: String,
      trim: true,
      maxlength: [160, 'Bio cannot exceed 160 characters'],
      default: '',
    },

    // Skills/interests shown on the proximity card (e.g. ['React', 'ML', 'Music'])
    tags: {
      type: [String],
      default: [],
      validate: {
        validator: (arr) => arr.length <= 10,
        message: 'Cannot have more than 10 tags',
      },
    },

    // ── Beacon / visibility state ─────────────────────────────────────────────
    // isVisible: the master switch — users are invisible by default.
    // They must explicitly opt in via the beacon toggle in the UI.
    isVisible: {
      type: Boolean,
      default: false,
    },

    // beaconExpiresAt: when the beacon auto-shuts off.
    // Checked in the $geoNear aggregation pipeline — expired beacons are
    // excluded from proximity results even if isVisible is still true
    // (handles edge cases where the server-side timeout didn't fire).
    beaconExpiresAt: {
      type: Date,
      default: null,
    },

    // beaconDuration: the last chosen duration in minutes, persisted so the
    // UI can pre-fill "Start beacon for X minutes" on the next session.
    beaconDuration: {
      type: Number,
      default: 60,
      min: [5, 'Minimum beacon duration is 5 minutes'],
      max: [480, 'Maximum beacon duration is 8 hours'],
    },

    // ── Connection tracking ───────────────────────────────────────────────────
    // Accepted connections — used to skip re-sending connection requests
    // and to populate a "my network" list. Stored as ObjectId refs.
    connections: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],

    // Pending outgoing connection requests this user has sent.
    // Used to prevent duplicate requests and show "request sent" state in UI.
    pendingRequestsSent: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],

    // ── Account metadata ──────────────────────────────────────────────────────
    isActive: {
      type: Boolean,
      default: true,
    },

    lastSeen: {
      type: Date,
      default: Date.now,
    },

    // Refresh token stored hashed — used for /auth/refresh endpoint (Phase 3)
    refreshToken: {
      type: String,
      default: null,
      select: false,
    },
  },
  {
    timestamps: true, // adds createdAt and updatedAt automatically
    toJSON: {
      // Strip sensitive fields whenever a User document is serialised to JSON
      // (e.g. res.json(user)). Keeps password and refreshToken out of API responses.
      transform(doc, ret) {
        delete ret.password;
        delete ret.refreshToken;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// ── Indexes ───────────────────────────────────────────────────────────────────
// email is already indexed via `unique: true`.
// Index on isVisible + beaconExpiresAt accelerates the aggregation pipeline's
// $match stage that filters for active beacon users.
UserSchema.index({ isVisible: 1, beaconExpiresAt: 1 });

// Partial index: only index documents where isVisible is true.
// Keeps the index small — at any moment, most users are not broadcasting.
UserSchema.index(
  { beaconExpiresAt: 1 },
  {
    partialFilterExpression: { isVisible: true },
    name: 'active_beacon_expiry',
  }
);

// ── Pre-save middleware ────────────────────────────────────────────────────────
// Hash the password before saving. Only runs when password is new or modified
// (prevents re-hashing an already-hashed password on unrelated updates).
UserSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();

  try {
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (err) {
    next(err);
  }
});

// ── Instance methods ──────────────────────────────────────────────────────────

// comparePassword: called during login to verify the supplied plaintext password
// against the stored hash. Always use this — never compare directly.
UserSchema.methods.comparePassword = async function (candidatePassword) {
  // 'this.password' is not selected by default — the caller must have used
  // .select('+password') on the query before calling this method.
  return bcrypt.compare(candidatePassword, this.password);
};

// isBeaconActive: single source of truth for whether a user's beacon is live.
// Use this anywhere you need to check visibility rather than comparing dates inline.
UserSchema.methods.isBeaconActive = function () {
  return this.isVisible === true && this.beaconExpiresAt !== null && this.beaconExpiresAt > new Date();
};

// startBeacon: activate beacon and set expiry. Returns the updated document.
UserSchema.methods.startBeacon = async function (durationMinutes = 60) {
  this.isVisible = true;
  this.beaconDuration = durationMinutes;
  this.beaconExpiresAt = new Date(Date.now() + durationMinutes * 60_000);
  return this.save();
};

// stopBeacon: deactivate beacon immediately.
UserSchema.methods.stopBeacon = async function () {
  this.isVisible = false;
  this.beaconExpiresAt = null;
  return this.save();
};

// toPublicProfile: returns only the fields safe to expose to nearby users.
// Call this before emitting user data over a socket or in a proximity response.
UserSchema.methods.toPublicProfile = function () {
  return {
    _id: this._id,
    name: this.name,
    avatar: this.avatar,
    bio: this.bio,
    tags: this.tags,
  };
};

// ── Static methods ────────────────────────────────────────────────────────────

// findByEmail: used in login and registration flows.
// Explicitly selects password so comparePassword() can be called on the result.
UserSchema.statics.findByEmail = function (email) {
  return this.findOne({ email: email.toLowerCase().trim() }).select('+password');
};

const User = mongoose.model('User', UserSchema);

export default User;