<p align="center">
  <img src="docs/icon.png" width="90" alt="Chess Democracy" />
</p>

# Chess Democracy

A peer-to-peer multiplayer chess client built with Electron + React + TypeScript. Players connect directly over LAN/Wi-Fi using mDNS discovery — no server required. Multiple players can join the same side and vote on moves collectively. The project strives for a global working Peer 2 Peer version.

## Architecture

```
Chess-Hive-Global-dev/
├── chess-democracy-core/          # ESM Node.js — game logic, networking, crypto identity
│   └── src/
│       ├── core/node.ts      # Main entry point (EventEmitter)
│       ├── game/             # Chess state machine, voting engine
│       └── network/          # mDNS discovery, message signing, peer protocol
│
└── chess-democracy-electron/      # Electron shell + React renderer
    ├── main.ts               # Electron main process — bridges core ↔ IPC
    ├── src/
    │   ├── ipc-channels.ts   # Single source of truth for all IPC channel names & types
    │   └── preload.ts        # contextBridge — exposes window.chessDemocracy to renderer
    └── ReactChessDemocracy/       # Vite + React SWC
        └── src/
            ├── store.ts      # Zustand store — all React state lives here
            ├── useChessHive.ts # IPC ↔ store bridge (subscriptions + hydration)
            └── screens/      # LobbyScreen, GameScreen, GameOverScreen, LoginScreen
```

### IPC pattern

```
Renderer  ─── ipcRenderer.invoke ──►  Main  ──►  Core (INVOKE channels, request/reply)
Renderer  ◄── win.webContents.send ──  Main  ◄──  Core (PUSH channels, one-way events)
```

All channel names live in `chess-democracy-electron/src/ipc-channels.ts`. The preload bridges them to `window.chessDemocracy`. Components never call the bridge directly — they read from the Zustand store and dispatch actions.

### Identity

Each player has an Ed25519 keypair stored as a PEM file (`~/.chess-democracy/identity.pem`, created on first launch). Every network message is signed with this key; receivers verify the signature before accepting the message.

### Voting protocol

When it is a side's turn, a configurable voting window opens (default 30 s, set in lobby via Config panel). Each player on that side casts a vote for a legal move. The plurality winner is committed. On a 3-way split with no majority the window restarts; after `maxRevotes` failed rounds the game ends with `revotes_exhausted`.

### Resign vote protocol

No single player can unilaterally resign. Clicking Resign casts a yes vote. Once ≥ `resignThreshold` (default 67 %) of the currently connected teammates have voted yes, the side forfeits. The vote window auto-expires after `resignWindowMs` (default 60 s) with no effect if the threshold is not reached. Teammate disconnects shrink the denominator — a vote that was at 1/3 becomes 1/2 if a non-voter leaves. Config keys `resignThreshold` and `resignWindowMs` flow through the existing config-proposal handshake.

### Draw protocol

Any player can offer a draw. Opponents see a banner and accept or decline. Accepting broadcasts `game_over` with reason `draw_agreement`.

### Move timeout

Each voting window has a hard cap (`MOVE_TIMEOUT_MS`, default 120 s). If no tally fires before the cap, the game ends with reason `timeout`.

---

## Prerequisites

- Node.js ≥ 22 (LTS recommended)
- npm ≥ 10

---

## Setup

```bash
# 1 — Clone
git clone https://github.com/AyoubThemry/Chess-Democracy.git
cd Chess-Democracy

# 2 — Install core dependencies
cd chess-democracy-core
npm install

# 3 — Build core (must be done before the Electron shell can import it)
npm run build

# 4 — Install Electron shell dependencies
cd ../chess-democracy-electron
npm install

# 5 — Install React renderer dependencies
cd ReactChessDemocracy
npm install
cd ..
```

---

## Development

Run both the Vite dev server and Electron in parallel:

```bash
# Terminal 1 — Vite dev server (hot-reload renderer)
cd chess-democracy-electron/ReactChessDemocracy
npm run dev

# Terminal 2 — Electron main process
cd chess-democracy-electron
npm run dev
```

The app opens at `http://localhost:5173` inside the Electron window. DevTools are automatically opened in dev mode.

> **After editing core files**, rebuild core before restarting Electron:
> ```bash
> cd chess-democracy-core && npm run build
> ```

---

## Tests

```bash
# Run the React store unit tests
cd chess-democracy-electron/ReactChessDemocracy
npm test

# With coverage report
npm run test:coverage
```

Tests use Vitest + jsdom. They cover all Zustand store actions (30 cases) without requiring Electron or a live network.

---

## Build (production)

### One command (recommended)

