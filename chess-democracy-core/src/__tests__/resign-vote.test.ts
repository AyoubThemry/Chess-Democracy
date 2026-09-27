import { describe, it, expect, vi, afterEach } from 'vitest';
import { ResignVote } from '../core/resign-vote.js';

describe('ResignVote', () => {
    afterEach(() => vi.useRealTimers());

    it('counts each player once', () => {
        const vote = new ResignVote(60_000, () => {});
        expect(vote.add('a')).toBe(true);
        expect(vote.add('a')).toBe(false);
        expect(vote.yesVotes).toBe(1);
        expect(vote.hasVoted('a')).toBe(true);
        vote.cancel();
    });

    it('passes once enough of the connected team agrees', () => {
        const vote = new ResignVote(60_000, () => {});
        vote.add('a');
        vote.add('b');
        expect(vote.passes(3, 0.67)).toBe(false);   // 2/3 is just under 67%
        expect(vote.passes(3, 0.66)).toBe(true);
        expect(vote.passes(0, 0.5)).toBe(false);    // nobody connected: never passes
        vote.cancel();
    });

    it('expires after its window unless cancelled', () => {
        vi.useFakeTimers();
        const expired = vi.fn();
        new ResignVote(60_000, expired);
        const cancelled = new ResignVote(60_000, expired);
        cancelled.cancel();

        vi.advanceTimersByTime(60_000);
        expect(expired).toHaveBeenCalledOnce();
    });
});
