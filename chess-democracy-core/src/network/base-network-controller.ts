import { EventEmitter }        from 'events';
import { INetworkController }  from "./i-network-controller-interface.js";
import { WebsocketService }    from "./websocket-service.js";
import { ConnectorService }    from "./localnetwork/connector-service.js";
import { MessageService, MessageCallbacks, NonceStore } from "./localnetwork/message-service.js";
import { PeerData, Peer, PeerStatus } from "./peer.js";
import { WebSocketConnection } from "./peer-connection.js";
import { verifySignature }     from "../protocol/verifysignsignature.js";
import WebSocket               from 'ws';
import { toError }             from '../utils/errors.js';
import { NETWORK_CONFIG }      from '../utils/config.js';
import { logger }              from '../utils/logger.js';

export abstract class BaseNetworkController extends EventEmitter implements INetworkController {
    protected connector = new ConnectorService();
    private readonly nonces = new NonceStore();   // replay protection, this node's own

    // ── Rate limiting (per remote IP) ─────────────────────────────────────
    private readonly rateLimitMap              = new Map<string, number[]>();
    private readonly rateLimitCleanupInterval: NodeJS.Timeout;
    private readonly RATE_WINDOW_MS            = 60_000;

    constructor(
        protected readonly listener:                  WebsocketService,
        protected readonly identity:                  { publicKey: string; privateKey: string },
        protected readonly port:                      number,
        protected readonly getTotalAlivePeersCount:   () => number,
        protected readonly getAllPeers:               () => Map<string, Peer>,
        protected readonly acceptingConnectionStatus: (peerKey?: string) => boolean,
    ) {
        super();

        this.rateLimitCleanupInterval = setInterval(
            () => this.cleanRateLimitMap(),
            this.RATE_WINDOW_MS,
        );
        this.rateLimitCleanupInterval.unref();

        this.initializeInboundHandlers();
    }

    abstract start(): void;
    abstract stop(): void;
    abstract getPeers(): Map<string, Peer>;
    abstract getMessageCallbacks(): MessageCallbacks;

    protected stopBase(): void {
        clearInterval(this.rateLimitCleanupInterval);
        this.rateLimitMap.clear();
        this.nonces.clear();
    }

    // ── Rate limiting ─────────────────────────────────────────────────────

    private isRateLimited(ip: string): boolean {
        const now         = Date.now();
        const windowStart = now - this.RATE_WINDOW_MS;

        let attempts = this.rateLimitMap.get(ip);
        if (!attempts) {
            attempts = [];
            this.rateLimitMap.set(ip, attempts);
        }

        let writeIdx = 0;
        for (let i = 0; i < attempts.length; i++) {
            if (attempts[i] > windowStart) attempts[writeIdx++] = attempts[i];
        }
        attempts.length = writeIdx;
        attempts.push(now);

        if (attempts.length > NETWORK_CONFIG.MAX_HANDSHAKES_PER_MIN) {
            logger.warn(`Rate limit hit — dropping connection`, {
                ip,
                attempts: attempts.length,
                limit:    NETWORK_CONFIG.MAX_HANDSHAKES_PER_MIN,
            });
            return true;
        }
        return false;
    }

    private cleanRateLimitMap(): void {
        const windowStart = Date.now() - this.RATE_WINDOW_MS;
        for (const [ip, attempts] of this.rateLimitMap) {
            if (!attempts.some(t => t > windowStart)) {
                this.rateLimitMap.delete(ip);
            }
        }
    }

    // ── Inbound connection handling ───────────────────────────────────────

    private initializeInboundHandlers(): void {
        this.listener.on("connection", (socket: WebSocket, req) => {
            const remoteIp = req?.socket?.remoteAddress ?? "Unknown";

            if (this.isRateLimited(remoteIp)) {
                socket.close();
                return;
            }

            if (
                this.getTotalAlivePeersCount() < NETWORK_CONFIG.MAX_PEERS &&
                this.acceptingConnectionStatus()
            ) {
                socket.once("message", (data: Buffer) =>
                    this.handleHandshake(socket, remoteIp, data),
                );
            } else {
                socket.close();
            }
        });
    }

