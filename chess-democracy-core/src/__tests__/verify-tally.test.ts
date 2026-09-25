import { describe, it, expect } from 'vitest';
import { randomUUID } from 'crypto';
import { verifyTally, type TallyClaim, type TallyContext } from '../game/verify-tally.js';
import type { SignedVote } from '../game/voting-state.js';
import { getOrCreateIdentity } from '../protocol/generateidentity.js';
import { signMessage } from '../protocol/verifysignsignature.js';

// Real keys and real signatures throughout: the point of verifyTally is that
// it doesn't have to trust anyone, so nothing here is mocked.

const alice = getOrCreateIdentity();   // white
const bob   = getOrCreateIdentity();   // white
const carol = getOrCreateIdentity();   // white
const dave  = getOrCreateIdentity();   // black

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const teams = new Map<string, 'white' | 'black'>([
    [alice.publicKey, 'white'],
    [bob.publicKey,   'white'],
    [carol.publicKey, 'white'],
    [dave.publicKey,  'black'],
]);

const ctx: TallyContext = {
    turnIndex:  0,
    round:      0,
    fen:        START,
    sideToMove: 'white',
    legalMoves: ['e2e4', 'd2d4', 'g1f3'],
    teamOf:     key => teams.get(key) ?? null,
};

type Identity = { publicKey: string; privateKey: string };

function vote(
    by: Identity,
    move: string,
    { turnIndex = 0, round = 0, key = by.publicKey }: { turnIndex?: number; round?: number; key?: string } = {},
): SignedVote {
    const payload = { key, type: 'vote' as const, turnIndex, round, move, timestamp: Date.now(), nonce: randomUUID() };
    return { payload, signature: signMessage(JSON.stringify(payload), by.privateKey) };
}

function claim(
    votes: SignedVote[],
    outcome: TallyClaim['outcome'],
    move: string | null,
    overrides: Partial<TallyClaim> = {},
): TallyClaim {
    return { turnIndex: 0, round: 0, fenBefore: START, outcome, move, votes, ...overrides };
}

const reason = (c: TallyClaim) => {
    const v = verifyTally(c, ctx);
    return v.ok ? 'ok' : v.reason;
};

describe('verifyTally accepts an honest master', () => {
    it('majority', () => {
        const v = verifyTally(claim([vote(alice, 'e2e4'), vote(bob, 'e2e4'), vote(carol, 'd2d4')], 'winner', 'e2e4'), ctx);
        expect(v.ok && v.result.outcome === 'winner' && v.result.move).toBe('e2e4');
    });

    it('two-way tie goes to the lexicographically smaller move', () => {
        expect(reason(claim([vote(alice, 'e2e4'), vote(bob, 'd2d4')], 'winner', 'd2d4'))).toBe('ok');
    });

    it('three-way split is no majority', () => {
        expect(reason(claim([vote(alice, 'e2e4'), vote(bob, 'd2d4'), vote(carol, 'g1f3')], 'no_majority', null))).toBe('ok');
    });

    it('nobody voted', () => {
        expect(reason(claim([], 'no_votes', null))).toBe('ok');
    });
});

describe('verifyTally catches a master that miscounts', () => {
    it('announces the losing move', () => {
        expect(reason(claim([vote(alice, 'e2e4'), vote(bob, 'e2e4'), vote(carol, 'd2d4')], 'winner', 'd2d4')))
            .toBe('move_differs');
    });

    it('announces the wrong side of a tie', () => {
        expect(reason(claim([vote(alice, 'e2e4'), vote(bob, 'd2d4')], 'winner', 'e2e4'))).toBe('move_differs');
    });

    it('announces a winner when there was none', () => {
        expect(reason(claim([vote(alice, 'e2e4'), vote(bob, 'd2d4'), vote(carol, 'g1f3')], 'winner', 'e2e4')))
            .toBe('outcome_differs');
    });
});

describe('verifyTally catches votes the master could not have received', () => {
    it('a vote edited after it was signed', () => {
        const edited = vote(alice, 'e2e4');
        edited.payload.move = 'd2d4';
        expect(reason(claim([edited], 'winner', 'd2d4'))).toBe('bad_vote_signature');
    });

    it('a vote signed by one player but attributed to another', () => {
        expect(reason(claim([vote(alice, 'e2e4', { key: bob.publicKey })], 'winner', 'e2e4'))).toBe('bad_vote_signature');
    });

    it('the same voter counted twice', () => {
        expect(reason(claim([vote(alice, 'e2e4'), vote(alice, 'e2e4')], 'winner', 'e2e4'))).toBe('duplicate_voter');
    });

    it('a vote from the side not to move', () => {
        expect(reason(claim([vote(dave, 'e2e4')], 'winner', 'e2e4'))).toBe('voter_not_on_side_to_move');
    });

    it('an illegal move', () => {
        expect(reason(claim([vote(alice, 'e2e5')], 'winner', 'e2e5'))).toBe('illegal_move');
    });

    it('a vote from an earlier round of this turn', () => {
        expect(reason(claim([vote(alice, 'e2e4', { round: 1 })], 'winner', 'e2e4'))).toBe('vote_from_another_round');
    });
});

describe('verifyTally notices when we are not in the same game', () => {
    it('the result is for a different turn', () => {
        expect(reason(claim([], 'no_votes', null, { turnIndex: 1 }))).toBe('wrong_turn');
    });

    it('the master counted from a different position', () => {
        expect(reason(claim([], 'no_votes', null, { fenBefore: 'something-else' }))).toBe('position_differs');
    });
});
