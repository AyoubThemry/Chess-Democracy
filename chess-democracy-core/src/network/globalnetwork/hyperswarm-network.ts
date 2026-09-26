import Hyperswarm, { type PeerDiscovery } from 'hyperswarm';
import DHT, { type KeyPair } from 'hyperdht';
import { createHash, randomUUID } from 'crypto';
import type { Duplex } from 'stream';
import { PeerMessaging } from '../peer-messaging.js';
import { MessageService, NonceStore, type MessageCallbacks } from '../message-service.js';
import { Peer, PeerStatus } from '../peer.js';
import type { GameNetwork, NetworkContext, NetworkFactory, GameSummary } from '../game-network.js';
import { LobbyAdvertiser } from './lobby.js';
import { HyperswarmConnection } from './hyperswarm-connection.js';
import { signMessage, verifySignature } from '../../protocol/verifysignsignature.js';
import { NETWORK_CONFIG } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';

export interface GlobalNetworkOptions {
    /** The code players share to find each other. Everyone with it lands in the same game. */
    room: string;
    /** List the game in the public lobby so anyone can find it. */
    public?: boolean;
    /** Tests only: a local DHT instead of the public one. */
    bootstrap?: Array<{ host: string; port: number }>;
}

const DISCOVERY = {
    LOOKUP_ALONE_MS:  3_000,   // how often to look the room up while nobody's here yet
    LOOKUP_MS:       15_000,   // and afterwards, to catch players we missed
    REACH_CHECK_MS:   2_000,   // how often to compare players found with players reached
    STUCK_MS:        20_000,   // found but not reached for this long: probably a NAT that won't open
};

/** Players found in the room, and how many of them we're actually connected to. */
export interface RoomReach {
    found:     number;
    connected: number;
    /** Someone was found but hasn't been reached for a while. */
    stuck:     boolean;
}

/** Players find each other by joining the same topic: a hash of the room code. */
export function roomTopic(room: string): Buffer {
    return createHash('sha256').update('chess-democracy:' + room.trim().toLowerCase()).digest();
}

/**
 * Plays over the internet through hyperswarm. Peers are found on a public
 * DHT by room code, hyperswarm punches through NATs, and every connection is
 * end-to-end encrypted.
 *
 * On top of that runs the same protocol as the LAN: each side proves who it
 * is with its Ed25519 key before anything else, and every message is signed
 * and checked by MessageService exactly as on the LAN.
 */
export class HyperswarmNetwork extends PeerMessaging implements GameNetwork {
    protected readonly identity:    { publicKey: string; privateKey: string };
    protected readonly getAllPeers: () => Map<string, Peer>;
    private readonly callbacks:     MessageCallbacks;
    private readonly accepting:     (peerKey?: string) => boolean;
    private readonly summary:       () => GameSummary;
    private readonly nonces       = new NonceStore();
    private readonly keyPair:       KeyPair;

    private swarm?:         Hyperswarm;
    private discovery?:     PeerDiscovery;
    private pingInterval?:  NodeJS.Timeout;
    private ghostInterval?: NodeJS.Timeout;
    private lookupTimer?:   NodeJS.Timeout;
    private reachInterval?: NodeJS.Timeout;
    private advertiser?:    LobbyAdvertiser;
    private lastReach:      RoomReach = { found: 0, connected: 0, stuck: false };
    private unreachedSince: number | null = null;

    constructor(ctx: NetworkContext, private readonly options: GlobalNetworkOptions) {
        super();
        this.identity    = ctx.identity;
        this.getAllPeers = ctx.getAllPeers;
        this.callbacks   = ctx.callbacks;
        this.accepting   = ctx.acceptingConnection;
        this.summary     = ctx.summary;
        this.keyPair     = DHT.keyPair();
    }

    /** A NetworkFactory for one room. There's no port to report: hyperswarm has no fixed one. */
    static create(options: GlobalNetworkOptions): NetworkFactory {
        return async (ctx) => ({ network: new HyperswarmNetwork(ctx, options), boundPort: 0 });
    }

    /** This node's hyperswarm key, which a peer's hello has to be addressed to. */
    get swarmKey(): string {
        return this.keyPair.publicKey.toString('hex');
    }

