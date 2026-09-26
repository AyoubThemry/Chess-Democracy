import { BaseNetworkController }  from "../base-network-controller.js";
import { PublisherService }       from "./publisher-service.js";
import { DiscoveryService }       from "./discovery-service.js";
import { MessageService, MessageCallbacks } from "../message-service.js";
import { WebsocketService }       from "../websocket-service.js";
import { PeerData, Peer }         from "../peer.js";
import { NETWORK_CONFIG }         from "../../utils/config.js";
import { logger }                 from "../../utils/logger.js";
import type { GameNetwork, NetworkFactory } from "../game-network.js";

export class LocalNetworkController extends BaseNetworkController implements GameNetwork {
    private publisher?:    PublisherService;
    private discoverer?:   DiscoveryService;
    private ghostInterval?: NodeJS.Timeout;
    private pingInterval?:  NodeJS.Timeout;
    private readonly reconnecting = new Map<string, NodeJS.Timeout>();
    private ownsListener = false;

    /**
     * The LAN transport as a NetworkFactory: boots a WebSocket server, then
     * builds the controller on whatever port it got.
     */
    static create: NetworkFactory = (ctx, requestedPort) => new Promise(resolve => {
        const listener = new WebsocketService();
        listener.on('ready', (boundPort: number) => {
            const network = new LocalNetworkController(
                'Chess-Democracy-Local',
                listener,
                ctx.identity,
                boundPort,
                ctx.getAlivePeersCount,
                ctx.getAllPeers,
                ctx.adjustAlivePeersCount,
                ctx.acceptingConnection,
                ctx.callbacks,
            );
            network.ownsListener = true;
            resolve({ network, boundPort });
        });
        listener.boot(requestedPort);
    });

    constructor(
        private readonly serviceName: string,
        listener:   WebsocketService,
        identity:   { publicKey: string; privateKey: string },
        port:       number,
        protected readonly getTotalAlivePeersCount:   () => number,
        protected readonly getAllPeers:               () => Map<string, Peer>,
        private   readonly adjustAlivePeersCount:     (sign: '+' | '-', amount: number) => void,
        protected readonly acceptingConnectionStatus: (peerKey?: string) => boolean,
        private   readonly callbacks:                 MessageCallbacks,
    ) {
        super(listener, identity, port, getTotalAlivePeersCount, getAllPeers, acceptingConnectionStatus);
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────

    public start(): void {
        this.publisher  = new PublisherService(this.identity.publicKey, this.port, this.serviceName);
        this.discoverer = new DiscoveryService();

        this.discoverer.on("discovered", (peerData: PeerData) => {
            if (this.getTotalAlivePeersCount() >= NETWORK_CONFIG.MAX_PEERS) return;
            this.connectToPeer(peerData);
        });

        this.discoverer.start(this.serviceName);

        this.on('peer:disconnected', (peer: Peer) => this.scheduleReconnect(peer));

        // Ghost detection reads peer.lastSeen, which only advances when a peer
        // sends something. Without this heartbeat an idle lobby would drop
        // every peer once GHOST_TIMEOUT_MS passed with nobody clicking.
        // Sent at a third of the timeout so two can be lost before a peer is
        // wrongly declared dead.
        this.pingInterval = setInterval(() => {
            MessageService.broadcast(
                { type: 'ping' },
                this.getAllPeers(),
                this.identity,
            );
        }, NETWORK_CONFIG.GHOST_TIMEOUT_MS / 3);
        this.pingInterval.unref();

        this.ghostInterval = setInterval(() => {
            this.removeGhosts(this.getAllPeers());
        }, NETWORK_CONFIG.GHOST_TIMEOUT_MS / 3);
        this.ghostInterval.unref();
    }

    public stop(): void {
        this.publisher?.stop();
        this.discoverer?.stop();
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = undefined;
        }
        if (this.ghostInterval) {
            clearInterval(this.ghostInterval);
            this.ghostInterval = undefined;
        }
        this.stopBase();
        if (this.ownsListener) this.listener.stop();
        for (const timer of this.reconnecting.values()) clearInterval(timer);
        this.reconnecting.clear();
    }

    /**
     * A peer dropped. On a LAN nothing brings the connection back by itself,
     * since mDNS doesn't announce the peer again, so retry for a while.
     *
     * Only the side with the lower key retries. If both did, their two new
     * connections would keep replacing each other.
     */
    private scheduleReconnect(peer: Peer): void {
        const key = peer.peerPublicNodeId;
        if (this.identity.publicKey > key || this.reconnecting.has(key)) return;

        let attempts = 0;
        const timer = setInterval(() => {
            attempts++;
            const done = this.getAllPeers().has(key)
                      || !this.acceptingConnectionStatus(key)
                      || attempts > NETWORK_CONFIG.RECONNECT_ATTEMPTS;
            if (done) {
                clearInterval(timer);
                this.reconnecting.delete(key);
                return;
            }
            void this.connectToPeer(peer.peerData);
        }, NETWORK_CONFIG.RECONNECT_INTERVAL_MS);
        timer.unref();
        this.reconnecting.set(key, timer);
    }

    public getPeers(): Map<string, Peer> {
        return this.getAllPeers();
    }

    /** Manually initiate a connection — used in tests to bypass Bonjour discovery. */
    public connectTo(peerData: PeerData): Promise<void> {
        return this.connectToPeer(peerData);
    }

    public getMessageCallbacks(): MessageCallbacks {
        return this.callbacks;
    }
}
