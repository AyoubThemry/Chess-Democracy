// Electron main process — bridges chess-democracy-core (ESM) with the React renderer via IPC.
// core is loaded with dynamic import() because it is ESM and this file is CJS.
// The node is created lazily on identity:start, not at app boot.

import { app, BrowserWindow, ipcMain, IpcMainInvokeEvent, dialog } from 'electron';
import * as path from 'path';
import * as fs   from 'fs';
import {
    INVOKE,
    PUSH,
    IpcResult,
    GameSnapshot,
    PeerSummary,
    ConfigSnapshot,
    GameConfig,
} from './src/ipc-channels';

const isDev = process.env.ELECTRON_DEV === 'true';

process.on('uncaughtException', (err: Error) => {
    if (err.message.includes('Service name is already in use')) {
        console.warn('[mDNS] Name conflict detected — mDNS publish skipped for this instance');
        return;
    }
    throw err;
});

// Minimal type surface for the dynamically-imported Node class

interface GameStateInterface {
    phase:       string;
    gameId:      string;
    myTeam:      string | null;
    currentTurn: string;
    isMyTurn:    boolean;
    fen:         string;
    legalMoves:  string[];
    moveHistory: Array<{
        moveIndex: number; move: string; senderKey: string;
        fenBefore: string; fenAfter: string; timestamp: number;
    }>;
    result:      { winner: string | null; reason: string } | null;
    startsAt:    number | null;
}

interface PeerInterface {
    peerPublicNodeId: string;
    team:             string | null;
    ready:            boolean;
    status:           string;
}

interface NodeInterface {
    identity:     { publicKey: string };
    chosenTeam:   string | null;
    gameState:    GameStateInterface;
    allPeers:     Map<string, PeerInterface>;
    gameConfig:   { voteWindowMs: number; maxRevotes: number };
    configVersion: number;
    selfAcceptedConfigVersion: number | null;
    peerAcceptedVersions: Map<string, number>;
    on(event: string, listener: (...args: any[]) => void): this;
    boot(port: number): void;
    setTeam(team: string): boolean;
    ready(): string;
    unready(): string;
    submitMove(move: string): string;
    castResignVote(): string;
    stop(): void;
    setConfig(voteWindowMs: number, maxRevotes: number, resignThreshold?: number, resignWindowMs?: number): string;
    acceptConfig(): string;
    castVote(move: string): string;
    offerDraw(): string;
    respondToDraw(accept: boolean): string;
    reset(): void;
}

// ---
// Helpers
// ---

function ok<T>(value: T): IpcResult<T>         { return { ok: true,  value }; }
function fail(error: string): IpcResult<never>  { return { ok: false, error }; }

// ---
// Identity / prefs paths
// ---

function prefsPath(): string {
    return path.join(app.getPath('userData'), 'chess-democracy-prefs.json');
}

function defaultIdentityPath(): string {
    return path.join(app.getPath('home'), '.chess-democracy', 'identity.pem');
}

interface Prefs {
    remembered:   boolean;
    identityPath: string | null;
}

function readPrefs(): Prefs {
    try {
        if (fs.existsSync(prefsPath())) {
            return JSON.parse(fs.readFileSync(prefsPath(), 'utf8')) as Prefs;
        }
    } catch { /* ignore corrupt prefs */ }
    return { remembered: false, identityPath: null };
}

function writePrefs(data: Prefs): void {
    fs.writeFileSync(prefsPath(), JSON.stringify(data, null, 2), 'utf8');
}

// ---
// Window
// ---

let win: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
    const w = new BrowserWindow({
        width:  1100,
        height: 720,
        webPreferences: {
            contextIsolation: true,
            sandbox: false,
            nodeIntegration:  false,
            preload: path.join(__dirname, 'src', 'preload.js'),
        },
    });

    if (isDev) {
        w.loadURL('http://localhost:5173');
        w.webContents.openDevTools();
    } else {
        w.loadFile(path.join(process.resourcesPath, 'ReactChessDemocracy', 'dist', 'index.html'));
    }

    return w;
}

function push<T>(channel: string, payload: T): void {
    if (win && !win.isDestroyed()) {
        win.webContents.send(channel, payload);
    }
}

// ---
// Node lifecycle — deferred until identity:start is called
// ---

let node: NodeInterface | null = null;
let gameHandlersRegistered = false;

