# 1M Checkboxes (Real-Time, Authenticated)

A real-time checkbox collaboration app where authenticated users can update a shared grid of 100,000 checkboxes. Updates are synchronized instantly across connected clients using Socket.IO, and state/session data is stored in Redis.

## Project Overview

This project demonstrates:

- Real-time state synchronization with WebSockets
- OIDC-based authentication (Authorization Code Flow + PKCE)
- Session-based authorization using secure HTTP-only cookies
- Redis-backed shared state and session management
- Basic per-user rate limiting to prevent update spam

Main user journey:

1. User opens login page.
2. User authenticates with OIDC provider.
3. Server creates Redis-backed session and sets cookie.
4. Authenticated user enters dashboard and interacts with shared checkbox state.
5. Checkbox changes are published and broadcast in real time.

## Tech Stack

- Node.js (ESM)
- Express 5
- Socket.IO
- Redis (via ioredis)
- OIDC integration using server-side token exchange
- Frontend: vanilla HTML/CSS/JS (served as static files)
- Dev tooling: nodemon
- Container support: Docker Compose (Valkey/Redis-compatible image)

## Features Implemented

- OIDC login entry points (`/auth/login`, `/auth/login-url`)
- OIDC callback handling (`/auth/callback`)
- Redis-backed session lifecycle (create, validate, destroy)
- Auth status/user endpoints (`/auth/status`, `/auth/user`)
- Protected checkbox fetch route (`/checkboxes`)
- Socket.IO connection authentication via session cookie
- Shared checkbox state persistence in Redis (`checkbox-state:v1`)
- Pub/Sub fan-out for checkbox updates across clients
- Per-authenticated-user update throttling (~1 write per 5.5 seconds)
- Logout with session invalidation and socket disconnect

## How To Run Locally

### 1. Install dependencies

Using pnpm:

```bash
pnpm install
```

Or using npm:

```bash
npm install
```

### 2. Start Redis (Valkey) via Docker Compose

```bash
docker compose up -d
```

This starts a Redis-compatible service on `localhost:6379`.

### 3. Configure environment variables

Create or update `.env` in the project root (see section below).

### 4. Start the app

Development mode:

```bash
pnpm dev
```

Production mode:

```bash
pnpm start
```

### 5. Open in browser

- Login page: `http://localhost:3000/login.html`
- Dashboard: `http://localhost:3000/dashboard.html`
- Health endpoint: `http://localhost:3000/health`

## Environment Variables Required

Create `.env` with the following keys:

```env
PORT=3000

OIDC_ISSUER=http://localhost:8000
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
REDIRECT_URI=http://localhost:3000/auth/callback

# Optional (used by Socket.IO CORS)
CLIENT_URL=http://localhost:3000
```

Notes:

- `REDIRECT_URI` must match your OIDC provider client configuration.
- In production, use a secure issuer URL and strong secrets.

## Redis Setup Instructions

### Option A: Docker Compose (recommended)

The repository includes:

```yaml
services:
  valkey:
    image: valkey/valkey
    ports:
      - 6379:6379
```

Run:

```bash
docker compose up -d
```

### Option B: Local Redis install

If you run Redis locally by other means, ensure:

- Host: `localhost`
- Port: `6379`

Current connection config in app uses fixed host/port (`localhost:6379`).

## Auth Flow Explanation

1. User clicks login on `login.html`.
2. App hits `GET /auth/login`.
3. Server generates `state`, `nonce`, and PKCE `codeVerifier/codeChallenge`.
4. Temporary auth state is stored in Redis (`auth-state:<state>`, 10 min TTL).
5. User is redirected to OIDC provider authorize endpoint.
6. Provider redirects back to `GET /auth/callback` with `code` and `state`.
7. Server validates state from Redis, exchanges code for tokens, fetches user info.
8. Server creates session in Redis (`session:<sessionId>`, 24h TTL).
9. Server sets `sessionId` HTTP-only cookie and redirects to dashboard.
10. Protected routes validate session and load user from Redis.

## WebSocket Flow Explanation

1. Dashboard initializes Socket.IO client with credentials.
2. Server-side `io.use` middleware reads `sessionId` cookie from handshake headers.
3. Session is validated in Redis before socket connection is accepted.
4. On checkbox click, client emits `client:checkbox:change` with `{ i, checked }`.
5. Server updates Redis checkbox state and publishes to Redis Pub/Sub channel `internel-server:checkbox:change`.
6. Subscriber receives event and broadcasts `server:checkbox:change` to all clients.
7. Each client updates local UI for the changed checkbox and shows optional user notification.

## Rate Limiting Logic Explanation

Rate limiting is applied inside the socket handler for checkbox updates:

- Key: `rate-limit:<userId>` (stored in Redis)
- Value: last operation timestamp (`Date.now()`)
- Check: if elapsed time is less than `5.5` seconds, reject update
- Behavior on reject: emit `server:error` to that client
- Behavior on accept: store new timestamp and process checkbox update

This effectively allows about 1 checkbox mutation per authenticated user every 5.5 seconds.

## Screenshots / Demo Link

- Demo video:
  - [Click here to see demo](https://youtu.be/tUEYZQVSt6w)
- Login screenshot:
  - [Login with OIDC](<https://github.com/omkarg419/1m-checkbox/blob/main/Demo-image/Screenshot%20(292).png>)
  - [OIDC Login](<https://github.com/omkarg419/1m-checkbox/blob/main/Demo-image/Screenshot%20(293).png>)
- Dashboard screenshot:
  - [Dashboard single user](<https://github.com/omkarg419/1m-checkbox/blob/main/Demo-image/Screenshot%20(294).png>)
  - [Dashboard two user](<https://github.com/omkarg419/1m-checkbox/blob/main/Demo-image/Screenshot%20(295).png>)

## API/Socket Quick Reference

### HTTP

- `GET /auth/login`
- `GET /auth/login-url`
- `GET /auth/callback`
- `GET /auth/logout`
- `GET /auth/status`
- `GET /auth/user`
- `GET /checkboxes`
- `GET /health`

### Socket Events

Client to server:

- `client:checkbox:change` -> `{ i, checked }`

Server to client:

- `server:checkbox:change` -> broadcast change payload
- `server:checkbox:updated` -> ack for sender
- `server:error` -> operation/connect-level errors

## Notes

- The app currently stores checkbox state as one large JSON array in Redis.
- Session validity checks include token expiry timestamp stored in session payload.
- Make sure your OIDC provider is running and reachable at `OIDC_ISSUER`.
