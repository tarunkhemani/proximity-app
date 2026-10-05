# Proximity

Real-time proximity networking for campuses and events. Turn on a **beacon**, see who is
physically nearby (within 200 m), send a connection request, and chat once it is accepted.
Built as a full-stack, installable PWA.

| | |
|---|---|
| **Live app** | https://proximity-client.vercel.app |
| **Live API** | https://proximity-backend-2t5y.onrender.com (health check: `/health`) |
| **Stack** | React 19 · Vite · Tailwind CSS 4 · Node.js · Express · Socket.IO · MongoDB · Redis |

> The API is hosted on a free Render instance, so the first request after a period of
> inactivity can take 30–60 seconds while the server wakes up.

---

## Features

- **Account system** – register / login with JWT access tokens and a rotating refresh token
  stored in an httpOnly cookie; profile editing (name, bio, up to 10 interest tags),
  password change and account deletion.
- **Beacon (opt-in visibility)** – a user is visible to others only while their beacon is
  active (5 minutes to 8 hours). The beacon expires automatically and can be stopped any time.
- **Live radar** – the browser's Geolocation API streams position updates over WebSockets;
  the server returns people within 200 m, sorted by distance, with live online presence.
  New people entering range are pushed in real time (`proximity:appeared`).
- **Privacy-aware location sharing** – other users see a rounded distance and a coarse campus
  *zone* label (e.g. "Library", "Cafeteria"), never raw coordinates.
- **Connection requests** – send, accept or decline requests with duplicate / self-request
  checks. Chat is only available between accepted connections.
- **Real-time chat** – rooms per connection, typing indicators, read receipts, unread counts,
  inbox with conversation list, per-user conversation deletion.
- **Installable PWA** – web app manifest, service worker (Workbox) with precaching and an
  offline banner; app shortcuts for *Radar* and *Inbox*.
- **Lazy-loaded routes** and protected / public route guards on the client.

## Tech stack

| Layer | Technologies |
|---|---|
| Frontend | React 19, React Router 7, Vite 8, Tailwind CSS 4, Framer Motion, Lucide icons, react-hot-toast, Axios, socket.io-client, vite-plugin-pwa (Workbox) |
| Backend | Node.js (ESM), Express 4, Socket.IO 4, Mongoose 8, ioredis, jsonwebtoken, bcryptjs, helmet, express-rate-limit, compression, morgan, validator |
| Data | MongoDB (users, locations, messages) · Redis (presence, socket-id lookup, rate limiting, Socket.IO adapter) |
| Hosting | Vercel (client) · Render (API) · managed cloud MongoDB and Redis instances |

## Architecture

```
┌────────────────────────┐   REST (Axios)    ┌──────────────────────────┐
│  React PWA (Vercel)    │ ────────────────▶ │  Express API (Render)    │
│  - AuthContext         │                   │  - /api/auth             │
│  - SocketContext       │   WebSocket       │  - /api/users            │
│  - useGeolocation hook │ ◀───────────────▶ │  - /api/messages         │
└────────────────────────┘   (Socket.IO)     │  - Socket.IO handlers    │
                                             └────────┬──────────┬──────┘
                                                      │          │
                                          ┌───────────▼───┐  ┌───▼────────────┐
                                          │ MongoDB       │  │ Redis          │
                                          │ users         │  │ presence       │
                                          │ locations     │  │ socket ids     │
                                          │ (2dsphere+TTL)│  │ rate limiting  │
                                          │ messages      │  │ Socket.IO      │
                                          └───────────────┘  │ adapter        │
                                                             └────────────────┘
```

### How a location update works

1. The client's `useGeolocation` hook reads the GPS position (high accuracy) and emits
   `location:update` every 15 seconds while the beacon is on.
2. The server validates the coordinates, applies a per-user cooldown (8 s) using a Redis
   counter, and upserts the user's single location document.
3. A Redis presence key (30 s TTL) marks the user as online.
4. A MongoDB aggregation runs `$geoNear` on the `2dsphere` index (200 m radius), joins the
   `users` collection, keeps only users who are active, visible and whose beacon has not
   expired, and returns them sorted by distance.
