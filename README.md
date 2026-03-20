# patrick-im

[English](./README.md) | [简体中文](./README.zh-CN.md)

`patrick-im` is a WebRTC-first peer-to-peer communication app with anonymous room entry, text chat, file transfer, audio/video calling, and screen sharing. The current `main` branch is built with `Rust + Axum + React`. The server is intentionally lightweight and is only responsible for anonymous session issuance, signaling, ICE/TURN configuration, and diagnostics ingestion.

## Status

- Current mainline: Rust signaling server on `main`
- Legacy Go version: `main-go` branch
- Last Go snapshot: `go-legacy-final` tag

If you are coming from the older Go implementation, use `main-go` for historical reference and `main` for the actively maintained version.

## Features

- Anonymous room join with no account registration
- P2P text chat over WebRTC DataChannel
- File transfer with receiver-side acceptance, pause, resume, and cancel
- Audio/video calling with camera and microphone toggles
- Screen sharing during active calls
- LAN-first connectivity with STUN / TURN fallback for public networks
- Frontend and backend diagnostics for troubleshooting unstable sessions
- Local-first chat history stored in the browser

## Architecture

### What the server does

- Signs and renews anonymous session cookies
- Maintains room membership and WebSocket signaling
- Serves `/api/ice` for WebRTC bootstrap
- Accepts `/api/diagnostics` reports

### What the server does not do

- It does not store chat message bodies
- It does not relay normal text messages
- It does not carry normal media streams
- It does not proxy normal file payloads

Under healthy network conditions, chat, files, and media stay on direct P2P channels. The server remains on the signaling and bootstrap path only.

## Tech stack

### Backend

- Rust
- Axum
- Tokio
- WebSocket signaling
- HMAC-signed anonymous session cookie

### Frontend

- React 18
- Vite
- Tailwind CSS
- WebRTC

## Repository layout

```text
.
├── src/                    # Rust backend
├── frontend/               # React frontend
├── Dockerfile              # Runtime image build file
├── docker-compose.yaml     # Docker Compose entrypoint
├── .env.example            # Runtime config template
└── deploy/runtime-rootfs/  # Rootfs used by the scratch runtime image
```

## Local development

Create a runtime config first:

```bash
cp .env.example .env
```

Recommended minimum:

```env
ALLOWED_ORIGINS=http://localhost:3456,http://127.0.0.1:3456
SESSION_SECRET=replace-with-a-fixed-random-string
ICE_PROVIDER=stun-only
```

Build the frontend and run the Rust server:

```bash
cd frontend
npm install
npm run build
cd ..

cargo run
```

Then open:

- `http://127.0.0.1:3456`
- `http://localhost:3456`

## Docker Compose Quick Start

For public users, `docker-compose.yaml` is the main entrypoint.
Think of this repository as: pull the public image, then inject runtime config through `.env`.

Create a runtime config first:

```bash
cp .env.example .env
```

The default `.env.example` is already usable for local evaluation and includes values like:

```env
APP_IMAGE=crpi-6yrxqnyn3y05zbgq.cn-qingdao.personal.cr.aliyuncs.com/patrickcmh/patrick-im:latest
APP_PORT_BIND=127.0.0.1:3456:3456
ALLOWED_ORIGINS=http://localhost:3456,http://127.0.0.1:3456
SESSION_SECRET=change-this-before-production
ICE_PROVIDER=stun-only
```

Then just start it:

```bash
docker compose pull
docker compose up -d
```

Open:

- `http://127.0.0.1:3456`
- `http://localhost:3456`

### Common adjustments

- Run `docker login` first if your registry requires authentication
- Change `APP_PORT_BIND` to `3456:3456` if you want LAN devices to access it
- Change `ALLOWED_ORIGINS` to your `https://your-domain.com` before real deployment
- Change `ICE_PROVIDER` to `cloudflare` or `static` if you want better public-network connectivity
- Change `APP_IMAGE` if you build and publish your own image

### Data and logs

`docker-compose.yaml` mounts a named volume called `patrick-im-diagnostics` so diagnostics survive container recreation.

Useful checks:

```bash
docker compose ps
docker compose logs -f app
curl http://127.0.0.1:3456/healthz
```

Maintainer-specific release scripts and private ops workflows are intentionally kept out of the public repository. The public repo only documents the Compose-based runtime path for users.

## ICE / TURN modes

The project supports three ICE modes:

- `stun-only`
- `static`
- `cloudflare`

### `stun-only`

Use this when you only want direct connectivity and NAT traversal, with no TURN relay fallback.

### `static`

Use this for a self-hosted TURN server such as `coturn`:

```env
ICE_PROVIDER=static
STUN_URLS=stun:stun.cloudflare.com:3478
TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp
TURN_USERNAME=your-username
TURN_CREDENTIAL=your-password
```

### `cloudflare`

Use this for Cloudflare Realtime TURN.

Important:

- The project does not use a Cloudflare management API token here
- It expects the values shown on the TURN key page:
  - `Turn Token ID`
  - `API Token`

On every `/api/ice` request, the backend asks Cloudflare for a fresh short-lived TURN credential set and returns the resulting `iceServers` to the frontend session.

## Diagnostics and endpoints

Available endpoints:

- `GET /healthz`
- `GET /api/session`
- `GET /api/ice`
- `GET /api/rooms`
- `POST /api/diagnostics`
- `GET /ws`

When frontend diagnostics are enabled, the server writes reports into the `diagnostics/` directory.

## Notes

- The Go backend has been removed from the active mainline
- Static frontend assets are embedded into the backend release artifact
- The runtime image is intentionally minimal and expects build artifacts to be prepared locally

## License

MIT
