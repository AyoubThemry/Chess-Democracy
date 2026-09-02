import { BaseNetworkController }  from "../base-network-controller.js";
import { PublisherService }       from "./publisher-service.js";
import { DiscoveryService }       from "./discovery-service.js";
import { MessageService, MessageCallbacks } from "./message-service.js";
import { WebsocketService }       from "../websocket-service.js";
import { PeerData, Peer }         from "../peer.js";
import { NETWORK_CONFIG }         from "../../utils/config.js";
import { logger }                 from "../../utils/logger.js";
import type { Team }              from "../../game/game-state.js";
import type { GameConfig }        from "../../game/voting-state.js";

export class LocalNetworkController extends BaseNetworkController {
    private publisher?:    PublisherService;
    private discoverer?:   DiscoveryService;
    private ghostInterval?: NodeJS.Timeout;

    constructor(
        private readonly serviceName: string,
        listener:   WebsocketService,
        identity:   { publicKey: string; privateKey: string },
        port:       number,
        protected readonly getTotalAlivePeersCount:   () => number,
        protected readonly getAllPeers:               () => Map<string, Peer>,
        private   readonly adjustAlivePeersCount:     (sign: '+' | '-', amount: number) => void,
        protected readonly acceptingConnectionStatus: () => boolean,
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

        this.ghostInterval = setInterval(() => {
            this.removeGhosts(
                this.getAllPeers(),
                (count) => this.adjustAlivePeersCount("-", count),
            );
        }, NETWORK_CONFIG.GHOST_TIMEOUT_MS / 10);
    }

    public stop(): void {
        this.publisher?.stop();
        this.discoverer?.stop();
        if (this.ghostInterval) {
            clearInterval(this.ghostInterval);
            this.ghostInterval = undefined;
        }
        this.stopBase();
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

    // ── Game coordination ─────────────────────────────────────────────────

    public broadcastReady(team: string): void {
        MessageService.SendReady(
            team,
            this.getAllPeers(),
            this.identity.publicKey,
            this.identity.privateKey,
        );
    }

    public broadcastUnready(): void {
        MessageService.SendUnready(
            this.getAllPeers(),
            this.identity.publicKey,
            this.identity.privateKey,
        );
    }

    public broadcastSideChoice(team: Team): void {
        MessageService.sendSideChoice(
            team,
            this.getAllPeers(),
            this.identity.publicKey,
            this.identity.privateKey,
        );
    }

    public sendSideChoiceToPeer(team: Team, peer: Peer): void {
        const single = new Map<string, Peer>([[peer.peerPublicNodeId, peer]]);
        MessageService.sendSideChoice(
            team,
            single,
            this.identity.publicKey,
            this.identity.privateKey,
        );
    }

    public broadcastConfigProposal(config: GameConfig, version: number): void {
        MessageService.SendConfigProposal(
            config, version,
            this.getAllPeers(),
            this.identity.publicKey,
            this.identity.privateKey,
        );
    }

    public sendConfigProposalToPeer(config: GameConfig, version: number, peer: Peer): void {
        MessageService.SendConfigProposalToPeer(
            config, version, peer,
            this.identity.publicKey,
            this.identity.privateKey,
        );
    }

    public broadcastConfigAccept(version: number): void {
        MessageService.SendConfigAccept(
            version,
            this.getAllPeers(),
            this.identity.publicKey,
            this.identity.privateKey,
        );
    }

    public broadcastVote(turnIndex: number, move: string, timestamp: number): void {
        MessageService.SendVote(
            turnIndex, move, timestamp,
            this.getAllPeers(),
            this.identity.publicKey,
            this.identity.privateKey,
        );
    }

    public broadcastResignVoteToTeam(team: Team): void {
        MessageService.SendResignVote(
            team,
            this.getAllPeers(),
            this.identity.publicKey,
            this.identity.privateKey,
        );
    }

    public broadcastDrawOffer(): void {
        MessageService.SendDrawOffer(
            this.getAllPeers(),
            this.identity.publicKey,
            this.identity.privateKey,
        );
    }

    public broadcastDrawResponse(accepted: boolean): void {
        MessageService.SendDrawResponse(
            accepted,
            this.getAllPeers(),
            this.identity.publicKey,
            this.identity.privateKey,
        );
    }

    // ── Time synchronisation ──────────────────────────────────────────────

    public sync(): boolean {
        logger.info(`Starting time synchronisation`);

        if (this.isTimeMaster()) {
            logger.info(`This node is the time master (lowest public key)`);
            return true;
        }

        logger.info(`This node is a time client — syncing with master`);
        return this.syncWithMaster();
    }

    private isTimeMaster(): boolean {
        const peers = this.getPeers();
        const myKey = this.identity.publicKey;

        if (peers.size === 0) {
            logger.info(`No peers — automatically time master`);
            return true;
        }

        let lowestKey = myKey;
        for (const [peerId] of peers) {
            if (peerId < lowestKey) lowestKey = peerId;
        }

        const isMaster = myKey === lowestKey;
        logger.debug(`Time master check`, {
            myKey:     myKey.slice(0, 8),
            lowestKey: lowestKey.slice(0, 8),
            isMaster,
        });
        return isMaster;
    }

    private syncWithMaster(): boolean {
        const masterPeer = this.findTimeMasterPeer();

        if (!masterPeer) {
            logger.error(`Cannot find time master peer`);
            return false;
        }

        logger.info(`Sending time-sync request to master`, {
            master: masterPeer.peerPublicNodeId.slice(0, 8),
        });

        const requestId = MessageService.SendTimeSyncRequest(
            masterPeer,
            this.identity.publicKey,
            this.identity.privateKey,
        );

        if (!requestId) {
            logger.error(`Failed to send time-sync request`);
            return false;
        }

        logger.info(`Time-sync request sent — awaiting response`);
        return true;
    }

    private findTimeMasterPeer(): Peer | null {
        const peers     = this.getPeers();
        let lowestKey   = this.identity.publicKey;
        let masterPeer: Peer | null = null;

        for (const [peerId, peer] of peers) {
            if (peerId < lowestKey) {
                lowestKey  = peerId;
                masterPeer = peer;
            }
        }
        return masterPeer;
    }
}
