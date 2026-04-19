import mongoose from 'mongoose';

// Mongoose fires these events throughout its lifecycle.
// Wiring them up here gives you visibility in logs without scattering
// console.log() calls across the codebase.
function attachMongooseListeners() {
  mongoose.connection.on('connected', () => {
    console.log(`[mongodb] Connected to ${mongoose.connection.name}`);
  });

  mongoose.connection.on('disconnected', () => {
    console.warn('[mongodb] Disconnected from database');
  });

  mongoose.connection.on('reconnected', () => {
    console.log('[mongodb] Reconnected to database');
  });

  mongoose.connection.on('error', (err) => {
    // Log but don't crash — Mongoose has built-in reconnect logic
    console.error('[mongodb] Connection error:', err.message);
  });
}

async function connectDB() {
  const uri = process.env.MONGO_URI;

  if (!uri) {
    throw new Error('MONGO_URI is not defined in environment variables');
  }

  attachMongooseListeners();

  await mongoose.connect(uri, {
    // ── Connection pool ───────────────────────────────────────────────────────
    // With 500 concurrent users each making occasional DB calls, keep the pool
    // sized to handle burst writes without exhausting Atlas free-tier limits.
    maxPoolSize: 20,   // max simultaneous connections in the pool
    minPoolSize: 5,    // keep this many connections warm at idle
    socketTimeoutMS: 45_000,    // how long a socket can be idle before closing
    serverSelectionTimeoutMS: 10_000, // how long to wait for a server before erroring
    heartbeatFrequencyMS: 10_000,     // how often to check server health

    // ── Mongoose-specific ─────────────────────────────────────────────────────
    // bufferCommands: false means queries fail fast instead of queueing up
    // when the DB is temporarily unreachable. Better for observability.
    bufferCommands: false,

    // Suppress Mongoose deprecation warnings for compatibility
    autoIndex: process.env.NODE_ENV !== 'production',
    // In production, build indexes manually via Atlas UI or a migration script.
    // autoIndex in production on large collections causes performance spikes on startup.
  });
}

export default connectDB;