    start(): void {
        this.swarm = new Hyperswarm({ keyPair: this.keyPair, bootstrap: this.options.bootstrap });
        this.swarm.on('connection', (socket, info) => this.handleConnection(socket, info.publicKey));
        this.discovery = this.swarm.join(roomTopic(this.options.room), { server: true, client: true });
        logger.info(`Joined room`, { topic: roomTopic(this.options.room).toString('hex').slice(0, 8) });
        this.scheduleLookup();

        const swarm = this.swarm;
        swarm.dht.fullyBootstrapped().then(() => {
            logger.info(`Internet connection ready`, { nat: natType(swarm) });
        }).catch(() => {});
        this.reachInterval = setInterval(() => this.checkReach(), DISCOVERY.REACH_CHECK_MS);
        this.reachInterval.unref();

        if (this.options.public) {
            this.advertiser = new LobbyAdvertiser(this.identity, this.options.room, this.summary, this.options.bootstrap);
            this.advertiser.start();
        }

        // Same keepalive and dead-peer sweep as the LAN transport.
        this.pingInterval = setInterval(() => {
            MessageService.broadcast({ type: 'ping' }, this.getAllPeers(), this.identity);
        }, NETWORK_CONFIG.GHOST_TIMEOUT_MS / 3);
        this.pingInterval.unref();
        this.ghostInterval = setInterval(() => this.sweepSilentPeers(), NETWORK_CONFIG.GHOST_TIMEOUT_MS / 3);
        this.ghostInterval.unref();
    }

    stop(): void {
        this.advertiser?.stop();
        clearTimeout(this.lookupTimer);
        clearInterval(this.reachInterval);
        clearInterval(this.pingInterval);
        clearInterval(this.ghostInterval);
        this.nonces.clear();
        void this.discovery?.destroy().catch(() => {});
        void this.swarm?.destroy().catch(() => {});
    }

    /**
     * Every new connection starts with a signed hello from each side. Only
     * after a valid one does the peer exist for the game.
     *
     * The hello names the hyperswarm key it was sent to, so a peer can't take
     * a hello it received and pass it on to someone else to pose as its author.
     */
    handleConnection(socket: Duplex, remoteSwarmKey: Buffer): void {
        const connection = new HyperswarmConnection(socket);
        let peer: Peer | null = null;

        const timeout = setTimeout(() => {
            if (!peer) {
                logger.warn(`No hello from a new connection, closing it`);
                connection.close();
            }
        }, NETWORK_CONFIG.HANDSHAKE_TIMEOUT_MS);
        timeout.unref();

        connection.onClose(() => {
            clearTimeout(timeout);
            if (peer && peer.status !== PeerStatus.Dead) {
                peer.status = PeerStatus.Dead;
                this.emit('peer:disconnected', peer);
            }
        });

        connection.onMessage((line) => {
            let packet: { payload: Record<string, unknown>; signature: string };
            try {
                packet = JSON.parse(line);
            } catch {
                connection.close();
                return;
            }

            if (!peer) {
                const key = this.checkHello(packet);
                if (!key) { connection.close(); return; }
                clearTimeout(timeout);

                // hyperswarm keeps one connection per peer, so a new one means
                // the old is on its way out. Retire it now; if Node still saw
                // it as alive it would ignore this one and the peer would be
                // connected but unheard.
                const existing = this.getAllPeers().get(key);
                if (existing && existing.connection !== connection && existing.status === PeerStatus.Alive) {
                    existing.status = PeerStatus.Dead;
                    existing.connection.close();
                    this.emit('peer:disconnected', existing);
                }

                peer = new Peer({ peerPublicNodeId: key, ip: 'hyperswarm', port: 0 }, connection);
                logger.info(`Peer connected over the internet`, { peer: key.slice(0, 8) });
                this.emit('peer:connected', peer);
                return;
            }

            MessageService.HandleMessage(
                packet.payload as never, packet.signature, peer.peerPublicNodeId,
                this.getAllPeers(), this.identity.publicKey, this.identity.privateKey,
                this.callbacks, this.nonces,
            );
        });

        const hello = {
            key:       this.identity.publicKey,
            type:      'hello',
            to:        remoteSwarmKey.toString('hex'),
            timestamp: Date.now(),
            nonce:     randomUUID(),
        };
        connection.send(JSON.stringify({ payload: hello, signature: signMessage(JSON.stringify(hello), this.identity.privateKey) }));
    }

