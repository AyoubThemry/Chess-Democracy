import type { SignedVote } from './voting-state.js';

/**
 * Where a game stands, sent to a player who has just reconnected so whoever
 * is behind can catch up: every move so far, plus the vote window that's open
 * and the votes already cast in it.
 */
export interface GameSnapshot {
    gameId:        string;
    moves:         string[];
    round:         number;
    windowCloseAt: number;
    votes:         SignedVote[];
}