function buildSnapshot(): GameSnapshot {
    const gs = node!.gameState;
    return {
        phase:       gs.phase       as GameSnapshot['phase'],
        gameId:      gs.gameId,
        myTeam:      gs.myTeam      as GameSnapshot['myTeam'],
        currentTurn: gs.currentTurn as GameSnapshot['currentTurn'],
        isMyTurn:    gs.isMyTurn,
        fen:         gs.fen,
        legalMoves:  gs.legalMoves,
        moveHistory: gs.moveHistory,
        result:      gs.result      as GameSnapshot['result'],
        startsAt:    gs.startsAt,
    };
}

function buildPeerList(): PeerSummary[] {
    return [...node!.allPeers.values()].map(p => ({
        peerId:  p.peerPublicNodeId,
        team:    p.team   as PeerSummary['team'],
        ready:   p.ready,
        status:  p.status as PeerSummary['status'],
    }));
}

function buildConfigSnapshot(): ConfigSnapshot {
    const accepted = node!.peerAcceptedVersions;
    const version  = node!.configVersion;
    return {
        config:          node!.gameConfig as GameConfig,
        version,
        selfAccepted:    node!.selfAcceptedConfigVersion === version,
        peerAcceptedIds: [...node!.allPeers.keys()].filter(k => accepted.get(k) === version),
    };
}

function registerGameHandlers(): void {
    if (gameHandlersRegistered) return;
    gameHandlersRegistered = true;

    ipcMain.handle(INVOKE.NODE_GET_IDENTITY, () =>
        ok({ publicKey: node!.identity.publicKey, team: node!.chosenTeam, phase: node!.gameState.phase })
    );

    ipcMain.handle(INVOKE.NODE_GET_STATE, () => ok(buildSnapshot()));

    ipcMain.handle(INVOKE.PEER_GET_ALL, () => ok(buildPeerList()));

    ipcMain.handle(INVOKE.GAME_SET_TEAM, (_e: IpcMainInvokeEvent, payload: { team: string }) => {
        if (payload.team !== 'white' && payload.team !== 'black') {
            return fail(`invalid_team:${payload.team}`);
        }
        return node!.setTeam(payload.team)
            ? ok(undefined)
            : fail(`already_set:${node!.chosenTeam}`);
    });

    ipcMain.handle(INVOKE.GAME_READY, () => {
        const r = node!.ready();
        return r === 'ok' ? ok(undefined) : fail(r);
    });

    ipcMain.handle(INVOKE.GAME_SUBMIT_MOVE, (_e: IpcMainInvokeEvent, payload: { move: string }) => {
        if (!payload?.move || typeof payload.move !== 'string') {
            return fail('invalid_payload:move must be a string');
        }
        const r = node!.submitMove(payload.move);
        return r === 'ok' ? ok(buildSnapshot()) : fail(r);
    });

    ipcMain.handle(INVOKE.GAME_RESIGN, () => {
        const r = node!.castResignVote();
        return r === 'ok' ? ok(undefined) : fail(r);
    });

    ipcMain.handle(INVOKE.GAME_UNREADY, () => {
        const r = node!.unready();
        return r === 'ok' ? ok(undefined) : fail(r);
    });

    ipcMain.handle(INVOKE.NODE_GET_CONFIG, () => ok(buildConfigSnapshot()));

    ipcMain.handle(INVOKE.GAME_SET_CONFIG, (_e: IpcMainInvokeEvent, payload: { voteWindowMs: number; maxRevotes: number; resignThreshold?: number; resignWindowMs?: number }) => {
        if (typeof payload?.voteWindowMs !== 'number' || typeof payload?.maxRevotes !== 'number') {
            return fail('invalid_payload');
        }
        const r = node!.setConfig(payload.voteWindowMs, payload.maxRevotes, payload.resignThreshold, payload.resignWindowMs);
        return r === 'ok' ? ok(undefined) : fail(r);
    });

    ipcMain.handle(INVOKE.GAME_ACCEPT_CONFIG, () => {
        const r = node!.acceptConfig();
        return r === 'ok' ? ok(undefined) : fail(r);
    });

    ipcMain.handle(INVOKE.GAME_CAST_VOTE, (_e: IpcMainInvokeEvent, payload: { move: string }) => {
        if (!payload?.move || typeof payload.move !== 'string') {
            return fail('invalid_payload:move must be a string');
        }
        const r = node!.castVote(payload.move);
        return r === 'ok' ? ok(undefined) : fail(r);
    });

    ipcMain.handle(INVOKE.GAME_RESET, () => {
        node!.reset();
        return ok(undefined);
    });

    ipcMain.handle(INVOKE.GAME_OFFER_DRAW, () => {
        const r = node!.offerDraw();
        return r === 'ok' ? ok(undefined) : fail(r);
    });

    ipcMain.handle(INVOKE.GAME_RESPOND_DRAW, (_e: IpcMainInvokeEvent, payload: { accept: boolean }) => {
        const r = node!.respondToDraw(payload?.accept ?? false);
        return r === 'ok' ? ok(undefined) : fail(r);
    });
}