5. The result is emitted back as `proximity:nearby`; if the sender is beaconing, nearby
   users are notified with `proximity:appeared` through their stored socket ids.

## Key design decisions

| Decision | What the code does | Why |
|---|---|---|
| MongoDB `2dsphere` + `$geoNear` | Locations are GeoJSON points queried with a spherical distance filter | Native, indexed radius search with distance calculation in the database instead of in application code |
| Self-expiring location data | TTL index (120 s) on `updatedAt`, plus a 90 s staleness filter in the query | Stale positions disappear automatically; no cleanup job and less sensitive data retained |
| Fuzzy campus zones | Position is snapped to the nearest predefined zone label; only distance + zone are shared | Lets people find each other without exposing exact coordinates |
| Beacon model | Visibility is explicit, time-boxed and double-checked server-side (`isVisible` and `beaconExpiresAt > now`) | Opt-in privacy; even if a timer is lost the query still excludes expired beacons |
| Redis for ephemeral state | Presence, user→socket lookup and rate-limit counters live in Redis | Fast, expiring keys fit short-lived data better than the primary database |
| Socket.IO Redis adapter | `io.to(socketId)` works across processes | Allows running more than one server instance behind a load balancer |
| Atomic rate limiting | A Lua script increments and sets expiry in a single Redis call | Avoids the race where two simultaneous events both read a count of 0 |
| Access + refresh tokens | Short-lived bearer token for API/socket auth; refresh token in an httpOnly cookie, stored hashed (bcrypt) in the database | JavaScript cannot read the refresh token (XSS-resistant) and a leaked database does not expose usable tokens |
| Axios refresh interceptor | On a 401, one refresh request is made and concurrent requests are queued and retried | Prevents multiple simultaneous refresh calls |
| Layered validation & limits | Mongoose validators, server-side input checks, 50 kb JSON body limit, per-route and global rate limits, helmet | Defence in depth against malformed or abusive input |
| Connection-gated chat | Joining a room requires an accepted connection; sending a message requires being a participant of the room | Strangers cannot open a conversation |
| Code-splitting & PWA caching | Pages are lazy-loaded; static assets are precached; API and Socket.IO traffic is never cached | Fast repeat loads without serving stale real-time data |

## Project structure

```
proximity-app/
├── proximity-backend/
│   ├── server.js            # Express + Socket.IO bootstrap, middleware, health check
│   ├── config/              # MongoDB and Redis connections, Redis key helpers
│   ├── middleware/auth.js   # JWT verification for REST routes
│   ├── models/              # User, Location (2dsphere + TTL), Message
│   ├── routes/              # auth, users, messages (REST)
│   ├── services/proximity.js# $geoNear aggregation, presence filtering
│   └── sockets/index.js     # Real-time events: beacon, location, connections, chat
└── proximity-client/
    ├── src/
    │   ├── pages/           # Login, Register, Radar, Chat, Profile, NotFound
    │   ├── components/      # InboxDrawer, OfflineBanner
    │   ├── context/         # AuthContext, SocketContext
    │   ├── hooks/           # useGeolocation
    │   └── lib/api.js       # Axios instance with refresh interceptor
    ├── public/              # PWA manifest and icons
    └── vite.config.js       # React, Tailwind and PWA (Workbox) configuration
```

## Getting started

### Prerequisites

- Node.js 18 or newer
- A MongoDB database (local or MongoDB Atlas)
- A Redis instance (local, Redis Cloud or Upstash)

### 1. Backend

```bash
cd proximity-backend
npm install
cp .env.production.example .env     # then fill in the real values
npm run dev                         # nodemon, http://localhost:5000
```

| Variable | Description |
|---|---|
| `PORT` | Server port (default `5000`) |
| `NODE_ENV` | `development` or `production` |
| `MONGO_URI` | MongoDB connection string |
| `REDIS_URL` | Redis connection string |
| `JWT_SECRET` | Secret for access tokens |
| `JWT_REFRESH_SECRET` | Secret for refresh tokens |
| `JWT_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` | Token lifetimes (defaults `7d` / `30d`) |
| `CLIENT_URL` | Allowed frontend origin for CORS, no trailing slash (e.g. `http://localhost:5173`) |

