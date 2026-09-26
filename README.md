<p align="center">
  <img src="docs/icon.png" width="90" alt="Chess Democracy" />
</p>

# Chess Democracy

A peer-to-peer multiplayer chess client built with Electron + React + TypeScript. Players connect directly over LAN/Wi-Fi using mDNS discovery — no server required. Multiple players can join the same side and vote on moves collectively. The project strives for a global working Peer 2 Peer version.

## How a game works

Open the app on two or more machines on the same network. They find each other over mDNS with no configuration, no lobby server, and no accounts.

Pick a side. Any number of players can join the same one. When it is your side's turn a voting window opens (30s by default) and everyone on that side votes for a legal move. The plurality winner is played. A two-way tie breaks deterministically so every node commits the same move; a three-way split with no majority reopens the window.

Resigning works the same way. No single player can give up the game on their own: enough of your connected teammates have to agree first.

## Architecture

```
Chess-Democracy/
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
            ├── useChessDemocracy.ts # IPC ↔ store bridge (subscriptions + hydration)
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

### Who counts the votes

If every node counted the votes it happened to receive, two nodes could see different votes, play different moves, and drift apart. So only one node counts: the master, which is whoever has the lowest public key.

When the window closes, the master sends a `tally_result` with the winning move and every vote it counted, each still carrying its voter's own signature. Every other node then checks it before applying anything:

- each vote's signature is valid for the voter it names
- every voter is on the side to move, voted once, and chose a legal move
- every vote belongs to this turn and this round
- counting the votes again gives the result the master announced

If all of that holds, the move is played. If not, the game stops with a "got out of sync" message instead of carrying on in a different position from everyone else. If the master drops out mid-turn, the next-lowest key takes over, since every node already has every vote.

The master can't invent votes or miscount. What it can do is leave a valid vote out, because a vote it dropped and a vote that arrived too late look the same to everyone else. Fine for games between friends; worth knowing if you play with strangers.

### Resign vote protocol

No single player can unilaterally resign. Clicking Resign casts a yes vote. Once ≥ `resignThreshold` (default 67 %) of the currently connected teammates have voted yes, the side forfeits. The vote window auto-expires after `resignWindowMs` (default 60 s) with no effect if the threshold is not reached. Teammate disconnects shrink the denominator — a vote that was at 1/3 becomes 1/2 if a non-voter leaves. Config keys `resignThreshold` and `resignWindowMs` flow through the existing config-proposal handshake.

### Draw protocol

Any player can offer a draw. Only the other side can accept it: opponents see a banner with Accept and Decline, teammates of the player who offered just get told about it. Accepting broadcasts `game_over` with reason `draw_agreement`, and nodes refuse one if no draw was offered or if it comes from the side that offered.

### Dropped connections

When a game starts, its players are fixed. From then on only those players can connect, so another copy of the app starting on the same network can't wander into the game.

Votes are only counted while more than half the players are connected. A player who loses their connection waits rather than carrying on alone, which would give them a game of their own that couldn't be merged back.

On a LAN the player with the lower key keeps retrying a dropped connection for about a minute. When a player comes back, both sides send each other a snapshot: the moves so far, the open vote window, and the signed votes already cast in it. Whoever is behind replays the moves they missed and picks up the votes, each checked like any other forwarded vote. If the two histories disagree instead of one lagging, the game stops as out of sync.

Snapshot moves are checked for legality but not re-proven with the votes that chose them, so a returning player trusts whoever is ahead. Among friends that's fine.

### Move timeout

Each voting window has a hard cap (`MOVE_TIMEOUT_MS`, default 120 s). If no tally fires before the cap, the game ends with reason `timeout`.

---

## Prerequisites

- Node.js ≥ 22 (LTS recommended)
- npm ≥ 10

---

## Setup

```bash
git clone https://github.com/AyoubThemry/Chess-Democracy.git
cd Chess-Democracy
npm run setup
```

`setup` installs all three package trees and builds the core, which the Electron
shell needs before it can import anything.

<details>
<summary>Doing it by hand</summary>

```bash
cd chess-democracy-core
npm install
npm run build          # must run before the Electron shell can import core

cd ../chess-democracy-electron
npm install

cd ReactChessDemocracy
npm install
```

</details>

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
npm run stage:core   →  copies core into staging/ with runtime dependencies only
npm run build:react  →  Vite build of ReactChessDemocracy  (outputs ReactChessDemocracy/dist/)
npm run build        →  tsc on the Electron main process  (outputs chess-democracy-electron/dist-ts/)
npm run dist         →  electron-builder  (packages final .exe / .dmg / .AppImage)
```

> **Never run `npm run dist` directly** — it skips the TypeScript compilation steps and packages stale JS. The result is a broken exe (e.g. `drawOffered is not a function`).

Artifacts land in `chess-democracy-electron/release/`:

| File | What it is |
|---|---|
| `Chess Democracy Setup 0.1.3.exe` | Installer. Recommended: installs once, then starts in under a second. |
| `ChessDemocracy-0.1.3-portable.exe` | Single file, no install. Unpacks itself on every launch, so it takes a few seconds to start. |
| `win-unpacked/` | The unpacked app the two above are built from. |

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
| `tally_result` | broadcast (master only) | Winning move plus every signed vote counted, so others can recount |
| `game_snapshot` | to one peer | Moves so far, the open window and its votes, for a player who just reconnected |
| `ping` | broadcast | Keepalive, so an idle player isn't dropped as gone |
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

## Adding a transport

The game doesn't know it's running over WebSockets and mDNS. `Node` takes a `NetworkFactory` and talks to the `GameNetwork` interface in `chess-democracy-core/src/network/game-network.ts`; the LAN version is `LocalNetworkController.create`, the default.

A different transport, such as one that works across the internet, needs to:

- implement `GameNetwork`: the broadcast methods, `sync`, and `peer:connected` / `peer:disconnected` events
- give each peer a `PeerConnection` (`isOpen`, `send`, `close`) instead of a WebSocket
- deliver inbound packets to the `MessageCallbacks` it's created with, through `MessageService.HandleMessage` so signatures and replay protection still apply

Then pass it in: `new Node(identityPath, myTransport)`. Voting, verification, resync and the UI all work unchanged.

## Contributing

1. Keep `chess-democracy-core` framework-agnostic — no Electron imports, no React.
2. All IPC channel names go in `ipc-channels.ts` — never hard-code a string.
3. No component reads `window.chessDemocracy` directly — route through the Zustand store.
4. Run `npm test` before opening a PR.
5. If you change a protocol flow (voting, resign, draw), update the matching diagram in `docs/`.