function unregisterGameHandlers(): void {
    if (!gameHandlersRegistered) return;
    gameHandlersRegistered = false;
    [
        INVOKE.NODE_GET_IDENTITY, INVOKE.NODE_GET_STATE, INVOKE.PEER_GET_ALL,
        INVOKE.GAME_SET_TEAM,     INVOKE.GAME_READY,     INVOKE.GAME_SUBMIT_MOVE,
        INVOKE.GAME_RESIGN,       INVOKE.GAME_UNREADY,   INVOKE.NODE_GET_CONFIG,
        INVOKE.GAME_SET_CONFIG,   INVOKE.GAME_ACCEPT_CONFIG, INVOKE.GAME_CAST_VOTE,
        INVOKE.GAME_RESET,        INVOKE.GAME_OFFER_DRAW,    INVOKE.GAME_RESPOND_DRAW,
    ].forEach(ch => ipcMain.removeHandler(ch));
}

// Starting up is two steps. Login only loads (or creates) the player's key;
// no networking happens until they pick a network. Then a Node is created
// with that network's transport and started.

let identityPath: string | null = null;   // chosen at login
let networkKind:  string | null = null;   // chosen on the network screen

/** Loads a module from the core, in dev or in the packaged app. */
function coreModule<T>(relative: string): Promise<T> {
    const base = app.isPackaged
        ? path.join(process.resourcesPath, 'chess-democracy-core', 'dist')
        : path.join(__dirname, '..', '..', 'chess-democracy-core', 'dist');
    return import(path.join(base, ...relative.split('/'))) as Promise<T>;
}

async function loadIdentity(requestedPath?: string): Promise<{ publicKey: string; identityPath: string }> {
    const resolvedPath = requestedPath ?? defaultIdentityPath();
    const { loadOrCreateIdentity } = await coreModule<{
        loadOrCreateIdentity(p: string): { publicKey: string };
    }>('protocol/identity-store.js');
    const { publicKey } = loadOrCreateIdentity(resolvedPath);
    identityPath = resolvedPath;
    return { publicKey, identityPath: resolvedPath };
}

async function connectNetwork(kind: string): Promise<void> {
    if (!identityPath) throw new Error('no_identity');

    const [{ Node }, { networkFactory }] = await Promise.all([
        coreModule<{ Node: new (identityPath?: string, createNetwork?: unknown) => NodeInterface }>('core/node.js'),
        coreModule<{ networkFactory(kind: string): unknown }>('network/networks.js'),
    ]);
    const factory = networkFactory(kind);   // throws for one that isn't available

    stopNode();                             // switching: drop the old network first
    node = new Node(identityPath, factory);
    networkKind = kind;
    node.boot(0);

    // Push node events → renderer
    node.on('peer:joined',          (d: any) => push(PUSH.PEER_JOINED,          d));
    node.on('peer:left',            (d: any) => push(PUSH.PEER_LEFT,            d));
    node.on('peer:team_updated',    (d: any) => push(PUSH.PEER_TEAM_UPDATED,    d));
    node.on('peer:ready_changed',   (d: any) => push(PUSH.PEER_READY_CHANGED,   d));
    node.on('waiting:for_side',     (d: any) => push(PUSH.GAME_WAITING_SIDE,    d));
    node.on('game:starting',        (d: any) => push(PUSH.GAME_STARTING,        d));
    node.on('game:started',         (d: any) => push(PUSH.GAME_STARTED,         d));
    node.on('game:move',            (d: any) => push(PUSH.GAME_MOVE,            d));
    node.on('game:over',            (d: any) => push(PUSH.GAME_OVER,            d));
    node.on('config:updated',       (d: any) => push(PUSH.CONFIG_UPDATED,       d));
    node.on('config:peer_accepted', (d: any) => push(PUSH.CONFIG_PEER_ACCEPTED, d));
    node.on('config:self_accepted', (d: any) => push(PUSH.CONFIG_SELF_ACCEPTED, d));
    node.on('vote:window_opened',   (d: any) => push(PUSH.VOTE_WINDOW_OPENED,   d));
    node.on('vote:received',        (d: any) => push(PUSH.VOTE_RECEIVED,        d));
    node.on('tally:done',           (d: any) => push(PUSH.TALLY_DONE,           d));
    node.on('revote:started',       (d: any) => push(PUSH.REVOTE_STARTED,       d));
    node.on('game:reset',           ()       => push(PUSH.GAME_RESET,           {}));
    node.on('draw:offered',         (d: any) => push(PUSH.DRAW_OFFERED,         d));
    node.on('draw:declined',        (d: any) => push(PUSH.DRAW_DECLINED,        d));
    node.on('resign:vote_started',  (d: any) => push(PUSH.RESIGN_VOTE_STARTED,  d));
    node.on('resign:vote_updated',  (d: any) => push(PUSH.RESIGN_VOTE_UPDATED,  d));
    node.on('resign:vote_expired',  ()       => push(PUSH.RESIGN_VOTE_EXPIRED,  {}));

    registerGameHandlers();
}