Generate a secret with:
`node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`

### 2. Frontend

```bash
cd proximity-client
npm install
cp .env.example .env                # API and socket URLs
npm run dev                         # http://localhost:5173
```

| Variable | Description |
|---|---|
| `VITE_API_URL` | Backend REST base URL, e.g. `http://localhost:5000/api` |
| `VITE_SOCKET_URL` | Backend Socket.IO URL, e.g. `http://localhost:5000` |

Other scripts: `npm run build` (production build), `npm run preview`, `npm run lint`.

> Geolocation requires a secure context: it works on `localhost` and on HTTPS deployments.

## API reference

### REST

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/auth/register` | Create an account (rate limited) |
| POST | `/api/auth/login` | Log in, receive access token + refresh cookie (rate limited) |
| POST | `/api/auth/refresh` | Issue a new access token from the refresh cookie |
| POST | `/api/auth/logout` | Invalidate the refresh token |
| GET | `/api/auth/me` | Current authenticated user |
| GET / PATCH | `/api/users/me` | Read / update own profile |
| POST | `/api/users/me/change-password` | Change password |
| GET | `/api/users/connections` | List accepted connections |
| GET | `/api/users/:id` | Public profile of another user |
| DELETE | `/api/users/me` | Delete own account |
| GET | `/api/messages/inbox` | Conversation list with unread counts |
| GET | `/api/messages/:roomId` | Message history for a room |
| DELETE | `/api/messages/:roomId` | Delete a conversation for the current user |
| GET | `/health` | Health check |

### Socket.IO events

| Client → Server | Server → Client |
|---|---|
| `beacon:start`, `beacon:stop` | `session:ready`, `beacon:started`, `beacon:stopped` |
| `location:update` | `location:acknowledged`, `proximity:nearby`, `proximity:appeared` |
| `connect:request`, `connect:accept`, `connect:decline` | `connect:request_sent`, `connect:accepted`, `connect:you_were_accepted`, `connect:declined` |
| `chat:join`, `chat:message`, `chat:typing`, `chat:read` | `chat:joined`, `chat:message`, `chat:typing`, `chat:notification` |
| – | `error` (with the originating event name) |

## Limits and security

- Passwords hashed with bcrypt (cost 12); refresh tokens stored hashed.
- Auth endpoints: 5 registrations per hour and 10 logins per 15 minutes; 200 API requests per
  15 minutes per IP overall.
- Socket limits: 1 location update per 8 s, 10 connection requests per minute, 30 chat
  messages per minute, per user.
- Field limits: bio 160 characters, message 1000 characters, at most 10 tags.
- `helmet` security headers, CORS restricted to the configured frontend origin, and
  `X-Frame-Options`, `nosniff` and `Permissions-Policy` headers on the Vercel deployment.
- Secrets are read from environment variables; `.env` files are git-ignored and only
  `.env.example` files are committed.

## Known limitations

- **Cross-site refresh cookie.** The refresh cookie uses `SameSite=Strict`. With the frontend
  (Vercel) and API (Render) on different sites, browsers may not store it, so silent token
  refresh may not work in production. This is currently masked by the long default access-token
  lifetime (7 days). A fix is to use `SameSite=None; Secure` or to serve both under one domain.
- **Fixed campus zones.** Zone labels and centroids are hard-coded for one campus.
- **Beacon timers are in-process.** Expiry timers live in server memory; visibility is still
  enforced by the database query if a timer is lost, but timers are not shared between instances.
- **Location polling.** Updates are sent every 15 s regardless of movement (the minimum-movement
  threshold is set to 0 for development).
- **No automated tests yet.** The `npm run lint` output also reports a few React Hooks
  compiler-rule warnings that have not been refactored.
- **Free-tier hosting.** Cold starts on the API can delay the first request.

## Roadmap

- Automated tests (API integration tests, socket event tests)
- Configurable zones / event-based geofences instead of fixed campus zones
- Push notifications for connection requests and messages
- Refresh-cookie fix and shorter access-token lifetime
- Docker Compose setup for one-command local development

## Author

**Tarun Khemani** – [GitHub](https://github.com/tarunkhemani)
