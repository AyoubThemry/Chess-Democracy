import Hyperswarm, { type PeerDiscovery } from 'hyperswarm';
import DHT, { type KeyPair } from 'hyperdht';
import { createHash, randomUUID } from 'crypto';
import type { Duplex } from 'stream';
import { PeerMessaging } from '../peer-messaging.js';
import { MessageService, NonceStore, type MessageCallbacks } from '../message-service.js';
import { Peer, PeerStatus } from '../peer.js';
import type { GameNetwork, NetworkContext, NetworkFactory } from '../game-network.js';
import { HyperswarmConnection } from './hyperswarm-connection.js';
import { signMessage, verifySignature } from '../../protocol/verifysignsignature.js';
import { NETWORK_CONFIG } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';

export interface GlobalNetworkOptions {
    /** The code players share to find each other. Everyone with it lands in the same game. */
    room: string;
    /** Tests only: a local DHT instead of the public one. */
    bootstrap?: Array<{ host: string; port: number }>;
}

const DISCOVERY = {
    LOOKUP_ALONE_MS:  3_000,   // how often to look the room up while nobody's here yet
    LOOKUP_MS:       15_000,   // and afterwards, to catch players we missed
};

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
    private readonly nonces       = new NonceStore();
    private readonly keyPair:       KeyPair;

    private swarm?:         Hyperswarm;
    private discovery?:     PeerDiscovery;
    private pingInterval?:  NodeJS.Timeout;
    private ghostInterval?: NodeJS.Timeout;
    private lookupTimer?:   NodeJS.Timeout;

    constructor(ctx: NetworkContext, private readonly options: GlobalNetworkOptions) {
        super();
        this.identity    = ctx.identity;
        this.getAllPeers = ctx.getAllPeers;
        this.callbacks   = ctx.callbacks;
        this.accepting   = ctx.acceptingConnection;
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

        // Same keepalive and dead-peer sweep as the LAN transport.
        this.pingInterval = setInterval(() => {
            MessageService.broadcast({ type: 'ping' }, this.getAllPeers(), this.identity);
        }, NETWORK_CONFIG.GHOST_TIMEOUT_MS / 3);
        this.pingInterval.unref();
        this.ghostInterval = setInterval(() => this.sweepSilentPeers(), NETWORK_CONFIG.GHOST_TIMEOUT_MS / 3);
        this.ghostInterval.unref();
    }

    stop(): void {
        clearTimeout(this.lookupTimer);
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