function stopNode(): void {
    if (node) { node.stop(); node = null; }
    networkKind = null;
    unregisterGameHandlers();
}

// ---
// Identity IPC handlers — registered once, before any node exists
// ---

function registerIdentityHandlers(): void {

    ipcMain.handle(INVOKE.IDENTITY_GET_PREFS, () => {
        const prefs = readPrefs();
        return ok({ remembered: prefs.remembered, identityPath: prefs.identityPath });
    });

    ipcMain.handle(INVOKE.IDENTITY_START, async (_e: IpcMainInvokeEvent, payload?: { identityPath?: string; forceNew?: boolean }) => {
        try {
            if (payload?.forceNew) {
                // Delete the existing PEM so loadOrCreateIdentity generates a fresh keypair
                const target = payload?.identityPath ?? defaultIdentityPath();
                if (fs.existsSync(target)) fs.unlinkSync(target);
            }
            return ok(await loadIdentity(payload?.identityPath ?? undefined));
        } catch (err: any) {
            return fail(err?.message ?? 'failed_to_load_identity');
        }
    });

    ipcMain.handle(INVOKE.NETWORK_GET_OPTIONS, async () => {
        const { networkOptions } = await coreModule<{ networkOptions(): unknown }>('network/networks.js');
        return ok(networkOptions());
    });

    ipcMain.handle(INVOKE.NETWORK_CONNECT, async (_e: IpcMainInvokeEvent, payload: { network: string }) => {
        try {
            await connectNetwork(payload?.network);
            return ok({ network: payload.network });
        } catch (err: any) {
            return fail(err?.message ?? 'failed_to_connect');
        }
    });

    ipcMain.handle(INVOKE.NETWORK_LEAVE, () => {
        // A running game lives on one network. Leaving mid-game would just drop
        // the player from it, so only allow it before pressing Ready.
        const phase = node?.gameState.phase;
        if (phase && phase !== 'waiting_for_side' && phase !== 'waiting_for_ready') {
            return fail(`in_game:${phase}`);
        }
        stopNode();
        return ok(undefined);
    });

    ipcMain.handle(INVOKE.IDENTITY_SAVE_PREF, (_e: IpcMainInvokeEvent, payload: { identityPath: string }) => {
        if (!payload?.identityPath) return fail('missing_identity_path');
        writePrefs({ remembered: true, identityPath: payload.identityPath });
        return ok(undefined);
    });

    ipcMain.handle(INVOKE.IDENTITY_LOGOUT, () => {
        const prefs = readPrefs();
        writePrefs({ ...prefs, remembered: false });
        stopNode();
        identityPath = null;
        // Reload the window so React re-mounts fresh and shows the login screen
        win?.webContents.reload();
        return ok(undefined);
    });

    ipcMain.handle(INVOKE.IDENTITY_OPEN_FILE, async () => {
        if (!win) return ok({ filePath: null });
        const result = await dialog.showOpenDialog(win, {
            title:       'Select identity PEM file',
            buttonLabel: 'Use this key',
            filters:     [{ name: 'PEM files', extensions: ['pem'] }, { name: 'All files', extensions: ['*'] }],
            properties:  ['openFile'],
        });
        return ok({ filePath: result.canceled ? null : (result.filePaths[0] ?? null) });
    });
}

// ---
// App lifecycle
// ---

app.whenReady().then(() => {
    win = createWindow();
    registerIdentityHandlers();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) win = createWindow();
    });
});

app.on('before-quit', () => {
    node?.stop();
    // Remove all handlers cleanly
    unregisterGameHandlers();
    [
        INVOKE.IDENTITY_GET_PREFS, INVOKE.IDENTITY_START,
        INVOKE.IDENTITY_SAVE_PREF, INVOKE.IDENTITY_LOGOUT,
        INVOKE.IDENTITY_OPEN_FILE,
        INVOKE.NETWORK_GET_OPTIONS, INVOKE.NETWORK_CONNECT, INVOKE.NETWORK_LEAVE,
    ].forEach(ch => ipcMain.removeHandler(ch));
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
