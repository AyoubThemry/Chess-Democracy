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

/**
 * A vote exactly as its voter signed it. The master forwards these in its
 * tally_result so every node can check each vote itself.
 */
export interface SignedVote {
    payload: {
        key:       string;
        type:      'vote';
        turnIndex: number;
        round:     number;
        move:      string;
        timestamp: number;
        nonce:     string;
    };
    signature: string;
}

/**
 * The counting rule, shared by the master when it counts and by every node
 * when it recounts the master's votes.
 */
export function tallyMoves(moves: readonly string[]): TallyResult {
    if (moves.length === 0) return { outcome: 'no_votes' };

    const counts = new Map<string, number>();
    for (const move of moves) {
        counts.set(move, (counts.get(move) ?? 0) + 1);
    }

    const total    = moves.length;
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

export class VotingState {
    private _votes:         Map<string, string> = new Map(); // publicKey → UCI move
    private _signed:        Map<string, SignedVote> = new Map();
    private _windowCloseAt: number;
    private _revoteCount:   number = 0;
    readonly turnIndex:     number;

    /** `round` is non-zero only when catching up to a window already in a revote. */
    constructor(turnIndex: number, windowCloseAt: number, round = 0) {
        this.turnIndex      = turnIndex;
        this._windowCloseAt = windowCloseAt;
        this._revoteCount   = round;
    }

    get votes():         ReadonlyMap<string, string> { return this._votes; }
    get voteCount():     number { return this._votes.size; }
    get windowCloseAt(): number { return this._windowCloseAt; }
    get revoteCount():   number { return this._revoteCount; }
    /** Which attempt at this turn we're on. Votes carry it so a late vote can't land in the next round. */
    get round():         number { return this._revoteCount; }

    castVote(publicKey: string, move: string, now: number, signed?: SignedVote): 'ok' | 'duplicate' | 'window_closed' {
        if (now > this._windowCloseAt + VOTE_CONFIG.VOTE_GRACE_MS) return 'window_closed';
        if (this._votes.has(publicKey)) return 'duplicate';
        this._votes.set(publicKey, move);
        if (signed) this._signed.set(publicKey, signed);
        return 'ok';
    }

    /**
     * A vote handed over in a snapshot. It was cast in time on the peer that
     * sent it, so the window clock isn't checked; the caller has already
     * checked the signature and the voter.
     */
    addVerifiedVote(signed: SignedVote): 'ok' | 'duplicate' {
        const key = signed.payload.key;
        if (this._votes.has(key)) return 'duplicate';
        this._votes.set(key, signed.payload.move);
        this._signed.set(key, signed);
        return 'ok';
    }

    /** Our own vote is signed while it's broadcast, after it was already recorded. */
    attachSigned(publicKey: string, signed: SignedVote): void {
        if (this._votes.has(publicKey)) this._signed.set(publicKey, signed);
    }

    /** Every vote we can prove, sorted by voter so the list is the same on every node. */
    signedVotes(): SignedVote[] {
        return [...this._signed.entries()]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([, v]) => v);
    }

    tally(): TallyResult {
        return tallyMoves([...this._votes.values()]);
    }

    openRevote(newWindowCloseAt: number): void {
        this._revoteCount++;
        this._votes.clear();
        this._signed.clear();
        this._windowCloseAt = newWindowCloseAt;
    }
}
