// Zustand store — single source of truth for all React state.
// Populated on boot by useChessHive() and kept in sync by PUSH subscriptions.

import { create } from 'zustand';
import type {
    Team,
    GamePhase,
    GameSnapshot,
    GameResult,
    PeerSummary,
    RecordedMove,
    ConfigSnapshot,
} from './ipc-types';


export interface NodeIdentity {
    publicKey: string;
    team:      Team | null;
    phase:     GamePhase;
}


export interface GameState {
    phase:       GamePhase;
    gameId:      string;
    myTeam:      Team | null;
    currentTurn: Team;
    isMyTurn:    boolean;
    fen:         string;
    legalMoves:  string[];
    moveHistory: RecordedMove[];
    result:      GameResult | null;
    startsAt:    number | null;
    countdownMs: number | null;   // live countdown updated by a setInterval
}


export interface ConfigState {
    voteWindowMs:    number;
    maxRevotes:      number;
    resignThreshold: number;
    resignWindowMs:  number;
    version:         number;
    proposerKey:     string;
    selfAccepted:    boolean;
    peerAcceptedIds: string[];
}


export interface VotingState {
    turnIndex:     number;
    windowCloseAt: number;
    voteWindowMs:  number;
    isMyTurn:      boolean;
    myVote:        string | null;
    currentVotes:  Record<string, string>; // peerId → move
    revoteCount:   number;
}


export interface SideBalance {
    whites:     number;
    blacks:     number;
    waitingFor: Team;
}


export interface ResignVoteState {
    expiresAt:         number;   // epoch ms
    yesVotes:          number;
    connectedTeamSize: number;
    selfVoted:         boolean;
}


export interface AppNotification {
    type:    'error' | 'info' | 'warning';
    message: string;
}


export interface ChessHiveStore {


    /** Whether the IPC bridge has been hydrated at least once. */
    hydrated:     boolean;

    /** True once the node has been started (identity chosen / auto-loaded). */
    isAuthenticated: boolean;

    identity:     NodeIdentity | null;
    peers:        PeerSummary[];
    game:         GameState;
    config:       ConfigState;
    voting:       VotingState | null;
    resignVote:   ResignVoteState | null;
    sideBalance:  SideBalance | null;    // set when waiting for a side to fill
    notification: AppNotification | null;


    /** Mark the store as hydrated after the first IPC round-trip. */
    setHydrated(): void;

    /** Mark the node as started / user as authenticated. */
    setAuthenticated(v: boolean): void;

    /** Set or update the local node identity. */
    setIdentity(identity: NodeIdentity): void;

    /** Replace the full peer list. */
    setPeers(peers: PeerSummary[]): void;

    /** Add or update a single peer (used when peer:joined fires). */
    upsertPeer(peer: PeerSummary): void;

    /** Update a peer's team (used when peer:team_updated fires). */
    updatePeerTeam(peerId: string, team: Team | null): void;

    /** Update a peer's ready state (used when peer:ready_changed fires). */
    updatePeerReady(peerId: string, ready: boolean): void;

    /** Remove a peer by id (used when peer:left fires). */
    removePeer(peerId: string): void;

    /** Apply a full game snapshot (from getState or after a move). */
    applySnapshot(snapshot: GameSnapshot): void;

    /** Called when game:starting fires — sets countdown values. */
    setStarting(startsAt: number, countdownMs: number, myTeam: Team | null): void;

    /** Called every second during the countdown — decrements countdownMs. */
    tickCountdown(): void;

    /** Called when game:started fires — transitions to in_progress. */
    setStarted(gameId: string, myTeam: Team | null, fen: string, legalMoves: string[]): void;

    /** Called when game:move fires — updates board for opponent moves. */
    applyMove(
        move: string,
        moveIndex: number,
        senderTeam: Team,
        fen: string,
        legalMoves: string[],
        isMyTurn: boolean,
    ): void;

    /** Called when game:over fires. */
    setGameOver(gameId: string, result: GameResult, lastFen: string, moveCount: number): void;

    /** Called when waiting:for_side fires. */
    setSideBalance(balance: SideBalance | null): void;

    /** Show a notification banner. Pass null to clear. */
    setNotification(n: AppNotification | null): void;

    /** Reset game state for a rematch / new round. */
    resetGame(): void;

    // Config actions

    /** Hydrate config from NODE_GET_CONFIG response. */
    applyConfigSnapshot(snap: ConfigSnapshot): void;

    /** A new config was proposed (from peer or self). */
    setConfigUpdated(voteWindowMs: number, maxRevotes: number, resignThreshold: number, resignWindowMs: number, version: number, proposerKey: string): void;

    /** Mark self as having accepted the current config version. */
    setSelfAcceptedConfig(version: number): void;

    /** Mark a peer as having accepted the current config version. */
    addPeerAcceptedConfig(peerId: string): void;

    // Voting actions

    /** Open a new voting window. */
    openVotingWindow(turnIndex: number, windowCloseAt: number, voteWindowMs: number, isMyTurn: boolean): void;

    /** Record a vote from self or peer. */
    addVote(peerId: string, move: string, isSelf: boolean): void;

