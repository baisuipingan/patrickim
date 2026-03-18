# patrick-im

[English](./README.en.md) | [简体中文](./README.zh-CN.md)

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
├── deploy-local.sh         # Local one-click release script
├── deploy.sh               # Remote server deploy script
├── docker-compose.yml      # Server-side container orchestration
├── .env.example            # Runtime config template
└── .env.local.example      # Local private deploy config template
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

## Production deployment

This repository uses a local-build, remote-pull workflow:

- Build frontend assets locally
- Cross-compile the Linux binary locally with `cargo zigbuild`
- Build and push the Docker image locally
- Let the server run `docker compose pull` and `docker compose up -d`

Prepare both config files:

```bash
cp .env.example .env
cp .env.local.example .env.local
```

### `.env`

This file contains runtime config and is uploaded to the server during deployment.

Typical example:

```env
APP_IMAGE=your-registry.example.com/your-namespace/patrick-im:latest
APP_PULL_POLICY=always

ALLOWED_ORIGINS=https://your-domain.com
SESSION_SECRET=replace-with-a-fixed-random-string
SESSION_TTL_SECONDS=2592000

ICE_PROVIDER=cloudflare
STUN_URLS=stun:stun.cloudflare.com:3478
CLOUDFLARE_TURN_KEY_ID=your-turn-key-id
CLOUDFLARE_TURN_API_TOKEN=your-turn-api-token
CLOUDFLARE_TURN_TTL_SECONDS=86400
FILTER_BROWSER_UNSAFE_TURN_URLS=true
```

`ALLOWED_ORIGINS` supports multiple values separated by commas.

### `.env.local`

This file is only used by your local release script. It stays on your machine and is ignored by Git.

Typical example:

```env
DEPLOY_SERVER_HOST=your-server-ip-or-domain
DEPLOY_SERVER_PORT=22
DEPLOY_SERVER_USER=root
DEPLOY_SERVER_PASSWORD=your-ssh-password
DEPLOY_PROJECT_DIR=/home/patrick-im

ACR_REGISTRY=your-registry.example.com
IMAGE_REPO=your-registry.example.com/your-namespace/patrick-im
ACR_USERNAME=your-registry-username
ACR_PASSWORD=your-registry-password

PLATFORMS=linux/amd64
RUST_TARGET=x86_64-unknown-linux-musl
PUSH_LATEST=true
```

### One-command release

Make sure the local machine has:

- Docker
- Rust toolchain
- Zig
- `cargo-zigbuild`
- Node.js / npm
- `sshpass`

First-time setup:

```bash
rustup target add x86_64-unknown-linux-musl
cargo install cargo-zigbuild
```

Then every release is:

```bash
bash ./deploy-local.sh
```

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
