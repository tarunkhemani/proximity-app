import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { createAdapter } from '@socket.io/redis-adapter';

import connectDB from './config/db.js';
import { pubClient, subClient, connectRedis } from './config/redis.js';
import { registerSocketHandlers } from './sockets/index.js';
import authRoutes from './routes/auth.js';
import cookieParser from 'cookie-parser';
import messageRoutes from './routes/messages.js';
import userRoutes from './routes/users.js';
import compression from 'compression';


// ─── Validate required env vars at startup ───────────────────────────────────
const REQUIRED_ENV = ['PORT', 'MONGO_URI', 'REDIS_URL', 'JWT_SECRET', 'CLIENT_URL'];
const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`[server] Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const PORT = process.env.PORT || 5000;

// ─── Express app ─────────────────────────────────────────────────────────────
const app = express();

// Security headers — disable the default 'X-Powered-By: Express' header
app.use(helmet());
app.disable('x-powered-by');

// ── After app.disable('x-powered-by') ─────────────────────────────────────
// Trust the first proxy (nginx) so req.ip and secure cookies work correctly
// when the app runs behind a reverse proxy. Without this, Express sees the
// proxy IP instead of the real client IP, which breaks rate limiting.
app.set('trust proxy', 1);

// ── After app.set('trust proxy', 1) ───────────────────────────────────────
// Compress all responses > 1kb. Reduces bandwidth by ~70% for JSON payloads.
// Must be registered before routes so all responses are compressed.
app.use(compression({
  // Skip compression for server-sent events and already-compressed formats
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  },
  threshold: 1024, // only compress responses larger than 1kb
}));

// CORS — allow only the React dev server (and production URL)
const allowedOrigins = [
  process.env.CLIENT_URL,
  'http://localhost:5173', // Vite default
  'http://localhost:3000', // CRA default
].filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, curl, Postman)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true, // required if React sends cookies or auth headers
  })
);

app.use(express.json({ limit: '50kb' })); // reject oversized payloads
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use('/api/messages', messageRoutes);
app.use('/api/users', userRoutes);

// ─── HTTP rate limiting (REST endpoints) ─────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,                   // max requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});
app.use('/api', apiLimiter);

// ─── REST API Routes (stubs — filled in Phase 3) ─────────────────────────────
// app.use('/api/auth', authRoutes);
// app.use('/api/users', userRoutes);
// app.use('/api/messages', messageRoutes);
app.use('/api/auth', authRoutes);

// ─── Health check (useful for Docker / load balancer probes) ─────────────────
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ─── Global error handler ─────────────────────────────────────────────────────
// Must be defined last, after all routes
app.use((err, req, res, next) => {
  // CORS errors from the cors() middleware
  if (err.message?.startsWith('CORS blocked')) {
    return res.status(403).json({ error: err.message });
  }
  console.error('[error]', err.stack || err.message);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
});

// ─── HTTP server (shared between Express & Socket.io) ────────────────────────
const httpServer = createServer(app);

// ─── Socket.io ───────────────────────────────────────────────────────────────
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true,
  },
  // Tune transports: prefer WebSocket, fall back to polling
  transports: ['websocket', 'polling'],
  // Ping tuning — detect dead connections faster than the 25s default
  pingTimeout: 20000,   // how long to wait for a pong before closing
  pingInterval: 10000,  // how often to send a ping
  // Limit payload sizes on socket events
  maxHttpBufferSize: 1e5, // 100KB
  // Connection state recovery: lets clients auto-resume after brief disconnects
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
    skipMiddlewares: false,
  },
});

// ─── Startup sequence ─────────────────────────────────────────────────────────
// Order matters: DB and Redis must be ready before we start accepting connections
async function start() {
  try {
    // 1. Connect to MongoDB
    await connectDB();

    // 2. Connect Redis pub/sub clients (both needed for the adapter)
    await connectRedis();

    // 3. Attach Redis adapter to Socket.io
    //    This makes events emitted on one Node process visible to all other
    //    processes — critical for horizontal scaling behind a load balancer
    io.adapter(createAdapter(pubClient, subClient));
    console.log('[socket.io] Redis adapter attached');

    // 4. Register all socket event handlers
    //    We pass `io` so handlers can emit to arbitrary rooms across processes
    registerSocketHandlers(io);

    // 5. Start the HTTP + WebSocket server
    httpServer.listen(PORT, () => {
      console.log(`[server] Running on port ${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
    });
  } catch (err) {
    console.error('[server] Failed to start:', err.message);
    process.exit(1);
  }
}

start();

// ─── Graceful shutdown ────────────────────────────────────────────────────────
// Ensures in-flight requests complete and connections close cleanly before exit.
// Required for zero-downtime deploys (PM2, Docker, Kubernetes).
async function gracefulShutdown(signal) {
  console.log(`[server] ${signal} received — shutting down gracefully`);

  // Stop accepting new connections
  httpServer.close(async () => {
    console.log('[server] HTTP server closed');

    try {
      // Close Socket.io connections
      await io.close();
      console.log('[socket.io] All connections closed');

      // Close Redis clients
      await pubClient.quit();
      await subClient.quit();
      console.log('[redis] Clients disconnected');

      // Close Mongoose connection
      const mongoose = await import('mongoose');
      await mongoose.default.connection.close();
      console.log('[mongodb] Connection closed');

      process.exit(0);
    } catch (err) {
      console.error('[server] Error during shutdown:', err.message);
      process.exit(1);
    }
  });

  // Force-kill if graceful shutdown hangs after 10 seconds
  setTimeout(() => {
    console.error('[server] Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 10_000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM')); // Docker / Kubernetes stop
process.on('SIGINT', () => gracefulShutdown('SIGINT'));   // Ctrl+C in terminal

// Catch unhandled promise rejections (e.g. a forgotten await)
process.on('unhandledRejection', (reason, promise) => {
  console.error('[server] Unhandled rejection at:', promise, 'reason:', reason);
});