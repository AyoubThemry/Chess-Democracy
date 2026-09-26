import { EventEmitter }     from 'events';
import { randomUUID }       from 'crypto';
import { MessageService }   from './message-service.js';
import type { Peer }        from './peer.js';
import type { Team }        from '../game/game-state.js';
import type { GameConfig, SignedVote } from '../game/voting-state.js';
import type { TallyClaim }  from '../game/verify-tally.js';
import type { GameSnapshot } from '../game/snapshot.js';
import { logger }           from '../utils/logger.js';

/**
 * Everything a transport sends, written once for every transport.
 *
 * None of this depends on how peers are connected: it signs a message and
 * hands it to each peer's PeerConnection. A transport only has to provide its
 * identity and its peers, and deal with connecting.
 */
export abstract class PeerMessaging extends EventEmitter {
    protected abstract readonly identity:    { publicKey: string; privateKey: string };
    protected abstract readonly getAllPeers: () => Map<string, Peer>;

    // ── Game coordination ─────────────────────────────────────────────────

    public broadcastReady(team: string): void {
        MessageService.broadcast(
            { type: 'ready', team },
            this.getAllPeers(),
            this.identity,
        );
    }

    public broadcastUnready(): void {
        MessageService.broadcast(
            { type: 'unready' },
            this.getAllPeers(),
            this.identity,
        );
    }

    public broadcastSideChoice(team: Team): void {
        MessageService.broadcast(
            { type: 'side_choice', team, request_id: randomUUID(), client_time: Date.now() },
            this.getAllPeers(),
            this.identity,
        );
    }

    public sendSideChoiceToPeer(team: Team, peer: Peer): void {
        MessageService.broadcast(
            { type: 'side_choice', team, request_id: randomUUID(), client_time: Date.now() },
            this.getAllPeers(),
            this.identity,
            p => p.peerPublicNodeId === peer.peerPublicNodeId,
        );
    }

    public broadcastConfigProposal(config: GameConfig, version: number): void {
        MessageService.broadcast(
            { type: 'config_proposal', config, version },
            this.getAllPeers(),
            this.identity,
        );
    }

    public sendConfigProposalToPeer(config: GameConfig, version: number, peer: Peer): void {
        MessageService.broadcast(
            { type: 'config_proposal', config, version },
            this.getAllPeers(),
            this.identity,
            p => p.peerPublicNodeId === peer.peerPublicNodeId,
        );
    }

    public broadcastConfigAccept(version: number): void {
        MessageService.broadcast(
            { type: 'config_accept', version },
            this.getAllPeers(),
            this.identity,
        );
    }

    /** Returns the vote as signed, so the master can forward it in its tally. */
    public broadcastVote(turnIndex: number, round: number, move: string, timestamp: number): SignedVote {
        return MessageService.broadcast(
            { type: 'vote', turnIndex, round, move, timestamp },
            this.getAllPeers(),
            this.identity,
        ) as unknown as SignedVote;
    }

    public sendGameSnapshotToPeer(snapshot: GameSnapshot, peer: Peer): void {
        MessageService.broadcast(
            { type: 'game_snapshot', ...snapshot },
            this.getAllPeers(),
            this.identity,
            p => p.peerPublicNodeId === peer.peerPublicNodeId,
        );
    }

    public broadcastTallyResult(claim: TallyClaim): void {
        MessageService.broadcast(
            { type: 'tally_result', ...claim },
            this.getAllPeers(),
            this.identity,
        );
    }

    public broadcastResignVoteToTeam(team: Team): void {
        MessageService.broadcast(
            { type: 'resign_vote' },
            this.getAllPeers(),
            this.identity,
            p => p.team === team,
        );
    }

    public broadcastDrawOffer(): void {
        MessageService.broadcast(
            { type: 'draw_offer' },
            this.getAllPeers(),
            this.identity,
        );
    }

    public broadcastDrawResponse(accepted: boolean): void {
        MessageService.broadcast(
            { type: 'draw_response', accepted },
            this.getAllPeers(),
            this.identity,
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
        const peers = this.getAllPeers();
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
        const peers     = this.getAllPeers();
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
