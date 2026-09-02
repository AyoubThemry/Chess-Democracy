/**
 * ipc-types.ts
 *
 * Local copy of the shared types React needs from the IPC contract.
 * These are TYPE-ONLY — zero runtime code, zero bundle impact.
 *
 * WHY THIS FILE EXISTS:
 * The canonical source of truth is chess-democracy-electron/src/ipc-channels.ts
 * React components cannot import across the Vite project boundary at dev-time
 * (Vite's dev server only serves files under ReactChessDemocracy/).
 * This file mirrors only the types that React components use directly.
 *
 * KEEP IN SYNC WITH: chess-democracy-electron/src/ipc-channels.ts
 * If you add a new type to ipc-channels.ts that React needs, add it here too.
 */

export interface GameConfig {
    voteWindowMs:    number;
    maxRevotes:      number;
    resignThreshold: number;
    resignWindowMs:  number;
}

export interface ConfigSnapshot {
    config:          GameConfig;
    version:         number;
    selfAccepted:    boolean;
    peerAcceptedIds: string[];
}

export type Team      = 'white' | 'black';

export type GamePhase =
    | 'waiting_for_side'
    | 'waiting_for_ready'
    | 'waiting_for_peers'
    | 'starting'
    | 'in_progress'
    | 'finished';

export interface GameResult {
    winner: Team | 'draw' | null;
    reason: 'checkmate' | 'stalemate' | 'resignation' | 'disconnect' | 'draw_agreement' | 'revotes_exhausted' | 'timeout';
}

export interface RecordedMove {
    moveIndex:  number;
    move:       string;
    senderKey:  string;
    fenBefore:  string;
    fenAfter:   string;
    timestamp:  number;
}

export interface PeerSummary {
    peerId:  string;
    team:    Team | null;
    ready:   boolean;
    status:  'alive' | 'dead';
}

export interface GameSnapshot {
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
}

export type IpcResult<T = void> =
    | { ok: true;  value: T }
    | { ok: false; error: string };
