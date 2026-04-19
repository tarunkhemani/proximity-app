import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import User from '../models/User.js';
import Location from '../models/Location.js';
import Message, { MESSAGE_TYPES } from '../models/Message.js';
import { getNearbyAndOnlineUsers } from '../services/proximity.js';
import {
  pubClient,
  RedisKeys,
  setPresence,
  setSocketId,
  getSocketId,
  removeUserKeys,
} from '../config/redis.js';

// ── Constants ─────────────────────────────────────────────────────────────────

// How often a client must emit location:update to stay "alive" in Redis.
// The TTL index on Location documents is 120s, and we refresh presence every
// 15s from the client. This server-side guard rejects suspiciously fast updates.
const LOCATION_UPDATE_COOLDOWN_MS = 8_000; // reject if < 8s since last update

// Maximum beacon duration a client can request. Matches the User schema max.
const MAX_BEACON_DURATION_MINUTES = 480; // 8 hours
const MIN_BEACON_DURATION_MINUTES = 5;

// How long to keep a per-user beacon timeout reference so we can cancel it
// if the user stops their beacon early or disconnects.
// Stored in module scope — survives across event handlers for the same process.
const beaconTimers = new Map(); // userId (string) → NodeJS.Timeout

// ── Authentication middleware ─────────────────────────────────────────────────
// Runs once per connection attempt BEFORE the 'connection' event fires.
// If it calls next(err), the socket is rejected — no 'connection' event fires
// and the client receives an error object with the rejection reason.
//
// The client must send its JWT in the auth payload:
//   const socket = io('http://localhost:5000', { auth: { token: 'Bearer eyJ...' } });
function attachAuthMiddleware(io) {
  io.use(async (socket, next) => {
    try {
      const raw = socket.handshake.auth?.token || socket.handshake.headers?.authorization;

      if (!raw) {
        return next(new Error('AUTH_MISSING: No token provided'));
      }

      // Support both "Bearer <token>" and raw token formats
      const token = raw.startsWith('Bearer ') ? raw.slice(7) : raw;

      // Verify signature and expiry — throws if invalid
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      if (!decoded?.userId) {
        return next(new Error('AUTH_INVALID: Token payload malformed'));
      }

      // Fetch the user to confirm account is still active.
      // We attach the lean user object to the socket so all handlers can read
      // it without hitting the DB again on every event.
      const user = await User.findById(decoded.userId).lean();

      if (!user) {
        return next(new Error('AUTH_INVALID: User not found'));
      }

      if (!user.isActive) {
        return next(new Error('AUTH_FORBIDDEN: Account is deactivated'));
      }

      // Attach to socket for downstream handler access
      socket.userId = user._id.toString();
      socket.userDoc = user; // lean — no Mongoose methods, just plain object

      next(); // proceed to connection
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return next(new Error('AUTH_EXPIRED: Token has expired'));
      }
      if (err.name === 'JsonWebTokenError') {
        return next(new Error('AUTH_INVALID: Token signature invalid'));
      }
      console.error('[socket:auth] Unexpected error:', err.message);
      next(new Error('AUTH_ERROR: Authentication failed'));
    }
  });
}

// ── Rate limiter (per-user, per-event) ───────────────────────────────────────
// Checks a sliding-window counter in Redis before processing an event.
// Returns true if the event should be processed, false if it should be dropped.
//
// @param {string} userId
// @param {string} eventName   - used to namespace the key (e.g. 'location_update')
// @param {number} windowMs    - window size in milliseconds
// @param {number} maxCalls    - max allowed calls within the window
async function checkRateLimit(userId, eventName, windowMs, maxCalls) {
  const key = `ratelimit:${eventName}:${userId}`;
  const windowSeconds = Math.ceil(windowMs / 1000);

  // Lua script for atomic increment + expiry — prevents race conditions
  // where two near-simultaneous events both read count=0 before either writes.
  const script = `
    local current = redis.call('INCR', KEYS[1])
    if current == 1 then
      redis.call('EXPIRE', KEYS[1], ARGV[1])
    end
    return current
  `;

  const count = await pubClient.eval(script, 1, key, windowSeconds);
  return count <= maxCalls;
}

// ── Emit a targeted event to a specific user (across all server processes) ────
// Looks up the user's socket ID from Redis, then emits via io.to(socketId).
// Because we use the Redis adapter, io.to() works even if the target socket
// is connected to a different Node process.
//
// Returns true if the user had an active socket, false if they were offline.
async function emitToUser(io, toUserId, event, payload) {
  const socketId = await getSocketId(toUserId.toString());
  if (!socketId) return false;

  io.to(socketId).emit(event, payload);
  return true;
}

// ── Beacon timer management ────────────────────────────────────────────────────
// Clears any existing beacon timer for the user before setting a new one.
// This prevents multiple timers stacking if beacon:start is called repeatedly.
function scheduleBeaconShutoff(io, userId, durationMs) {
  // Cancel any existing timer for this user
  clearBeaconTimer(userId);

  const timer = setTimeout(async () => {
    try {
      beaconTimers.delete(userId);

      // Deactivate beacon in the database
      await User.findByIdAndUpdate(userId, {
        isVisible: false,
        beaconExpiresAt: null,
      });

      // Remove their location document immediately rather than waiting for TTL
      await Location.deleteOne({ userId });

      // Remove Redis presence so they disappear from others' proximity results
      await removeUserKeys(userId);

      // Notify the user's own socket that their beacon expired
      const didEmit = await emitToUser(io, userId, 'beacon:expired', {
        message: 'Your beacon has expired. You are no longer visible to others.',
        expiredAt: new Date().toISOString(),
      });

      if (!didEmit) {
        // User disconnected before the timer fired — cleanup already handled
        // by the disconnect handler. Nothing left to do.
        console.log(`[beacon] User ${userId} beacon expired but socket was already closed`);
      }
    } catch (err) {
      console.error(`[beacon] Auto-shutoff error for user ${userId}:`, err.message);
    }
  }, durationMs);

  beaconTimers.set(userId, timer);
}

