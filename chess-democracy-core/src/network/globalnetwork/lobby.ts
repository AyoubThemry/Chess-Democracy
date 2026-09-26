import Hyperswarm, { type PeerDiscovery } from 'hyperswarm';
import { createHash, randomUUID } from 'crypto';
import { HyperswarmConnection } from './hyperswarm-connection.js';
import type { GameSummary } from '../game-network.js';
import { signMessage, verifySignature } from '../../protocol/verifysignsignature.js';
import { NETWORK_CONFIG } from '../../utils/config.js';

/**
 * Public games, with no server.
 *
 * Every player in a public game announces it on one well-known topic: the
 * lobby. Anyone browsing looks that topic up, connects to each announcer just
 * long enough to read a signed listing (room code, players, sides), and hangs
 * up. Joining is then the normal room-code flow. Private games never announce.
 *
 * This runs on its own small swarm, separate from the game's, so lobby
 * visitors never touch the game connection.
 */

export const LOBBY_TOPIC = createHash('sha256').update('chess-democracy:public-lobby:v1').digest();

const LOBBY = {
    RECHECK_MS:    5_000,   // how often an advertiser checks the game is still open
    BROWSE_MS:     6_000,   // longest a browse takes
    SETTLE_MS:       800,   // after connecting to everyone found, wait this long for their listings
    READ_MS:       3_000,   // give up on an announcer that doesn't send its listing
    MAX_LISTED:       50,
    ROOM_PATTERN: /^[a-z0-9-]{1,32}$/,
};

export interface PublicGame {
    room:      string;
    hostKey:   string;   // the player whose listing this is
    players:   number;
    whites:    number;
    blacks:    number;
    updatedAt: number;
}

/** A listing for this game, as one signed line. */
export function signListing(identity: { publicKey: string; privateKey: string }, room: string, summary: GameSummary): string {
    const payload = {
        key:       identity.publicKey,
        type:      'listing',
        room,
        players:   summary.players,
        whites:    summary.whites,
        blacks:    summary.blacks,
        timestamp: Date.now(),
        nonce:     randomUUID(),
    };
    return JSON.stringify({ payload, signature: signMessage(JSON.stringify(payload), identity.privateKey) });
}

/**
 * A listing read from the lobby, or null if it's malformed, unsigned, stale
 * or implausible. Anyone can announce on the lobby topic, so nothing here is
 * trusted beyond "this player signed it".
 */
export function readListing(line: string, now = Date.now()): PublicGame | null {
    let packet: { payload?: Record<string, unknown>; signature?: unknown };
    try { packet = JSON.parse(line); } catch { return null; }
    const p = packet?.payload;
    if (!p || p.type !== 'listing' || typeof p.key !== 'string' || typeof packet.signature !== 'string') return null;
    if (!verifySignature(JSON.stringify(p), packet.signature, p.key)) return null;
    if (typeof p.room !== 'string' || !LOBBY.ROOM_PATTERN.test(p.room)) return null;
    if (typeof p.timestamp !== 'number' || Math.abs(now - p.timestamp) > NETWORK_CONFIG.TIME_SKEW_TOLERANCE_MS) return null;
    const count = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= NETWORK_CONFIG.MAX_PEERS;
    if (!count(p.players) || !count(p.whites) || !count(p.blacks)) return null;
    return {
        room:      p.room,
        hostKey:   p.key,
        players:   p.players as number,
        whites:    p.whites as number,
        blacks:    p.blacks as number,
        updatedAt: p.timestamp,
    };
}

/** Announces one public game on the lobby for as long as it's open to join. */
export class LobbyAdvertiser {
    private swarm?:     Hyperswarm;
    private discovery?: PeerDiscovery;
    private timer?:     NodeJS.Timeout;

    constructor(
        private readonly identity:  { publicKey: string; privateKey: string },
        private readonly room:      string,
        private readonly summary:   () => GameSummary,
        private readonly bootstrap?: Array<{ host: string; port: number }>,
    ) {}

    start(): void {
        this.swarm = new Hyperswarm({ bootstrap: this.bootstrap });
        this.swarm.on('connection', (socket) => {
            socket.on('error', () => {});
            const summary = this.summary();
            if (summary.open) socket.end(signListing(this.identity, this.room, summary) + '\n');
            else socket.destroy();
        });
        this.update();
        this.timer = setInterval(() => this.update(), LOBBY.RECHECK_MS);
        this.timer.unref();
    }

    stop(): void {
        clearInterval(this.timer);
        void this.discovery?.destroy().catch(() => {});
        void this.swarm?.destroy().catch(() => {});
    }

    /** Announce while the game is open; stop once it starts, since nobody can join then. */
    private update(): void {
        const open = this.summary().open;
        if (open && !this.discovery) {
            this.discovery = this.swarm!.join(LOBBY_TOPIC, { server: true, client: false });
        } else if (!open && this.discovery) {
            void this.discovery.destroy().catch(() => {});
            this.discovery = undefined;
        }
    }
}

/** Looks the lobby up and returns the public games open to join, newest first. */
export async function browsePublicGames(
    options: { bootstrap?: Array<{ host: string; port: number }>; timeoutMs?: number } = {},
): Promise<PublicGame[]> {
    const swarm = new Hyperswarm({ bootstrap: options.bootstrap });
    const games = new Map<string, PublicGame>();

    swarm.on('connection', (socket) => {
        const connection = new HyperswarmConnection(socket);
        const giveUp = setTimeout(() => connection.close(), LOBBY.READ_MS);
        giveUp.unref();
        connection.onMessage((line) => {
            clearTimeout(giveUp);
            const game = readListing(line);
            // Several players of one game each announce it; keep the fullest view.
            if (game && (games.get(game.room)?.players ?? -1) < game.players) games.set(game.room, game);
            connection.close();
        });
    });

    swarm.join(LOBBY_TOPIC, { server: false, client: true });
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    await Promise.race([
        swarm.flush().then(() => sleep(LOBBY.SETTLE_MS)),
        sleep(options.timeoutMs ?? LOBBY.BROWSE_MS),
    ]);
    await swarm.destroy().catch(() => {});

    return [...games.values()]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, LOBBY.MAX_LISTED);
}