    /**
     * Look the room up again, repeatedly.
     *
     * A lookup only finds players who had already announced themselves. When
     * two players join at the same moment, each looks before the other has
     * announced, finds nobody, and hyperswarm wouldn't look again for minutes.
     * The same gap leaves two late joiners connected to the host but not to
     * each other, and every player has to reach every other.
     */
    private scheduleLookup(): void {
        const alone = this.getAllPeers().size === 0;
        this.lookupTimer = setTimeout(() => {
            this.discovery?.refresh({ client: true, server: false }).catch(() => {});
            this.scheduleLookup();
        }, alone ? DISCOVERY.LOOKUP_ALONE_MS : DISCOVERY.LOOKUP_MS);
        this.lookupTimer.unref();
    }

    /** Where the room stands: who we found versus who we reached. */
    get reach(): RoomReach {
        return this.lastReach;
    }

    /**
     * Compares the players hyperswarm found in the room with the ones we're
     * actually playing with. When someone is found but never reached, their
     * network or ours is refusing the direct connection, and without this
     * nothing would say so: the room would just look empty.
     */
    private checkReach(): void {
        if (!this.swarm) return;
        const found     = this.swarm.peers.size;
        const connected = [...this.getAllPeers().values()].filter(p => p.status === PeerStatus.Alive).length;

        if (found > connected) this.unreachedSince ??= Date.now();
        else                   this.unreachedSince = null;
        const stuck = this.unreachedSince !== null && Date.now() - this.unreachedSince > DISCOVERY.STUCK_MS;

        const last = this.lastReach;
        if (found === last.found && connected === last.connected && stuck === last.stuck) return;
        this.lastReach = { found, connected, stuck };

        if (stuck && !last.stuck) {
            const { dht, stats } = this.swarm;
            logger.warn(`Found players we can't connect to`, {
                found, connected,
                nat:      natType(this.swarm),
                attempts: stats.connects.client.attempted,
                opened:   stats.connects.client.opened,
                punches:  dht.stats.punches,
            });
        } else {
            logger.info(`Room`, { found, connected });
        }
        this.emit('reach', this.lastReach);
    }

    /** The sender's key if this is a valid hello meant for us, otherwise null. */
    private checkHello(packet: { payload?: Record<string, unknown>; signature?: unknown }): string | null {
        const p = packet?.payload;
        if (!p || p.type !== 'hello' || typeof p.key !== 'string' || typeof packet.signature !== 'string') return null;
        if (!verifySignature(JSON.stringify(p), packet.signature, p.key)) return reject('bad signature');
        if (p.to !== this.swarmKey)                                        return reject('addressed to someone else');
        if (typeof p.timestamp !== 'number' ||
            Math.abs(Date.now() - p.timestamp) > NETWORK_CONFIG.TIME_SKEW_TOLERANCE_MS) return reject('timestamp too far off');
        if (p.key === this.identity.publicKey)                             return reject('ourselves');
        if (this.getAllPeers().size >= NETWORK_CONFIG.MAX_PEERS)           return reject('room is full');
        if (!this.accepting(p.key))                                        return reject('not accepting this peer');
        return p.key;

        function reject(why: string): null {
            logger.warn(`Hello rejected: ${why}`, { peer: String(p!.key).slice(0, 8) });
            return null;
        }
    }

    private sweepSilentPeers(): void {
        const now = Date.now();
        for (const peer of this.getAllPeers().values()) {
            if (peer.status === PeerStatus.Alive && now - peer.lastSeen > NETWORK_CONFIG.GHOST_TIMEOUT_MS) {
                logger.warn(`Silent peer dropped`, { peer: peer.peerPublicNodeId.slice(0, 8) });
                peer.status = PeerStatus.Dead;
                peer.connection.close();
                this.emit('peer:disconnected', peer);
            }
        }
    }
}

/** How our router treats incoming connections, as far as the DHT could tell. */
function natType(swarm: Hyperswarm): string {
    const dht = swarm.dht;
    if (!dht.firewalled) return 'open';
    if (dht.randomized)  return 'random';   // the hard case: a new port for every destination
    if (dht.port)        return 'consistent';
    return 'unknown';
}
