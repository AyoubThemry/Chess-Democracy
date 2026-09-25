import { verifySignature } from '../protocol/verifysignsignature.js';
import { tallyMoves, TallyResult, SignedVote } from './voting-state.js';
import type { Team } from './game-state.js';

/** What the master publishes when a vote window closes. */
export interface TallyClaim {
    turnIndex: number;
    round:     number;
    fenBefore: string;
    outcome:   TallyResult['outcome'];
    move:      string | null;
    votes:     SignedVote[];
}

/** What the checking node knows about the game right now. */
export interface TallyContext {
    turnIndex:  number;
    round:      number;
    fen:        string;
    sideToMove: Team;
    legalMoves: readonly string[];
    teamOf:     (publicKey: string) => Team | null;
}

export type TallyVerdict =
    | { ok: true;  result: TallyResult }
    | { ok: false; reason: string };

/**
 * Checks a master's tally without trusting the master.
 *
 * Every vote has to carry its voter's own signature, belong to this turn and
 * round, come from the side to move, be legal, and appear once per voter.
 * Then the votes are counted again with the same rule, and the outcome has to
 * match what the master claimed.
 *
 * What this can't catch is a master that leaves a valid vote out. A vote that
 * arrived too late and one that was quietly dropped look the same from here.
 */
export function verifyTally(claim: TallyClaim, ctx: TallyContext): TallyVerdict {
    if (claim.turnIndex !== ctx.turnIndex || claim.round !== ctx.round) return fail('wrong_turn');
    if (claim.fenBefore !== ctx.fen)                                     return fail('position_differs');
    if (!Array.isArray(claim.votes))                                     return fail('no_vote_list');

    const voters = new Set<string>();
    const moves: string[] = [];

    for (const vote of claim.votes) {
        const p = vote?.payload;
        if (!p || p.type !== 'vote' || typeof p.key !== 'string' || typeof vote.signature !== 'string') {
            return fail('malformed_vote');
        }
        if (!verifySignature(JSON.stringify(p), vote.signature, p.key)) return fail('bad_vote_signature');
        if (p.turnIndex !== ctx.turnIndex || p.round !== ctx.round)     return fail('vote_from_another_round');
        if (ctx.teamOf(p.key) !== ctx.sideToMove)                        return fail('voter_not_on_side_to_move');
        if (!ctx.legalMoves.includes(p.move))                            return fail('illegal_move');
        if (voters.has(p.key))                                           return fail('duplicate_voter');

        voters.add(p.key);
        moves.push(p.move);
    }

    const recount = tallyMoves(moves);
    if (recount.outcome !== claim.outcome)                               return fail('outcome_differs');
    if (recount.outcome === 'winner' && recount.move !== claim.move)     return fail('move_differs');

    return { ok: true, result: recount };
}

function fail(reason: string): TallyVerdict {
    return { ok: false, reason };
}
