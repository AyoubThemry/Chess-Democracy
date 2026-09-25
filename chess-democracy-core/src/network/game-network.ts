import type { EventEmitter } from 'events';
import type { Peer, PeerData } from './peer.js';
import type { Team } from '../game/game-state.js';
import type { GameConfig, SignedVote } from '../game/voting-state.js';
import type { TallyClaim } from '../game/verify-tally.js';
import type { MessageCallbacks } from './localnetwork/message-service.js';

/**
 * What Node needs from a transport. The LAN version is LocalNetworkController
 * (WebSockets + mDNS). A global version implements this same interface, and
 * Node's game logic doesn't change.
 *
 * Events a GameNetwork must emit:
 *   'peer:connected'    (peer: Peer)  a peer finished its handshake
 *   'peer:disconnected' (peer: Peer)  its connection closed
 *
 * Inbound messages go to the MessageCallbacks it was created with.
 */
export interface GameNetwork extends EventEmitter {
    start(): void;
    stop(): void;

    /** Ask the master for its clock. Returns false if there's nobody to ask. */
    sync(): boolean;

    broadcastReady(team: string): void;
    broadcastUnready(): void;
    broadcastSideChoice(team: Team): void;
    sendSideChoiceToPeer(team: Team, peer: Peer): void;
    broadcastConfigProposal(config: GameConfig, version: number): void;
    sendConfigProposalToPeer(config: GameConfig, version: number, peer: Peer): void;
    broadcastConfigAccept(version: number): void;
    /** Returns the vote as signed, so the master can forward it in its tally. */
    broadcastVote(turnIndex: number, round: number, move: string, timestamp: number): SignedVote;
    broadcastTallyResult(claim: TallyClaim): void;
    broadcastResignVoteToTeam(team: Team): void;
    broadcastDrawOffer(): void;
    broadcastDrawResponse(accepted: boolean): void;

    /** Connect straight to a known peer, skipping discovery. Tests use it. */
    connectTo?(peerData: PeerData): Promise<void>;
}

/** What Node hands a transport so it can read peers and deliver messages. */
export interface NetworkContext {
    identity:              { publicKey: string; privateKey: string };
    callbacks:             MessageCallbacks;
    getAllPeers:           () => Map<string, Peer>;
    getAlivePeersCount:    () => number;
    adjustAlivePeersCount: (sign: '+' | '-', amount: number) => void;
    acceptingConnection:   () => boolean;
}

/**
 * Builds a transport and gets it listening. Resolves once it's reachable,
 * with the port it's on (0 if the transport has no port of its own).
 * Node calls start() on the result.
 */
export type NetworkFactory = (
    ctx: NetworkContext,
    requestedPort: number,
) => Promise<{ network: GameNetwork; boundPort: number }>;