function clearBeaconTimer(userId) {
  const existing = beaconTimers.get(userId);
  if (existing) {
    clearTimeout(existing);
    beaconTimers.delete(userId);
  }
}

// ── Input validators ──────────────────────────────────────────────────────────
// Validate incoming socket event payloads before touching the database.
// Returns { valid: boolean, error?: string }.

function validateCoordinates(longitude, latitude) {
  if (typeof longitude !== 'number' || typeof latitude !== 'number') {
    return { valid: false, error: 'longitude and latitude must be numbers' };
  }
  if (longitude < -180 || longitude > 180) {
    return { valid: false, error: 'longitude must be between -180 and 180' };
  }
  if (latitude < -90 || latitude > 90) {
    return { valid: false, error: 'latitude must be between -90 and 90' };
  }
  return { valid: true };
}

function validateObjectId(id, fieldName = 'id') {
  if (!id || !mongoose.Types.ObjectId.isValid(id)) {
    return { valid: false, error: `${fieldName} must be a valid ObjectId` };
  }
  return { valid: true };
}

// ── Main export ────────────────────────────────────────────────────────────────
export function registerSocketHandlers(io) {
  // Attach JWT auth middleware — runs before every connection
  attachAuthMiddleware(io);

  io.on('connection', async (socket) => {
    const { userId } = socket; // set by auth middleware

    console.log(`[socket] Connected: userId=${userId} socketId=${socket.id}`);

    // ── On connect: register this socket in Redis ────────────────────────────
    // Any server process can now reach this socket via io.to(socketId)
    try {
      await setSocketId(userId, socket.id);
      await setPresence(userId, 30); // initial presence heartbeat
    } catch (err) {
      console.error(`[socket] Failed to register presence for ${userId}:`, err.message);
      // Non-fatal — socket continues, but proximity features may degrade
    }

    // Notify the connecting client of their resolved identity and any
    // unread message count so the UI can initialise correctly.
    try {
      const unreadCount = await Message.getUnreadCount(userId);
      socket.emit('session:ready', {
        userId,
        socketId: socket.id,
        unreadCount,
        serverTime: new Date().toISOString(),
      });
    } catch (err) {
      console.error(`[socket] Failed to emit session:ready to ${userId}:`, err.message);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // BEACON CONTROL
    // ══════════════════════════════════════════════════════════════════════════

    // beacon:start — user opts into proximity broadcasting
    //
    // Payload: { durationMinutes?: number }
    // Response events:
    //   beacon:started  → emitted back to this socket on success
    //   error           → emitted back on validation / DB failure
    socket.on('beacon:start', async (payload = {}) => {
      try {
        let { durationMinutes = 60 } = payload;

        // Clamp duration to allowed range
        durationMinutes = Math.max(
          MIN_BEACON_DURATION_MINUTES,
          Math.min(MAX_BEACON_DURATION_MINUTES, Number(durationMinutes) || 60)
        );

        const expiresAt = new Date(Date.now() + durationMinutes * 60_000);

        // Persist beacon state to the database
        const updatedUser = await User.findByIdAndUpdate(
          userId,
          {
            isVisible: true,
            beaconExpiresAt: expiresAt,
            beaconDuration: durationMinutes,
          },
          { new: true }
        );

        if (!updatedUser) {
          return socket.emit('error', { event: 'beacon:start', message: 'User not found' });
        }

        // Schedule the server-side auto-shutoff
        // This fires even if the client disconnects and reconnects — the timer
        // lives on the server process. If the server restarts, the DB expiry
        // field acts as the fallback guard in the $geoNear aggregation.
        scheduleBeaconShutoff(io, userId, durationMinutes * 60_000);

        socket.emit('beacon:started', {
          isVisible: true,
          beaconExpiresAt: expiresAt.toISOString(),
          durationMinutes,
          message: `You are now visible to others for ${durationMinutes} minutes.`,
        });

        console.log(`[beacon] User ${userId} started beacon for ${durationMinutes} minutes`);
      } catch (err) {
        console.error(`[beacon:start] Error for user ${userId}:`, err.message);
        socket.emit('error', { event: 'beacon:start', message: 'Failed to start beacon' });
      }
    });

    // beacon:stop — user explicitly opts out of proximity broadcasting
    //
    // Payload: none
    // Response events:
    //   beacon:stopped → emitted back to this socket on success
    socket.on('beacon:stop', async () => {
      try {
        // Cancel any pending auto-shutoff for this user
        clearBeaconTimer(userId);

        // Deactivate in the database
        await User.findByIdAndUpdate(userId, {
          isVisible: false,
          beaconExpiresAt: null,
        });

        // Remove their location document immediately — don't wait for TTL.
        // This makes them disappear from nearby users' lists instantly.
        await Location.deleteOne({ userId });

        // Downgrade presence to just the socket key (still connected, not broadcasting)
        await pubClient.del(RedisKeys.presence(userId));

        socket.emit('beacon:stopped', {
          isVisible: false,
          message: 'You are no longer visible to others.',
        });

        console.log(`[beacon] User ${userId} manually stopped beacon`);
      } catch (err) {
        console.error(`[beacon:stop] Error for user ${userId}:`, err.message);
        socket.emit('error', { event: 'beacon:stop', message: 'Failed to stop beacon' });
      }
    });

    // ══════════════════════════════════════════════════════════════════════════
    // LOCATION UPDATES
    // ══════════════════════════════════════════════════════════════════════════

    // location:update — client pushes a new GPS fix
    //
    // Emitted by the client every 15 seconds (when beacon is active).
    // Server upserts the Location document, refreshes Redis presence,
    // queries nearby users, and sends targeted proximity:appeared events.
    //
    // Payload: { longitude: number, latitude: number, accuracy?: number }
    // Response events:
    //   location:acknowledged   → confirms the update was processed
    //   proximity:nearby        → list of nearby users sent back to this socket
    //   proximity:appeared      → sent TO nearby users (not this socket)
    socket.on('location:update', async (payload = {}) => {
  try {
    const { longitude, latitude, accuracy } = payload;

    // 🔍 LOG 2a — confirms the event arrived at the server
    console.log(`[location:update] Received from userId=${userId}`, { longitude, latitude, accuracy });

    const coordCheck = validateCoordinates(longitude, latitude);
    if (!coordCheck.valid) {
      console.warn('[location:update] Coordinate validation failed:', coordCheck.error);
      return socket.emit('error', { event: 'location:update', message: coordCheck.error });
    }

    const allowed = await checkRateLimit(userId, 'location_update', LOCATION_UPDATE_COOLDOWN_MS, 1);
    // 🔍 LOG 2b — if this is false the event is silently dropped; very common bug during testing
    console.log(`[location:update] Rate limit check — allowed: ${allowed}`);
    if (!allowed) {
      console.warn(`[location:update] RATE LIMITED — userId=${userId}. This is silent on the frontend.`);
      return;
    }

    await Location.upsertLocation({ userId, longitude, latitude, accuracy });
    // 🔍 LOG 2c — confirms the upsert succeeded
    console.log(`[location:update] Location upserted for userId=${userId}`);

    await setPresence(userId, 30);

    socket.emit('location:acknowledged', { processedAt: new Date().toISOString() });

    const requestingUser = await User.findById(userId).lean();
    // 🔍 LOG 2d — the most common silent failure: beacon looks active on the
    // frontend but isVisible or beaconExpiresAt is wrong in the database
    console.log(`[location:update] Requesting user beacon state:`, {
      isVisible:       requestingUser?.isVisible,
      beaconExpiresAt: requestingUser?.beaconExpiresAt,
      isExpired:       requestingUser?.beaconExpiresAt
                         ? new Date(requestingUser.beaconExpiresAt) < new Date()
                         : 'null',
    });

    const nearbyUsers = await getNearbyAndOnlineUsers({
      coords: [longitude, latitude],
      excludeUserId: userId,
      radiusMeters: 200,
      limit: 50,
    });

    // 🔍 LOG 2e — the aggregation result; if this is [] the bug is in the DB layer
    console.log(`[location:update] getNearbyAndOnlineUsers returned ${nearbyUsers.length} users:`, nearbyUsers);

    socket.emit('proximity:nearby', {
      users:       nearbyUsers,
      count:       nearbyUsers.length,
      queriedAt:   new Date().toISOString(),
      radiusMeters: 200,
    });

    const requestingUserIsBeaconing =
      requestingUser?.isVisible &&
      requestingUser?.beaconExpiresAt &&
      new Date(requestingUser.beaconExpiresAt) > new Date();

    // 🔍 LOG 2f — if false, proximity:appeared is never sent to other users
    console.log(`[location:update] requestingUserIsBeaconing: ${requestingUserIsBeaconing}`);

    if (requestingUserIsBeaconing) {
      const zone = Location.snapToZone(longitude, latitude);
      console.log(`[location:update] Snapped to zone: ${zone}`);

      nearbyUsers.forEach(async (nearbyUser) => {
        try {
          const targetSocketId = await getSocketId(nearbyUser.userId.toString());
          // 🔍 LOG 2g — if targetSocketId is null that user has no socket registered in Redis
          console.log(`[location:update] Emitting proximity:appeared to userId=${nearbyUser.userId} | socketId=${targetSocketId}`);
          const didEmit = await emitToUser(io, nearbyUser.userId, 'proximity:appeared', {
            userId:   userId,
            name:     requestingUser.name,
            avatar:   requestingUser.avatar,
            bio:      requestingUser.bio,
            tags:     requestingUser.tags,
            zone,
          });
          console.log(`[location:update] proximity:appeared emitted: ${didEmit}`);
        } catch (err) {
          console.error(`[proximity] Failed emit to ${nearbyUser.userId}:`, err.message);
        }
      });
    }
  } catch (err) {
    console.error(`[location:update] Error for user ${userId}:`, err.message);
    socket.emit('error', { event: 'location:update', message: 'Failed to process location update' });
  }
});
    // socket.on('location:update', async (payload = {}) => {
    //   try {
    //     const { longitude, latitude, accuracy } = payload;

    //     // ── Validate coordinates ─────────────────────────────────────────────
    //     const coordCheck = validateCoordinates(longitude, latitude);
    //     if (!coordCheck.valid) {
    //       return socket.emit('error', { event: 'location:update', message: coordCheck.error });
    //     }

    //     // ── Rate limit: max 1 update per 8 seconds per user ──────────────────
    //     // Prevents battery-drain attacks or misbehaving clients from hammering
    //     // the DB with upserts and proximity queries.
    //     const allowed = await checkRateLimit(userId, 'location_update', LOCATION_UPDATE_COOLDOWN_MS, 1);
    //     if (!allowed) {
    //       // Silently drop — don't emit an error because legitimate clients will
    //       // occasionally hit this on reconnect. Just don't process the event.
    //       return;
    //     }

    //     // ── Upsert location in MongoDB ────────────────────────────────────────
    //     // snapToZone runs inside upsertLocation — the raw GPS is never stored
    //     // in the zone field, and the zone is derived server-side.
    //     await Location.upsertLocation({ userId, longitude, latitude, accuracy });

    //     // ── Refresh Redis presence heartbeat ──────────────────────────────────
    //     // TTL is 30s — the client emits every 15s, so there is comfortable
    //     // headroom before the key expires and the user appears "offline".
    //     await setPresence(userId, 30);

    //     // ── Acknowledge to the sender ─────────────────────────────────────────
    //     socket.emit('location:acknowledged', {
    //       processedAt: new Date().toISOString(),
    //     });

    //     // ── Query nearby users ────────────────────────────────────────────────
    //     // Only run the proximity query if this user's own beacon is active.
    //     // If they are not broadcasting, they shouldn't appear to others,
    //     // but they can still receive the list of nearby people.
    //     const nearbyUsers = await getNearbyAndOnlineUsers({
    //       coords: [longitude, latitude],
    //       excludeUserId: userId,
    //       radiusMeters: 200,
    //       limit: 50,
    //     });

    //     // ── Send the nearby list back to this socket ──────────────────────────
    //     // The React frontend uses this to render the "people nearby" feed.
    //     socket.emit('proximity:nearby', {
    //       users: nearbyUsers,
    //       count: nearbyUsers.count,
    //       queriedAt: new Date().toISOString(),
    //       radiusMeters: 200,
    //     });

    //     // ── Emit proximity:appeared to each nearby user ───────────────────────
    //     // Only do this if the requesting user's own beacon is active —
    //     // a user who has opted out of broadcasting should not appear
    //     // on other people's radars even if they are querying proximity.
    //     const requestingUser = await User.findById(userId).lean();
    //     const requestingUserIsBeaconing =
    //       requestingUser?.isVisible &&
    //       requestingUser?.beaconExpiresAt &&
    //       new Date(requestingUser.beaconExpiresAt) > new Date();

    //     if (requestingUserIsBeaconing) {
    //       // Snap the requesting user's zone for the appeared event payload
    //       const zone = Location.snapToZone(longitude, latitude);

    //       // Fire-and-forget targeted emissions — we don't await individual emits
    //       // to avoid blocking this handler. Failures are non-fatal (the user's
    //       // next location:update will re-trigger proximity:appeared anyway).
    //       const appearancePayload = {
    //         userId,
    //         name: requestingUser.name,
    //         avatar: requestingUser.avatar,
    //         bio: requestingUser.bio,
    //         tags: requestingUser.tags,
    //         zone,
    //         // We intentionally do NOT include distanceMeters from the requesting
    //         // user's perspective — each recipient's distance is computed from
    //         // THEIR own last known location, not the sender's.
    //       };

    //       // Emit to each nearby user's socket without awaiting
    //       nearbyUsers.forEach(async (nearbyUser) => {
    //         try {
    //           await emitToUser(io, nearbyUser.userId, 'proximity:appeared', appearancePayload);
    //         } catch (err) {
    //           // Swallow — a single failed emission shouldn't affect others
    //           console.error(
    //             `[proximity] Failed to emit appeared to ${nearbyUser.userId}:`,
    //             err.message
    //           );
    //         }
    //       });
    //     }
    //   } catch (err) {
    //     console.error(`[location:update] Error for user ${userId}:`, err.message);
    //     socket.emit('error', { event: 'location:update', message: 'Failed to process location update' });
    //   }
    // });

    // ══════════════════════════════════════════════════════════════════════════
    // CONNECTION REQUESTS
    // ══════════════════════════════════════════════════════════════════════════

    // connect:request — user sends a connection request to another nearby user
    //
    // Payload: { toUserId: string, message?: string }
    // Response events:
    //   connect:request_sent    → back to sender confirming request was recorded
    //   connect:incoming        → sent to the recipient
    //   error                   → sent to sender on failure
socket.on('connect:request', async (payload = {}) => {
  try {
    const { toUserId, message = '' } = payload;

    // ── Validate target user ID ───────────────────────────────────────────
    const idCheck = validateObjectId(toUserId, 'toUserId');
    if (!idCheck.valid) {
      return socket.emit('error', { event: 'connect:request', message: idCheck.error });
    }

    if (toUserId === userId) {
      return socket.emit('error', {
        event:   'connect:request',
        message: 'You cannot send a connection request to yourself',
      });
    }

    // ── Rate limit ────────────────────────────────────────────────────────
    const allowed = await checkRateLimit(userId, 'connect_request', 60_000, 10);
    if (!allowed) {
      return socket.emit('error', {
        event:   'connect:request',
        message: 'Too many connection requests. Please wait before trying again.',
      });
    }

    // ── Fetch sender document ─────────────────────────────────────────────
    const sender = await User.findById(userId).lean();

    // ── Check: already connected ──────────────────────────────────────────
    const alreadyConnected = sender.connections?.map(String).includes(toUserId);
    if (alreadyConnected) {
      // Clean up any stale pending entry while we're here
      await User.findByIdAndUpdate(userId, { $pull: { pendingRequestsSent: toUserId } });
      return socket.emit('error', {
        event:   'connect:request',
        message: 'You are already connected with this user',
      });
    }

    // ── Check: pending request — verify against Message collection ────────
    // We do NOT trust pendingRequestsSent alone because it can contain stale
    // entries from previous sessions where the accept/decline flow was
    // interrupted (e.g. server restart, incomplete testing).
    // The Message document is the authoritative source of truth.
    const roomId = Message.buildRoomId(userId, toUserId);

    const existingRequest = await Message.findOne({
      roomId,
      type:     'connect_request',
      senderId: userId,
    }).lean();

    if (existingRequest) {
      return socket.emit('error', {
        event:   'connect:request',
        message: 'A connection request to this user is already pending',
      });
    }

    // ── Stale pendingRequestsSent cleanup ─────────────────────────────────
    // If the array says pending but no Message document exists, the entry is
    // orphaned. Remove it silently so it cannot block future requests.
    const arrayClaimsStale = sender.pendingRequestsSent?.map(String).includes(toUserId);
    if (arrayClaimsStale) {
      await User.findByIdAndUpdate(userId, { $pull: { pendingRequestsSent: toUserId } });
    }

    // ── Recipient exists check ────────────────────────────────────────────
    const recipient = await User.findById(toUserId).lean();
    if (!recipient || !recipient.isActive) {
      return socket.emit('error', { event: 'connect:request', message: 'User not found' });
    }

    // ── Sanitise message ──────────────────────────────────────────────────
    const safeMessage = String(message).trim().slice(0, 200);

    // ── Persist the request as a Message document ─────────────────────────
    const requestMsg = await Message.create({
      roomId,
      senderId:    userId,
      recipientId: toUserId,
      content:     safeMessage || `Hi! I spotted you nearby and would love to connect.`,
      type:        'connect_request',
    });

    // ── Record pending on sender's document ───────────────────────────────
    await User.findByIdAndUpdate(userId, {
      $addToSet: { pendingRequestsSent: toUserId },
    });

    // ── Confirm to sender ─────────────────────────────────────────────────
    socket.emit('connect:request_sent', {
      toUserId,
      roomId,
      messageId: requestMsg._id,
      sentAt:    requestMsg.createdAt,
    });

    // ── Notify recipient if online ────────────────────────────────────────
    await emitToUser(io, toUserId, 'connect:incoming', {
      fromUserId:  userId,
      fromName:    sender.name,
      fromAvatar:  sender.avatar,
      fromBio:     sender.bio,
      fromTags:    sender.tags,
      message:     requestMsg.content,
      roomId,
      messageId:   requestMsg._id,
      sentAt:      requestMsg.createdAt,
    });

    console.log(`[connect] User ${userId} sent request to ${toUserId}`);
  } catch (err) {
    console.error(`[connect:request] Error for user ${userId}:`, err.message);
    socket.emit('error', { event: 'connect:request', message: 'Failed to send connection request' });
  }
});

    // connect:accept — recipient accepts an incoming connection request
    //
    // Payload: { fromUserId: string, messageId: string }
    // Response events:
    //   connect:accepted        → sent to the accepting user (joins the chat room)
    //   connect:you_were_accepted → sent to the original requester
    //   error                   → sent to accepting user on failure
    socket.on('connect:accept', async (payload = {}) => {
      try {
        const { fromUserId, messageId } = payload;

        // ── Validate inputs ───────────────────────────────────────────────────
        const fromIdCheck = validateObjectId(fromUserId, 'fromUserId');
        if (!fromIdCheck.valid) {
          return socket.emit('error', { event: 'connect:accept', message: fromIdCheck.error });
        }

        const msgIdCheck = validateObjectId(messageId, 'messageId');
        if (!msgIdCheck.valid) {
          return socket.emit('error', { event: 'connect:accept', message: msgIdCheck.error });
        }

        // ── Verify the original request message exists ─────────────────────────
        const requestMsg = await Message.findOne({
          _id: messageId,
          type: MESSAGE_TYPES.CONNECT_REQUEST,
          senderId: fromUserId,
          recipientId: userId,
        });

        if (!requestMsg) {
          return socket.emit('error', {
            event: 'connect:accept',
            message: 'Connection request not found or already handled',
          });
        }

        const roomId = Message.buildRoomId(userId, fromUserId);

        // ── Persist the accepted connection on both user documents ─────────────
        // $addToSet is idempotent — safe to call even if already connected.
// Inside connect:accept, find this Promise.all block and replace it:
        await Promise.all([
        User.findByIdAndUpdate(userId, {
            $addToSet: { connections: fromUserId },
            // If this user had also sent a request to fromUserId, clear it
            $pull: { pendingRequestsSent: fromUserId },
        }),
        User.findByIdAndUpdate(fromUserId, {
            $addToSet: { connections: userId },
            // Clear the original pending request that was just accepted
            $pull: { pendingRequestsSent: userId },
        }),
        ]);

        // ── Create a system message to anchor the chat history ─────────────────
        await Message.create({
          roomId,
          senderId: userId,
          recipientId: fromUserId,
          content: `${socket.userDoc?.name || 'Someone'} accepted your connection request.`,
          type: MESSAGE_TYPES.CONNECT_ACCEPT,
          delivered: true,
          readAt: new Date(),
        });

        // ── Join the accepting user's socket to the private room ───────────────
        socket.join(roomId);

        // ── Confirm to the accepting user ─────────────────────────────────────
        const acceptingUser = await User.findById(userId).lean();
        socket.emit('connect:accepted', {
          withUserId: fromUserId,
          roomId,
          message: 'Connection accepted! You can now chat.',
        });

        // ── Notify the original requester ──────────────────────────────────────
        const requesterSocketId = await getSocketId(fromUserId);
        if (requesterSocketId) {
          // Join the requester's socket to the same room so both are members
          const requesterSocket = io.sockets.sockets.get(requesterSocketId);
          if (requesterSocket) {
            requesterSocket.join(roomId);
          }

          io.to(requesterSocketId).emit('connect:you_were_accepted', {
            byUserId: userId,
            byName: acceptingUser?.name,
            byAvatar: acceptingUser?.avatar,
            roomId,
            message: `${acceptingUser?.name || 'Someone'} accepted your connection request!`,
          });
        }

        console.log(`[connect] User ${userId} accepted request from ${fromUserId} → room ${roomId}`);
      } catch (err) {
        console.error(`[connect:accept] Error for user ${userId}:`, err.message);
        socket.emit('error', { event: 'connect:accept', message: 'Failed to accept connection request' });
      }
    });

    // connect:decline — recipient declines an incoming connection request
    //
    // Payload: { fromUserId: string, messageId: string }
    // No event is emitted to the requester (silent decline — common UX pattern).
    socket.on('connect:decline', async (payload = {}) => {
      try {
        const { fromUserId, messageId } = payload;

        const idCheck = validateObjectId(fromUserId, 'fromUserId');
        if (!idCheck.valid) {
          return socket.emit('error', { event: 'connect:decline', message: idCheck.error });
        }

        // Remove from the requester's pending list so they can try again later
        await User.findByIdAndUpdate(fromUserId, {
        $pull: { pendingRequestsSent: userId },
        });

        // Soft-delete or mark the request message as declined
        if (messageId && mongoose.Types.ObjectId.isValid(messageId)) {
          await Message.findByIdAndUpdate(messageId, {
            type: MESSAGE_TYPES.CONNECT_DECLINE,
          });
        }

        socket.emit('connect:declined', {
          fromUserId,
          message: 'Connection request declined.',
        });

        console.log(`[connect] User ${userId} declined request from ${fromUserId}`);
      } catch (err) {
        console.error(`[connect:decline] Error for user ${userId}:`, err.message);
        socket.emit('error', { event: 'connect:decline', message: 'Failed to decline connection request' });
      }
    });

    // ══════════════════════════════════════════════════════════════════════════
    // CHAT
    // ══════════════════════════════════════════════════════════════════════════

    // chat:join — client explicitly joins a chat room after page load/refresh.
    //
    // Payload: { roomId: string }
    // Called by the React client when a user navigates to a conversation.
    // Without this, a user who refreshed the page wouldn't be in the Socket.io
    // room and wouldn't receive real-time messages.
    socket.on('chat:join', async (payload = {}) => {
      try {
        const { roomId } = payload;

        if (!roomId || typeof roomId !== 'string') {
          return socket.emit('error', { event: 'chat:join', message: 'roomId is required' });
        }

        // ── Authorisation check ───────────────────────────────────────────────
        // Verify this user is actually a participant of the room by checking
        // that their userId appears at the start or end of the roomId string.
        // (roomId = [userA, userB].sort().join('_'))
        const participantIds = roomId.split('_');
        if (participantIds.length !== 2 || !participantIds.includes(userId)) {
          return socket.emit('error', {
            event: 'chat:join',
            message: 'You are not a participant of this room',
          });
        }

        // Additional DB check — confirm an accepted connection exists
        const connectionExists = await Message.exists({
          roomId,
          type: MESSAGE_TYPES.CONNECT_ACCEPT,
        });

        if (!connectionExists) {
          return socket.emit('error', {
            event: 'chat:join',
            message: 'No accepted connection found for this room',
          });
        }

        socket.join(roomId);

        // Mark all messages in this room as read since the user has opened it
        await Message.markRoomAsRead(roomId, userId);

        socket.emit('chat:joined', {
          roomId,
          joinedAt: new Date().toISOString(),
        });

        console.log(`[chat] User ${userId} joined room ${roomId}`);
      } catch (err) {
        console.error(`[chat:join] Error for user ${userId}:`, err.message);
        socket.emit('error', { event: 'chat:join', message: 'Failed to join chat room' });
      }
    });

    // chat:message — user sends a message in an established conversation
    //
    // Payload: { roomId: string, content: string }
    // Response events:
    //   chat:message  → broadcast to ALL sockets in the room (including sender,
    //                   so the sender's UI can confirm delivery and get the _id)
    //   error         → sent back to sender on validation / auth failure
    // sockets/index.js — chat:message handler
// Find the line that builds messagePayload and add clientId to it:

socket.on('chat:message', async (payload = {}) => {
  try {
    const { roomId, content, clientId } = payload;

    // ── Validate payload ──────────────────────────────────────────────────
    if (!roomId || typeof roomId !== 'string') {
      return socket.emit('error', { event: 'chat:message', message: 'roomId is required' });
    }
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return socket.emit('error', { event: 'chat:message', message: 'Message content cannot be empty' });
    }

    const safeContent = content.trim().slice(0, 1000);

    // ── Participant check — derived from roomId, no async needed ──────────
    // roomId is always [sortedId1]_[sortedId2]. If userId isn't one of the
    // two segments, this user has no business sending to this room.
    // This replaces the socket.rooms.has() check which had a race condition:
    // chat:message could arrive before chat:join was fully processed on the
    // server, causing every message to be silently rejected.
    const participantIds = roomId.split('_');
    if (
      participantIds.length !== 2 ||
      !mongoose.Types.ObjectId.isValid(participantIds[0]) ||
      !mongoose.Types.ObjectId.isValid(participantIds[1]) ||
      !participantIds.includes(userId)
    ) {
      return socket.emit('error', {
        event:   'chat:message',
        message: 'You are not a participant of this room',
      });
    }

    // ── Auto-join the Socket.io room if not already a member ──────────────
    // This handles two cases:
    //   1. Race condition: chat:message arrived before chat:join was processed
    //   2. Reconnect: socket got a new ID, is no longer in the room object
    // The DB-level participant check above already enforces authorisation,
    // so joining here is safe.
    if (!socket.rooms.has(roomId)) {
      console.log(`[chat] Auto-joining room ${roomId} for userId=${userId}`);
      socket.join(roomId);
    }

    // ── Rate limit ────────────────────────────────────────────────────────
    const allowed = await checkRateLimit(userId, 'chat_message', 60_000, 30);
    if (!allowed) {
      return socket.emit('error', {
        event:   'chat:message',
        message: 'Sending too quickly. Please slow down.',
      });
    }

    // ── Derive recipientId ─────────────────────────────────────────────────
    const recipientId = participantIds.find((id) => id !== userId);
    if (!recipientId) {
      return socket.emit('error', {
        event:   'chat:message',
        message: 'Could not determine message recipient',
      });
    }

    // ── Persist to MongoDB ─────────────────────────────────────────────────
    const savedMessage = await Message.create({
      roomId,
      senderId:    userId,
      recipientId,
      content:     safeContent,
      type:        'text',
      delivered:   true,
    });

    // ── Build broadcast payload ────────────────────────────────────────────
    const messagePayload = {
      _id:          savedMessage._id,
      roomId,
      senderId:     userId,       // always a plain string on the socket path
      recipientId,
      senderName:   socket.userDoc?.name,
      senderAvatar: socket.userDoc?.avatar,
      content:      safeContent,
      type:         'text',
      delivered:    true,
      readAt:       null,
      createdAt:    savedMessage.createdAt,
      // clientId echoed back so the sender can replace its optimistic bubble
      clientId:     clientId ?? null,
    };

    // ── Broadcast to room ──────────────────────────────────────────────────
    // io.to(roomId) includes the sender — the sender's listener uses
    // clientId to find and replace the optimistic bubble in local state.
    io.to(roomId).emit('chat:message', messagePayload);

    // ── Push notification if recipient is not in the room ──────────────────
    const recipientSocketId = await getSocketId(recipientId);
    const recipientSocket   = recipientSocketId
      ? io.sockets.sockets.get(recipientSocketId)
      : null;
    const recipientInRoom = recipientSocket?.rooms?.has(roomId);

    if (recipientSocketId && !recipientInRoom) {
      io.to(recipientSocketId).emit('chat:notification', {
        roomId,
        fromUserId:  userId,
        fromName:    socket.userDoc?.name,
        fromAvatar:  socket.userDoc?.avatar,
        preview:     safeContent.slice(0, 60),
        createdAt:   savedMessage.createdAt,
      });
    }

    console.log(`[chat] Message saved in room ${roomId} from ${userId} (${safeContent.length} chars)`);
  } catch (err) {
    console.error(`[chat:message] Error for user ${userId}:`, err.message);
    socket.emit('error', {
      event:   'chat:message',
      message: 'Failed to send message',
    });
  }
});
    // socket.on('chat:message', async (payload = {}) => {
    //   try {
    //     const { roomId, content } = payload;

    //     // ── Validate payload ──────────────────────────────────────────────────
    //     if (!roomId || typeof roomId !== 'string') {
    //       return socket.emit('error', { event: 'chat:message', message: 'roomId is required' });
    //     }

    //     if (!content || typeof content !== 'string' || content.trim().length === 0) {
    //       return socket.emit('error', {
    //         event: 'chat:message',
    //         message: 'Message content cannot be empty',
    //       });
    //     }

    //     const safeContent = content.trim().slice(0, 1000);

    //     // ── Authorisation: must be a member of the Socket.io room ─────────────
    //     // socket.rooms is a Set containing roomId strings this socket has joined.
    //     // This check ensures only participants who went through chat:join (and
    //     // therefore passed the DB connection check) can send messages.
    //     if (!socket.rooms.has(roomId)) {
    //       return socket.emit('error', {
    //         event: 'chat:message',
    //         message: 'You must join the room before sending messages',
    //       });
    //     }

    //     // ── Rate limit: max 30 messages per minute per user ───────────────────
    //     const allowed = await checkRateLimit(userId, 'chat_message', 60_000, 30);
    //     if (!allowed) {
    //       return socket.emit('error', {
    //         event: 'chat:message',
    //         message: 'Sending too quickly. Please slow down.',
    //       });
    //     }

    //     // ── Derive recipient from roomId ──────────────────────────────────────
    //     const participantIds = roomId.split('_');
    //     const recipientId = participantIds.find((id) => id !== userId);

    //     if (!recipientId || !mongoose.Types.ObjectId.isValid(recipientId)) {
    //       return socket.emit('error', { event: 'chat:message', message: 'Invalid roomId format' });
    //     }

    //     // ── Persist to MongoDB ────────────────────────────────────────────────
    //     const savedMessage = await Message.create({
    //       roomId,
    //       senderId: userId,
    //       recipientId,
    //       content: safeContent,
    //       type: MESSAGE_TYPES.TEXT,
    //       delivered: true, // they're in the room, so delivery is confirmed
    //     });

    //     // ── Populate sender info for the broadcast payload ────────────────────
    //     const messagePayload = {
    //       _id: savedMessage._id,
    //       roomId,
    //       senderId: userId,
    //       senderName: socket.userDoc?.name,
    //       senderAvatar: socket.userDoc?.avatar,
    //       content: safeContent,
    //       type: MESSAGE_TYPES.TEXT,
    //       delivered: true,
    //       readAt: null,
    //       createdAt: savedMessage.createdAt,
    //     };

    //     // ── Broadcast to the room ─────────────────────────────────────────────
    //     // io.to(roomId) emits to ALL sockets in the room including the sender.
    //     // The React client uses the echoed message to update its optimistic UI
    //     // state with the confirmed _id and createdAt from the server.
    //     io.to(roomId).emit('chat:message', messagePayload);

    //     // ── Handle offline recipient ──────────────────────────────────────────
    //     // If the recipient is not in the Socket.io room (disconnected or on a
    //     // different page), they won't receive the room broadcast.
    //     // We emit a push-style 'chat:notification' directly to their socket ID
    //     // so their notification badge updates even without being in the room.
    //     const recipientSocketId = await getSocketId(recipientId);
    //     const recipientSocket = recipientSocketId
    //       ? io.sockets.sockets.get(recipientSocketId)
    //       : null;
    //     const recipientInRoom = recipientSocket?.rooms?.has(roomId);

    //     if (recipientSocketId && !recipientInRoom) {
    //       io.to(recipientSocketId).emit('chat:notification', {
    //         roomId,
    //         fromUserId: userId,
    //         fromName: socket.userDoc?.name,
    //         fromAvatar: socket.userDoc?.avatar,
    //         preview: safeContent.slice(0, 60),
    //         createdAt: savedMessage.createdAt,
    //       });
    //     }

    //     console.log(`[chat] Message in room ${roomId} from ${userId} (${safeContent.length} chars)`);
    //   } catch (err) {
    //     console.error(`[chat:message] Error for user ${userId}:`, err.message);
    //     socket.emit('error', { event: 'chat:message', message: 'Failed to send message' });
    //   }
    // });

    // chat:read — client notifies server that messages have been read
    //
    // Payload: { roomId: string }
    // Emits a read receipt to the other participant so their UI can update
    // message tick state (grey → blue).
    socket.on('chat:read', async (payload = {}) => {
      try {
        const { roomId } = payload;

        if (!roomId || !socket.rooms.has(roomId)) return;

        await Message.markRoomAsRead(roomId, userId);

        // Notify the other participant of the read event
        const participantIds = roomId.split('_');
        const otherUserId = participantIds.find((id) => id !== userId);

        if (otherUserId) {
          await emitToUser(io, otherUserId, 'chat:read_receipt', {
            roomId,
            readBy: userId,
            readAt: new Date().toISOString(),
          });
        }
      } catch (err) {
        // Non-critical — swallow silently, read receipts are best-effort
        console.error(`[chat:read] Error for user ${userId}:`, err.message);
      }
    });

    // chat:typing — lightweight typing indicator (not persisted)
    //
    // Payload: { roomId: string, isTyping: boolean }
    // Forwarded directly to the room — no DB write needed.
    socket.on('chat:typing', (payload = {}) => {
      const { roomId, isTyping } = payload;

      if (!roomId || !socket.rooms.has(roomId)) return;

      // Broadcast to room EXCEPT the sender (socket.to vs io.to)
      socket.to(roomId).emit('chat:typing', {
        roomId,
        fromUserId: userId,
        isTyping: Boolean(isTyping),
      });
    });

    // ══════════════════════════════════════════════════════════════════════════
    // DISCONNECT & CLEANUP
    // ══════════════════════════════════════════════════════════════════════════

    // disconnect fires when a socket closes for any reason:
    //   - user closes the browser tab
    //   - mobile app goes to background (OS suspends network)
    //   - network timeout (pingTimeout exceeded)
    //   - server-side socket.disconnect() call
    //
    // We do NOT immediately deactivate the beacon here — the connectionStateRecovery
    // window (2 minutes, set in server.js) lets a user reconnect after a brief
    // network blip and resume without having to restart their beacon.
    // The Redis presence TTL (30s) and Location TTL index (120s) act as the
    // natural cleanup mechanism if they don't reconnect.
    socket.on('disconnect', async (reason) => {
      console.log(`[socket] Disconnected: userId=${userId} reason=${reason}`);

      try {
        // ── Clean up Redis socket ID mapping ──────────────────────────────────
        // Only delete if the stored socketId still matches THIS socket.
        // If the user reconnected on a new socket before this handler fired,
        // we must not wipe the new socket's entry.
        const storedSocketId = await getSocketId(userId);
        if (storedSocketId === socket.id) {
          await pubClient.del(RedisKeys.socketId(userId));

          // We deliberately do NOT delete the presence key here.
          // Presence expires on its own TTL (30s). This gives the client time to
          // reconnect (e.g. on a mobile network handoff) without disappearing
          // from nearby users' lists mid-session.
        }

        // ── NOTE on beacon timer ───────────────────────────────────────────────
        // We intentionally do NOT clear the beacon timer on disconnect.
        // The beacon should continue to count down even if the user is briefly
        // offline. If they do not reconnect before the timer fires, the timer
        // handler will attempt to emit beacon:expired — emitToUser will return
        // false (no socket), and the DB deactivation will still run correctly.
        //
        // If you want "disconnect = immediately stop beacon" behaviour,
        // uncomment the two lines below:
        //
        // clearBeaconTimer(userId);
        // await User.findByIdAndUpdate(userId, { isVisible: false, beaconExpiresAt: null });
      } catch (err) {
        console.error(`[disconnect] Cleanup error for user ${userId}:`, err.message);
      }
    });

    // Handle errors emitted on the socket itself (e.g. from middleware)
    socket.on('error', (err) => {
      console.error(`[socket:error] userId=${userId} error=${err.message}`);
    });
  });
}
// sockets/index.js — stub, replaced in Phase 4
// export function registerSocketHandlers(io) {
//   console.log('[socket.io] Handlers registered (stub)');
//   io.on('connection', (socket) => {
//     console.log(`[socket.io] Client connected: ${socket.id}`);
//     socket.on('disconnect', () => {
//       console.log(`[socket.io] Client disconnected: ${socket.id}`);
//     });
//   });
// }