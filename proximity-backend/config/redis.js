import Redis from 'ioredis';

// ─── Shared ioredis options ───────────────────────────────────────────────────
// Both pubClient and subClient use the same base config.
// We create two separate clients because a Redis client in subscriber mode
// cannot issue regular commands (GET, SET, DEL) — they are dedicated channels.
const redisOptions = {
  // Retry connection with exponential backoff, capped at 30 seconds.
  // Without this, a brief Redis blip would kill the whole server.
  retryStrategy(times) {
    const delay = Math.min(times * 200, 30_000);
    console.warn(`[redis] Retry attempt #${times} — waiting ${delay}ms`);
    return delay;
  },

  // Reconnect on specific errors (e.g. READONLY on Redis Cluster failover)
  reconnectOnError(err) {
    const targetErrors = ['READONLY', 'ECONNRESET', 'ETIMEDOUT'];
    if (targetErrors.some((e) => err.message.includes(e))) {
      console.warn(`[redis] Reconnecting due to error: ${err.message}`);
      return true;
    }
    return false;
  },

  // How long to wait for a command response before timing out
  commandTimeout: 5000,

  // Don't silently enqueue commands when disconnected — fail fast
  enableOfflineQueue: false,

  // Keep the connection alive at the TCP level
  keepAlive: 10_000,

  lazyConnect: true, // don't auto-connect on instantiation; we call .connect() manually
};

// ─── Client factory ───────────────────────────────────────────────────────────
function createRedisClient(clientName) {
  const url = process.env.REDIS_URL;

  if (!url) {
    throw new Error('REDIS_URL is not defined in environment variables');
  }

  const client = new Redis(url, redisOptions);

  client.on('connect', () => {
    console.log(`[redis:${clientName}] Connected`);
  });

  client.on('ready', () => {
    console.log(`[redis:${clientName}] Ready to accept commands`);
  });

  client.on('error', (err) => {
    // Log but don't crash — ioredis will retry automatically
    console.error(`[redis:${clientName}] Error:`, err.message);
  });

  client.on('close', () => {
    console.warn(`[redis:${clientName}] Connection closed`);
  });

  client.on('reconnecting', () => {
    console.warn(`[redis:${clientName}] Reconnecting...`);
  });

  client.on('end', () => {
    console.warn(`[redis:${clientName}] Connection ended — no more retries`);
  });

  return client;
}

// ─── Export two dedicated clients ────────────────────────────────────────────
// pubClient  — used for: SET, GET, DEL, SETEX (presence keys, socket ID map)
// subClient  — used by the Socket.io Redis adapter exclusively for SUBSCRIBE
export const pubClient = createRedisClient('pub');
export const subClient = createRedisClient('sub');

// ─── Connection helper ────────────────────────────────────────────────────────
// Called once from server.js during the startup sequence.
// Resolves when both clients are ready, rejects if either fails.
export async function connectRedis() {
  await Promise.all([pubClient.connect(), subClient.connect()]);
  console.log('[redis] Both pub/sub clients connected');
}

// ─── Helper utilities ─────────────────────────────────────────────────────────
// Centralise key naming so a typo in one place doesn't silently create a
// different key family. Import these helpers anywhere you need Redis.

export const RedisKeys = {
  // Presence key — expires automatically (heartbeat pattern)
  // Value: '1'  |  TTL: 30s  |  Refresh on every location:update event
  presence: (userId) => `presence:${userId}`,

  // Socket ID map — lets any server process target a specific user's socket
  // Value: socketId  |  TTL: none (deleted on disconnect)
  socketId: (userId) => `socket:${userId}`,

  // Rate limit key for location updates per user (checked in socket handler)
  // Value: count  |  TTL: 10s sliding window
  locationRateLimit: (userId) => `ratelimit:location:${userId}`,
};

// ─── Atomic set-with-expiry wrapper ───────────────────────────────────────────
// A thin convenience wrapper around SETEX so callers don't spread magic
// numbers for TTLs across the codebase.
export async function setPresence(userId, ttlSeconds = 30) {
  return pubClient.setex(RedisKeys.presence(userId), ttlSeconds, '1');
}

export async function getPresence(userId) {
  return pubClient.get(RedisKeys.presence(userId));
}

export async function setSocketId(userId, socketId) {
  return pubClient.set(RedisKeys.socketId(userId), socketId);
}

export async function getSocketId(userId) {
  return pubClient.get(RedisKeys.socketId(userId));
}

export async function removeUserKeys(userId) {
  return pubClient.del(RedisKeys.presence(userId), RedisKeys.socketId(userId));
}