```bash
cd chess-democracy-electron
npm run build:release
```

`build:release` runs the full pipeline in order:

```
npm run build:core   →  tsc on chess-democracy-core  (outputs chess-democracy-core/dist/)
npm run build:react  →  Vite build of ReactChessDemocracy  (outputs ReactChessDemocracy/dist/)
npm run build        →  tsc on the Electron main process  (outputs chess-democracy-electron/dist-ts/)
npm run dist         →  electron-builder  (packages final .exe / .dmg / .AppImage)
```

> **Never run `npm run dist` directly** — it skips the TypeScript compilation steps and packages stale JS. The result is a broken exe (e.g. `drawOffered is not a function`).

The packaged app appears in `chess-democracy-electron/dist/`.

### Step-by-step (if you only changed one layer)

| What changed | Commands to run |
|---|---|
| Only `chess-democracy-core/src/**` | `cd chess-democracy-core && npm run build`, then re-run `dist` |
| Only `ReactChessDemocracy/src/**` | `cd chess-democracy-electron && npm run build:react`, then `npm run dist` |
| Only `chess-democracy-electron/main.ts` or `src/preload.ts` | `cd chess-democracy-electron && npm run build`, then `npm run dist` |
| Any of the above combined, or unsure | `cd chess-democracy-electron && npm run build:release` |

### Code signing

The `dist` script already disables auto-discovery (`CSC_IDENTITY_AUTO_DISCOVERY=false`) so unsigned local builds work out of the box. For a signed release:

| Platform | Requirement |
|---|---|
| **Windows** | EV code-signing certificate — set `CSC_LINK` (path to .pfx) and `CSC_KEY_PASSWORD` env vars before running `build:release` |
| **macOS** | Apple Developer ID certificate in Keychain; `electron-builder` signs automatically when certs are present |
| **Linux** | No signing required; AppImage bundles are self-contained |

---

## Network protocol

Messages are JSON, broadcast over TCP to all connected peers. Each message is wrapped with:

```json
{
  "type": "<message-type>",
  "senderPublicKey": "<base64 Ed25519 public key>",
  "signature": "<base64 signature of payload>",
  "<...payload fields>": "..."
}
```

### Message types

| Type | Direction | Purpose |
|---|---|---|
| `team` | broadcast | Player declares their side (white/black) |
| `ready` / `unready` | broadcast | Player toggles ready state |
| `config` | broadcast | Propose new voting window / revote settings |
| `config_accepted` | broadcast | Accept the current config version |
| `vote` | broadcast | Cast a move vote during voting window |
| `move` | broadcast | Committed move (after tally) |
| `game_over` | broadcast | Game ended — includes result & reason |
| `draw_offer` | broadcast | Offer a draw |
| `draw_response` | broadcast | Accept or decline a draw offer |
| `resign_vote` | team-only broadcast | Cast a yes vote in the active resign vote window |

All messages are verified by every receiver. Messages with an invalid signature are silently dropped.

---

## Docs

Architecture diagrams live in [`docs/`](docs/):

| File | Contents |
|---|---|
| `docs/game-flow.md` | Full game sequence — discovery → lobby → start → voting → game over |
| `docs/resign-vote.md` | Resign vote sequence — threshold, disconnect handling, expiry |

Diagrams use [Mermaid](https://mermaid.js.org/) and render natively on GitHub.

---

## Roadmap

### Phase 1 — LAN / Wi-Fi ✅ (current)
- [x] mDNS peer discovery (no server required)
- [x] Multi-player voting per side with configurable window
- [x] Resign vote protocol with threshold and disconnect handling
- [x] Draw offer / accept flow
- [x] Config handshake in lobby (vote window, revotes, resign settings)
- [x] Ed25519 identity with signed messages

### Phase 2 — Global P2P (upcoming)
- [ ] Switch transport from TCP WebSockets to UDP (`dgram`)
- [ ] UDP hole-punching for NAT traversal (internet play)
- [ ] Minimal signalling server to broker peer IP/port exchange
- [ ] Relay fallback for symmetric NAT environments
- [ ] Optional matchmaking lobby (public game codes)

> Contributions toward Phase 2 are very welcome — see [Contributing](#contributing) below.

---

## Contributing

1. Keep `chess-democracy-core` framework-agnostic — no Electron imports, no React.
2. All IPC channel names go in `ipc-channels.ts` — never hard-code a string.
3. No component reads `window.chessDemocracy` directly — route through the Zustand store.
4. Run `npm test` before opening a PR.
5. If you change a protocol flow (voting, resign, draw), update the matching diagram in `docs/`.
