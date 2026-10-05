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

const LOCATION_UPDATE_COOLDOWN_MS = 8_000; // reject if < 8s since last update

// Maximum beacon duration a client can request. Matches the User schema max.
const MAX_BEACON_DURATION_MINUTES = 480; // 8 hours
const MIN_BEACON_DURATION_MINUTES = 5;

const beaconTimers = new Map(); // userId (string) → NodeJS.Timeout

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

async function emitToUser(io, toUserId, event, payload) {
  const socketId = await getSocketId(toUserId.toString());
  if (!socketId) return false;

  io.to(socketId).emit(event, payload);
  return true;
}

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

export function registerSocketHandlers(io) {
  // Attach JWT auth middleware — runs before every connection
  attachAuthMiddleware(io);

  io.on('connection', async (socket) => {
    const { userId } = socket; // set by auth middleware

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

        scheduleBeaconShutoff(io, userId, durationMinutes * 60_000);

        socket.emit('beacon:started', {
          isVisible: true,
          beaconExpiresAt: expiresAt.toISOString(),
          durationMinutes,
          message: `You are now visible to others for ${durationMinutes} minutes.`,
        });

      } catch (err) {
        console.error(`[beacon:start] Error for user ${userId}:`, err.message);
        socket.emit('error', { event: 'beacon:start', message: 'Failed to start beacon' });
      }
    });

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

      } catch (err) {
        console.error(`[beacon:stop] Error for user ${userId}:`, err.message);
        socket.emit('error', { event: 'beacon:stop', message: 'Failed to stop beacon' });
      }
    });

    socket.on('location:update', async (payload = {}) => {
  try {
    const { longitude, latitude, accuracy } = payload;

    const coordCheck = validateCoordinates(longitude, latitude);
    if (!coordCheck.valid) {
      console.warn('[location:update] Coordinate validation failed:', coordCheck.error);
      return socket.emit('error', { event: 'location:update', message: coordCheck.error });
    }

    const allowed = await checkRateLimit(userId, 'location_update', LOCATION_UPDATE_COOLDOWN_MS, 1);
    if (!allowed) {
      console.warn(`[location:update] RATE LIMITED — userId=${userId}. This is silent on the frontend.`);
      return;
    }

    await Location.upsertLocation({ userId, longitude, latitude, accuracy });

    await setPresence(userId, 30);

    socket.emit('location:acknowledged', { processedAt: new Date().toISOString() });

    const requestingUser = await User.findById(userId).lean();

    const nearbyUsers = await getNearbyAndOnlineUsers({
      coords: [longitude, latitude],
      excludeUserId: userId,
      radiusMeters: 200,
      limit: 50,
    });

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

    if (requestingUserIsBeaconing) {
      const zone = Location.snapToZone(longitude, latitude);

      nearbyUsers.forEach(async (nearbyUser) => {
        try {
          const targetSocketId = await getSocketId(nearbyUser.userId.toString());
          const didEmit = await emitToUser(io, nearbyUser.userId, 'proximity:appeared', {
            userId:   userId,
            name:     requestingUser.name,
            avatar:   requestingUser.avatar,
            bio:      requestingUser.bio,
            tags:     requestingUser.tags,
            zone,
          });
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

socket.on('connect:request', async (payload = {}) => {
  try {
    const { toUserId, message = '' } = payload;

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

    const allowed = await checkRateLimit(userId, 'connect_request', 60_000, 10);
    if (!allowed) {
      return socket.emit('error', {
        event:   'connect:request',
        message: 'Too many connection requests. Please wait before trying again.',
      });
    }

    const sender = await User.findById(userId).lean();

    const alreadyConnected = sender.connections?.map(String).includes(toUserId);
    if (alreadyConnected) {
      // Clean up any stale pending entry while we're here
      await User.findByIdAndUpdate(userId, { $pull: { pendingRequestsSent: toUserId } });
      return socket.emit('error', {
        event:   'connect:request',
        message: 'You are already connected with this user',
      });
    }

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

    // If the array says pending but no Message document exists, the entry is
    // orphaned. Remove it silently so it cannot block future requests.
    const arrayClaimsStale = sender.pendingRequestsSent?.map(String).includes(toUserId);
    if (arrayClaimsStale) {
      await User.findByIdAndUpdate(userId, { $pull: { pendingRequestsSent: toUserId } });
    }

    const recipient = await User.findById(toUserId).lean();
    if (!recipient || !recipient.isActive) {
      return socket.emit('error', { event: 'connect:request', message: 'User not found' });
    }

    const safeMessage = String(message).trim().slice(0, 200);

    const requestMsg = await Message.create({
      roomId,
      senderId:    userId,
      recipientId: toUserId,
      content:     safeMessage || `Hi! I spotted you nearby and would love to connect.`,
      type:        'connect_request',
    });

    await User.findByIdAndUpdate(userId, {
      $addToSet: { pendingRequestsSent: toUserId },
    });

    socket.emit('connect:request_sent', {
      toUserId,
      roomId,
      messageId: requestMsg._id,
      sentAt:    requestMsg.createdAt,
    });

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

  } catch (err) {
    console.error(`[connect:request] Error for user ${userId}:`, err.message);
    socket.emit('error', { event: 'connect:request', message: 'Failed to send connection request' });
  }
});

    socket.on('connect:accept', async (payload = {}) => {
      try {
        const { fromUserId, messageId } = payload;

        const fromIdCheck = validateObjectId(fromUserId, 'fromUserId');
        if (!fromIdCheck.valid) {
          return socket.emit('error', { event: 'connect:accept', message: fromIdCheck.error });
        }

        const msgIdCheck = validateObjectId(messageId, 'messageId');
        if (!msgIdCheck.valid) {
          return socket.emit('error', { event: 'connect:accept', message: msgIdCheck.error });
        }

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

        await Message.create({
          roomId,
          senderId: userId,
          recipientId: fromUserId,
          content: `${socket.userDoc?.name || 'Someone'} accepted your connection request.`,
          type: MESSAGE_TYPES.CONNECT_ACCEPT,
          delivered: true,
          readAt: new Date(),
        });

        socket.join(roomId);

        const acceptingUser = await User.findById(userId).lean();
        socket.emit('connect:accepted', {
          withUserId: fromUserId,
          roomId,
          message: 'Connection accepted! You can now chat.',
        });

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

      } catch (err) {
        console.error(`[connect:accept] Error for user ${userId}:`, err.message);
        socket.emit('error', { event: 'connect:accept', message: 'Failed to accept connection request' });
      }
    });

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

      } catch (err) {
        console.error(`[connect:decline] Error for user ${userId}:`, err.message);
        socket.emit('error', { event: 'connect:decline', message: 'Failed to decline connection request' });
      }
    });

    socket.on('chat:join', async (payload = {}) => {
      try {
        const { roomId } = payload;

        if (!roomId || typeof roomId !== 'string') {
          return socket.emit('error', { event: 'chat:join', message: 'roomId is required' });
        }

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

      } catch (err) {
        console.error(`[chat:join] Error for user ${userId}:`, err.message);
        socket.emit('error', { event: 'chat:join', message: 'Failed to join chat room' });
      }
    });

socket.on('chat:message', async (payload = {}) => {
  try {
    const { roomId, content, clientId } = payload;

    if (!roomId || typeof roomId !== 'string') {
      return socket.emit('error', { event: 'chat:message', message: 'roomId is required' });
    }
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return socket.emit('error', { event: 'chat:message', message: 'Message content cannot be empty' });
    }

    const safeContent = content.trim().slice(0, 1000);

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

    if (!socket.rooms.has(roomId)) {
      socket.join(roomId);
    }

    const allowed = await checkRateLimit(userId, 'chat_message', 60_000, 30);
    if (!allowed) {
      return socket.emit('error', {
        event:   'chat:message',
        message: 'Sending too quickly. Please slow down.',
      });
    }

    const recipientId = participantIds.find((id) => id !== userId);
    if (!recipientId) {
      return socket.emit('error', {
        event:   'chat:message',
        message: 'Could not determine message recipient',
      });
    }

    const savedMessage = await Message.create({
      roomId,
      senderId:    userId,
      recipientId,
      content:     safeContent,
      type:        'text',
      delivered:   true,
    });

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

    // io.to(roomId) includes the sender — the sender's listener uses
    // clientId to find and replace the optimistic bubble in local state.
    io.to(roomId).emit('chat:message', messagePayload);

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

  } catch (err) {
    console.error(`[chat:message] Error for user ${userId}:`, err.message);
    socket.emit('error', {
      event:   'chat:message',
      message: 'Failed to send message',
    });
  }
});

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

    socket.on('disconnect', async (reason) => {

      try {
        const storedSocketId = await getSocketId(userId);
        if (storedSocketId === socket.id) {
          await pubClient.del(RedisKeys.socketId(userId));

        }

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
