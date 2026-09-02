import { VOTE_CONFIG } from '../utils/config.js';

export interface GameConfig {
    voteWindowMs:    number;
    maxRevotes:      number;
    resignThreshold: number;  // fraction (0–1) of connected team needed to trigger resign
    resignWindowMs:  number;  // how long a resign vote stays open before auto-expiring
}

export const DEFAULT_GAME_CONFIG: GameConfig = {
    voteWindowMs:    VOTE_CONFIG.DEFAULT_VOTE_WINDOW_MS,
    maxRevotes:      VOTE_CONFIG.DEFAULT_MAX_REVOTES,
    resignThreshold: VOTE_CONFIG.DEFAULT_RESIGN_THRESHOLD,
    resignWindowMs:  VOTE_CONFIG.DEFAULT_RESIGN_WINDOW_MS,
};

export type TallyResult =
    | { outcome: 'winner';     move: string; isTiebreak: boolean; voteCount: number; total: number }
    | { outcome: 'no_majority' }
    | { outcome: 'no_votes'   };

export class VotingState {
    private _votes:         Map<string, string> = new Map(); // publicKey → UCI move
    private _windowCloseAt: number;
    private _revoteCount:   number = 0;
    readonly turnIndex:     number;

    constructor(turnIndex: number, windowCloseAt: number) {
        this.turnIndex      = turnIndex;
        this._windowCloseAt = windowCloseAt;
    }

    get votes():         ReadonlyMap<string, string> { return this._votes; }
    get voteCount():     number { return this._votes.size; }
    get windowCloseAt(): number { return this._windowCloseAt; }
    get revoteCount():   number { return this._revoteCount; }

    castVote(publicKey: string, move: string, now: number): 'ok' | 'duplicate' | 'window_closed' {
        if (now > this._windowCloseAt + VOTE_CONFIG.VOTE_GRACE_MS) return 'window_closed';
        if (this._votes.has(publicKey)) return 'duplicate';
        this._votes.set(publicKey, move);
        return 'ok';
    }

    tally(): TallyResult {
        if (this._votes.size === 0) return { outcome: 'no_votes' };

        const counts = new Map<string, number>();
        for (const move of this._votes.values()) {
            counts.set(move, (counts.get(move) ?? 0) + 1);
        }

        const total    = this._votes.size;
        const maxCount = Math.max(...counts.values());
        const topMoves = [...counts.entries()]
            .filter(([, c]) => c === maxCount)
            .map(([m]) => m)
            .sort(); // lexicographic sort for deterministic tie-break

        // Clear majority (> 50% of voters)
        if (topMoves.length === 1 && maxCount * 2 > total) {
            return { outcome: 'winner', move: topMoves[0], isTiebreak: false, voteCount: maxCount, total };
        }

        // 2-way tie → lexicographically smaller move wins
        if (topMoves.length === 2) {
            return { outcome: 'winner', move: topMoves[0], isTiebreak: true, voteCount: maxCount, total };
        }

        // 3+ way split with no majority → re-vote
        return { outcome: 'no_majority' };
    }

    openRevote(newWindowCloseAt: number): void {
        this._revoteCount++;
        this._votes.clear();
        this._windowCloseAt = newWindowCloseAt;
    }
}
