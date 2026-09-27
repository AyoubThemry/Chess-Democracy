import type { EventEmitter } from 'events';
import type { Peer, PeerData } from './peer.js';
import type { Team, GameResult } from '../game/game-state.js';
import type { GameConfig, SignedVote } from '../game/voting-state.js';
import type { TallyClaim } from '../game/verify-tally.js';
import type { GameSnapshot } from '../game/snapshot.js';
import type { MessageCallbacks } from './message-service.js';

/**
 * What Node needs from a transport. The LAN version is LocalNetworkController
 * (WebSockets + mDNS). A global version implements this same interface, and
 * Node's game logic doesn't change.
 *
 * Events a GameNetwork must emit:
 *   'peer:connected'    (peer: Peer)  a peer finished its handshake
 *   'peer:disconnected' (peer: Peer)  its connection closed
 *
 * And may emit, where it means something for that network:
 *   'reach' (reach: RoomReach)  players found versus players reached. Only
 *                               over the internet, where one can be found
 *                               but not reachable.
 *
 * Inbound messages go to the MessageCallbacks it was created with.
 */
export interface GameNetwork extends EventEmitter {
    start(): void;
    stop(): void;

    /** Ask the master for its clock. Returns false if there's nobody to ask. */
    sync(): boolean;

    broadcastGameStart(gameId: string, resolvedTeam: Team, startsAt: number, totalPlayers: number): void;
    broadcastGameOver(gameId: string, result: GameResult, lastFen: string, moveCount: number): void;
    broadcastReady(team: Team): void;
    broadcastUnready(): void;
    broadcastSideChoice(team: Team): void;
    sendSideChoiceToPeer(team: Team, peer: Peer): void;
    broadcastConfigProposal(config: GameConfig, version: number): void;
    sendConfigProposalToPeer(config: GameConfig, version: number, peer: Peer): void;
    broadcastConfigAccept(version: number): void;
    /** Returns the vote as signed, so the master can forward it in its tally. */
    broadcastVote(turnIndex: number, round: number, move: string, timestamp: number): SignedVote;
    broadcastTallyResult(claim: TallyClaim): void;
    /** Where the game stands, for a player who just reconnected. */
    sendGameSnapshotToPeer(snapshot: GameSnapshot, peer: Peer): void;
    broadcastResignVoteToTeam(team: Team): void;
    broadcastDrawOffer(): void;
    broadcastDrawResponse(accepted: boolean): void;

    /** Connect straight to a known peer, skipping discovery. Tests use it. */
    connectTo?(peerData: PeerData): Promise<void>;
}

/** What Node hands a transport so it can read peers and deliver messages. */
/** Players found in the room, and how many of them we're actually connected to. */
export interface RoomReach {
    found:     number;
    connected: number;
    /** Someone was found but hasn't been reached for a while. */
    stuck:     boolean;
}

export interface NetworkContext {
    identity:              { publicKey: string; privateKey: string };
    callbacks:             MessageCallbacks;
    getAllPeers:           () => Map<string, Peer>;
    getAlivePeersCount:    () => number;
    /** No key: could anyone connect right now? With a key: may this peer? */
    acceptingConnection:   (peerKey?: string) => boolean;
    /** Where the game stands, for a public listing. */
    summary:               () => GameSummary;
}

export interface GameSummary {
    /** Still in the lobby, so others can join. */
    open:    boolean;
    players: number;
    whites:  number;
    blacks:  number;
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