    private async handleHandshake(socket: WebSocket, ip: string, data: Buffer): Promise<void> {
        try {
            const info    = JSON.parse(data.toString("utf8"));
            const message = JSON.stringify(info.payload);

            if (!verifySignature(message, info.signature, info.payload.key)) {
                logger.warn(`Handshake rejected — bad signature`, { ip });
                socket.close();
                return;
            }

            if (Math.abs(Date.now() - info.payload.timestamp) > NETWORK_CONFIG.TIME_SKEW_TOLERANCE_MS) {
                logger.warn(`Handshake rejected — timestamp skew too large`, { ip });
                socket.close();
                return;
            }

            const p = info.payload.port;
            if (!p || typeof p !== 'number' || p < 1024 || p > 65535) {
                logger.error(`Handshake rejected — invalid port`, { ip, port: p });
                socket.close();
                return;
            }

            // Now we know who it is. The lobby may be closed, but a player
            // from the running game is allowed back in.
            if (!this.acceptingConnectionStatus(info.payload.key)) {
                logger.info(`Handshake refused, not accepting this peer`, { peer: String(info.payload.key).slice(0, 8) });
                socket.close();
                return;
            }

            // Before the ACK goes out: the peer may send the moment it gets it.
            const connection = new WebSocketConnection(socket);

            const isAckSent = await this.connector.sendConnectionAck(
                socket,
                this.identity.privateKey,
                this.port,
                this.identity.publicKey,
                info.payload.key,
            );

            if (isAckSent) {
                const peer = new Peer({ peerPublicNodeId: info.payload.key, ip, port: p }, connection);
                // Register the peer before delivering its messages, or the
                // ones held since the handshake arrive from an "unknown" peer.
                this.emit('peer:connected', peer);
                this.setupMessageHandling(peer, connection);
                logger.info(`Inbound peer connected`, { peer: info.payload.key.slice(0, 8), ip });
            }
        } catch (err: unknown) {
            logger.error(`Handshake error`, { ip, message: toError(err).message });
            socket.close();
        }
    }

    private setupMessageHandling(peer: Peer, connection: WebSocketConnection): void {
        const socket = connection.socket;
        socket.on("close", (code: number, reason: Buffer) => {
            logger.info(`Peer socket closed`, {
                peer:   peer.peerPublicNodeId.slice(0, 8),
                code,
                reason: reason.toString(),
            });
            // Guard: ghost detection may have already marked Dead and adjusted
            // the count before this async close event fires — skip if so.
            if (peer.status === PeerStatus.Dead) return;
            peer.status = PeerStatus.Dead;
            this.emit('peer:disconnected', peer);
        });

        socket.on("error", (error: Error) => {
            logger.error(`Peer socket error`, {
                peer:    peer.peerPublicNodeId.slice(0, 8),
                message: error.message,
            });
        });

        connection.onMessage((data: Buffer) => {
            try {
                const { payload, signature } = JSON.parse(data.toString("utf8"));
                MessageService.HandleMessage(
                    payload,
                    signature,
                    peer.peerPublicNodeId,
                    this.getPeers(),
                    this.identity.publicKey,
                    this.identity.privateKey,
                    this.getMessageCallbacks(),
                    this.nonces,
                );
            } catch (err: unknown) {
                logger.error(`Error handling peer message`, {
                    peer:    peer.peerPublicNodeId.slice(0, 8),
                    message: toError(err).message,
                });
            }
        });
    }

    // ── Outbound connection ───────────────────────────────────────────────

    protected async connectToPeer(peerData: PeerData): Promise<void> {
        if (peerData.peerPublicNodeId === this.identity.publicKey) return; // skip self
        if (this.getPeers().has(peerData.peerPublicNodeId))        return; // skip duplicate

        try {
            const peer = await this.connector.connect(
                peerData,
                this.identity.publicKey,
                this.identity.privateKey,
                this.port,
            );
            // The connector always builds a WebSocketConnection; this class is the
            // WebSocket transport, so it's the one place allowed to reach under it.
            this.emit('peer:connected', peer);   // before any of its messages, as above
            this.setupMessageHandling(peer, peer.connection as WebSocketConnection);
            logger.info(`Outbound peer connected`, { peer: peerData.peerPublicNodeId.slice(0, 8) });
        } catch (err: unknown) {
            logger.error(`Outbound connection failed`, {
                peer:    peerData.peerPublicNodeId.slice(0, 8),
                message: toError(err).message,
            });
        }
    }

    // ── Ghost detection ───────────────────────────────────────────────────

    /**
     * Peers that have gone silent past the timeout are treated as disconnected.
     *
     * This used to delete them from Node's map directly, without emitting
     * anything, so Node never updated the UI or the resign-vote denominator
     * and nothing could try to reconnect. Now it reports them the same way a
     * closed socket does and lets Node do the bookkeeping.
     */
    protected removeGhosts(
        peers:   Map<string, Peer>,
        timeout: number = NETWORK_CONFIG.GHOST_TIMEOUT_MS,
    ): void {
        const now = Date.now();
        for (const [id, peer] of peers) {
            if (peer.status === PeerStatus.Alive && (now - peer.lastSeen > timeout)) {
                logger.warn(`Ghost peer removed`, { peer: id.slice(0, 8) });
                // Mark first: the close handler skips peers already Dead, so
                // this is the only peer:disconnected for it.
                peer.status = PeerStatus.Dead;
                try {
                    peer.connection.close();
                } catch (err: unknown) {
                    logger.error(`Error closing ghost socket`, {
                        peer:    id.slice(0, 8),
                        message: toError(err).message,
                    });
                }
                this.emit('peer:disconnected', peer);
            }
        }
    }
}