    /** Close the voting window (tally applied — board updated separately). */
    closeVotingWindow(): void;

    /** Update for a re-vote: reset votes, new window close time. */
    applyRevote(turnIndex: number, windowCloseAt: number, voteWindowMs: number, revoteCount: number): void;

    // Resign vote actions

    /** Called when resign:vote_started fires — self opened the vote window. */
    openResignVote(expiresAt: number, connectedTeamSize: number): void;

    /** Called when resign:vote_updated fires — tally changed. */
    updateResignVote(yesVotes: number, connectedTeamSize: number): void;

    /** Clear the resign vote state (expired or resolved). */
    closeResignVote(): void;
}


const defaultConfig: ConfigState = {
    voteWindowMs:    30_000,
    maxRevotes:      3,
    resignThreshold: 0.67,
    resignWindowMs:  60_000,
    version:         0,
    proposerKey:     '',
    selfAccepted:    true,
    peerAcceptedIds: [],
};

const defaultGame: GameState = {
    phase:       'waiting_for_side',
    gameId:      '',
    myTeam:      null,
    currentTurn: 'white',
    isMyTurn:    false,
    fen:         'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    legalMoves:  [],
    moveHistory: [],
    result:      null,
    startsAt:    null,
    countdownMs: null,
};


export const useStore = create<ChessHiveStore>((set) => ({

    hydrated:        false,
    isAuthenticated: false,
    identity:        null,
    peers:        [],
    game:         { ...defaultGame },
    config:       { ...defaultConfig },
    voting:       null,
    resignVote:   null,
    sideBalance:  null,
    notification: null,

    // Hydration

    setHydrated:      () => set({ hydrated: true }),
    setAuthenticated: (v) => set({ isAuthenticated: v }),

    // Identity

    setIdentity: (identity) => set({ identity }),

    // Peers

    setPeers: (peers) => set({ peers }),

    upsertPeer: (peer) =>
        set((s) => {
            const existing = s.peers.findIndex(p => p.peerId === peer.peerId);
            if (existing >= 0) {
                const updated = [...s.peers];
                // Preserve team if the incoming value is null — prevents peer:joined
                // (which always arrives with team: null) from wiping a team that was
                // already set by a prior peer:team_updated.
                updated[existing] = {
                    ...updated[existing],
                    ...peer,
                    team: peer.team ?? updated[existing].team,
                };
                return { peers: updated };
            }
            return { peers: [...s.peers, peer] };
        }),

    updatePeerTeam: (peerId, team) =>
        set((s) => {
            const idx = s.peers.findIndex(p => p.peerId === peerId);
            if (idx < 0) return {};
            const updated = [...s.peers];
            updated[idx] = { ...updated[idx], team };
            return { peers: updated };
        }),

    updatePeerReady: (peerId, ready) =>
        set((s) => {
            const idx = s.peers.findIndex(p => p.peerId === peerId);
            if (idx < 0) return {};
            const updated = [...s.peers];
            updated[idx] = { ...updated[idx], ready };
            return { peers: updated };
        }),

    removePeer: (peerId) =>
        set((s) => ({ peers: s.peers.filter(p => p.peerId !== peerId) })),

    // Game

    applySnapshot: (snap) =>
        set((s) => ({
            game: {
                ...s.game,
                phase:       snap.phase,
                gameId:      snap.gameId,
                myTeam:      snap.myTeam,
                currentTurn: snap.currentTurn,
                isMyTurn:    snap.isMyTurn,
                fen:         snap.fen,
                legalMoves:  snap.legalMoves,
                moveHistory: snap.moveHistory,
                result:      snap.result,
                startsAt:    snap.startsAt,
            },
            // Mirror identity team if it just got set
            identity: s.identity
                ? { ...s.identity, team: snap.myTeam, phase: snap.phase }
                : s.identity,
        })),

    setStarting: (startsAt, countdownMs, myTeam) =>
        set((s) => ({
            game: {
                ...s.game,
                phase:       'starting',
                startsAt,
                countdownMs,
                myTeam:      myTeam ?? s.game.myTeam,
            },
            sideBalance: null, // clear the "waiting for side" banner
        })),

    tickCountdown: () =>
        set((s) => ({
            game: {
                ...s.game,
                countdownMs: s.game.countdownMs !== null
                    ? Math.max(0, s.game.countdownMs - 1000)
                    : null,
            },
        })),

    setStarted: (gameId, myTeam, fen, legalMoves) =>
        set((s) => ({
            game: {
                ...s.game,
                phase:       'in_progress',
                gameId,
                myTeam:      myTeam ?? s.game.myTeam,
                fen,
                legalMoves,
                currentTurn: 'white',          // chess always starts white
                isMyTurn:    (myTeam ?? s.game.myTeam) === 'white',
                moveHistory: [],
                result:      null,
                startsAt:    null,
                countdownMs: null,
            },
        })),

    applyMove: (move, moveIndex, senderTeam, fen, legalMoves, isMyTurn) =>
        set((s) => {
            // Build a RecordedMove entry for the history panel.
            // We don't have fenBefore/senderKey here (push payload omits them
            // to keep it light) — use placeholders; the board renders from fen.
            const recorded: RecordedMove = {
                moveIndex,
                move,
                senderKey:  '',        // not provided in push payload
                fenBefore:  s.game.fen,
                fenAfter:   fen,
                timestamp:  Date.now(),
            };
            return {
                game: {
                    ...s.game,
                    fen,
                    legalMoves,
                    isMyTurn,
                    currentTurn: senderTeam === 'white' ? 'black' : 'white',
                    moveHistory: [...s.game.moveHistory, recorded],
                },
            };
        }),

    setGameOver: (gameId, result, lastFen, _moveCount) =>
        set((s) => ({
            game: {
                ...s.game,
                phase:      'finished',
                gameId,
                fen:        lastFen,
                result,
                isMyTurn:   false,
                legalMoves: [],
            },
        })),

    setSideBalance: (sideBalance) => set({ sideBalance }),

    // Notifications

    setNotification: (notification) => set({ notification }),

    // Reset

    resetGame: () =>
        set((s) => ({
            game:        { ...defaultGame },
            voting:      null,
            resignVote:  null,
            sideBalance: null,
            config:      { ...defaultConfig },
            identity: s.identity
                ? { ...s.identity, team: null, phase: 'waiting_for_side' }
                : null,
        })),

    // Config

    applyConfigSnapshot: (snap) =>
        set({
            config: {
                voteWindowMs:    snap.config.voteWindowMs,
                maxRevotes:      snap.config.maxRevotes,
                resignThreshold: snap.config.resignThreshold,
                resignWindowMs:  snap.config.resignWindowMs,
                version:         snap.version,
                proposerKey:     '',
                selfAccepted:    snap.selfAccepted,
                peerAcceptedIds: snap.peerAcceptedIds,
            },
        }),

    setConfigUpdated: (voteWindowMs, maxRevotes, resignThreshold, resignWindowMs, version, proposerKey) =>
        set((s) => ({
            config: {
                ...s.config,
                voteWindowMs,
                maxRevotes,
                resignThreshold,
                resignWindowMs,
                version,
                proposerKey,
                selfAccepted:    false,
                peerAcceptedIds: [proposerKey],
            },
        })),

    setSelfAcceptedConfig: (version) =>
        set((s) => {
            if (s.config.version !== version) return {};
            return { config: { ...s.config, selfAccepted: true } };
        }),

    addPeerAcceptedConfig: (peerId) =>
        set((s) => ({
            config: {
                ...s.config,
                peerAcceptedIds: s.config.peerAcceptedIds.includes(peerId)
                    ? s.config.peerAcceptedIds
                    : [...s.config.peerAcceptedIds, peerId],
            },
        })),

    // Voting

    openVotingWindow: (turnIndex, windowCloseAt, voteWindowMs, isMyTurn) =>
        set((s) => ({
            // Also sync game.isMyTurn so component guards stay consistent.
            game: { ...s.game, isMyTurn },
            voting: {
                turnIndex,
                windowCloseAt,
                voteWindowMs,
                isMyTurn,
                myVote:       null,
                currentVotes: {},
                revoteCount:  0,
            },
        })),

    addVote: (peerId, move, isSelf) =>
        set((s) => {
            if (!s.voting) return {};
            return {
                voting: {
                    ...s.voting,
                    myVote:       isSelf ? move : s.voting.myVote,
                    currentVotes: { ...s.voting.currentVotes, [peerId]: move },
                },
            };
        }),

    closeVotingWindow: () => set({ voting: null }),

    applyRevote: (turnIndex, windowCloseAt, voteWindowMs, revoteCount) =>
        set((s) => {
            if (!s.voting || s.voting.turnIndex !== turnIndex) return {};
            return {
                voting: {
                    ...s.voting,
                    windowCloseAt,
                    voteWindowMs,
                    revoteCount,
                    myVote:       null,
                    currentVotes: {},
                },
            };
        }),

    // Resign vote

    openResignVote: (expiresAt, connectedTeamSize) =>
        set({
            resignVote: { expiresAt, yesVotes: 1, connectedTeamSize, selfVoted: true },
        }),

    updateResignVote: (yesVotes, connectedTeamSize) =>
        set((s) => {
            if (!s.resignVote) return {};
            return { resignVote: { ...s.resignVote, yesVotes, connectedTeamSize } };
        }),

    closeResignVote: () => set({ resignVote: null }),

}));

// Stable selectors — use in components instead of inline arrow functions

export const selPhase      = (s: ChessHiveStore) => s.game.phase;
export const selIsMyTurn   = (s: ChessHiveStore) => s.game.isMyTurn;
export const selFen        = (s: ChessHiveStore) => s.game.fen;
export const selLegalMoves = (s: ChessHiveStore) => s.game.legalMoves;
export const selMyTeam     = (s: ChessHiveStore) => s.game.myTeam;
export const selPeers      = (s: ChessHiveStore) => s.peers;
export const selResult     = (s: ChessHiveStore) => s.game.result;
export const selHydrated   = (s: ChessHiveStore) => s.hydrated;
