import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Node } from '../core/node.js';
import { VotingState, type SignedVote } from '../game/voting-state.js';
import type { MessageCallbacks } from '../network/localnetwork/message-service.js';
import { bootNode, addPeer } from './helpers/fake-network.js';
import { randomUUID } from 'crypto';
import { getOrCreateIdentity } from '../protocol/generateidentity.js';
import { signMessage } from '../protocol/verifysignsignature.js';
import { verifyTally, type TallyClaim } from '../game/verify-tally.js';

// These tests are about who may vote, not about forwarding, so the signed
// copy of the vote is a placeholder here. verify-tally.test.ts uses real ones.
const SIGNED = {} as SignedVote;

describe('Node rejects messages from peers who may not send them', () => {
    let node: Node;
    let cb: MessageCallbacks;

    beforeEach(async () => {
        ({ node, cb } = await bootNode());

        // White to move, turn 0, vote window open for 30s.
        node.setTeam('white');
        node.gameState.beginCountdown('game-1', Date.now());
        node.gameState.begin();
        (node as unknown as { _voting: VotingState })._voting =
            new VotingState(0, Date.now() + 30_000);

        addPeer(node, 'white-teammate', 'white');
        addPeer(node, 'black-opponent', 'black');
    });

    afterEach(() => node.stop());

    const votes = () => node.activeVoting!.votes;

    it('records a legal vote from the side to move', () => {
        cb.onVote('white-teammate', 0, 0, 'e2e4', Date.now(), SIGNED);
        expect(votes().get('white-teammate')).toBe('e2e4');
    });

    it('ignores a vote from the side not to move (#20)', () => {
        cb.onVote('black-opponent', 0, 0, 'e2e4', Date.now(), SIGNED);
        expect(votes().has('black-opponent')).toBe(false);
    });

    it('ignores a vote from a sender it has no peer record for', () => {
        cb.onVote('stranger', 0, 0, 'e2e4', Date.now(), SIGNED);
        expect(votes().size).toBe(0);
    });

    it('ignores a vote meant for an earlier round of the same turn', () => {
        node.activeVoting!.openRevote(Date.now() + 30_000);   // now round 1
        cb.onVote('white-teammate', 0, 0, 'e2e4', Date.now(), SIGNED);
        expect(votes().size).toBe(0);
    });

    it('ignores an illegal move so it cannot win the tally (#21)', () => {
        cb.onVote('white-teammate', 0, 0, 'e2e5', Date.now(), SIGNED);
        expect(votes().size).toBe(0);
    });

    it('ignores a resign vote from the opposing side (#22)', () => {
        const started = vi.fn();
        node.on('resign:vote_started', started);

        cb.onResignVote('black-opponent');

        expect(started).not.toHaveBeenCalled();
        expect((node as unknown as { _resignVote: unknown })._resignVote).toBeNull();
    });

    it('opens the resign vote for a teammate', () => {
        const started = vi.fn();
        node.on('resign:vote_started', started);

        cb.onResignVote('white-teammate');

        expect(started).toHaveBeenCalledOnce();
    });

    // ── game_over (#23) ──────────────────────────────────────────────────

    const gameOver = (sender: string, gameId: string, winner: unknown, reason: string) =>
        cb.onGameOver({ type: 'game_over', gameId, result: { winner, reason } as never }, sender);

    const phase = () => node.gameState.phase;

    it('ignores a game_over for a different game', () => {
        gameOver('black-opponent', 'some-other-game', 'white', 'resignation');
        expect(phase()).toBe('in_progress');
    });

    it('ignores a claimed checkmate, since every node detects those itself', () => {
        gameOver('black-opponent', 'game-1', 'black', 'checkmate');
        expect(phase()).toBe('in_progress');
    });

    it('ignores a resignation sent on behalf of the other side', () => {
        // black claims white resigned, i.e. black wins
        gameOver('black-opponent', 'game-1', 'black', 'resignation');
        expect(phase()).toBe('in_progress');
    });

    it('accepts a side resigning for itself', () => {
        gameOver('black-opponent', 'game-1', 'white', 'resignation');
        expect(phase()).toBe('finished');
        expect(node.gameState.result).toEqual({ winner: 'white', reason: 'resignation' });
    });

    it('ignores a timeout claimed long before the turn could have timed out', () => {
        (node as unknown as { _moveTimeoutStartedAt: number })._moveTimeoutStartedAt = Date.now();
        gameOver('black-opponent', 'game-1', null, 'timeout');
        expect(phase()).toBe('in_progress');
    });

    it('accepts a timeout once the turn has really run out', () => {
        (node as unknown as { _moveTimeoutStartedAt: number })._moveTimeoutStartedAt = Date.now() - 121_000;
        gameOver('black-opponent', 'game-1', null, 'timeout');
        expect(phase()).toBe('finished');
    });

    it('accepts an agreed draw', () => {
        gameOver('black-opponent', 'game-1', 'draw', 'draw_agreement');
        expect(phase()).toBe('finished');
    });
});

describe('Node accepts game_start only from the master (#25)', () => {
    let node: Node;
    let cb: MessageCallbacks;

    // Sort order decides the master: the all-zero key is lowest, so it's the
    // master. The second key is lower than ours but isn't the lowest.
    const MASTER = '0'.repeat(64);
    const MIDDLE = '0'.repeat(63) + '1';

    const start = { type: 'game_start', gameId: 'the-real-game', startsAt: Date.now() + 60_000 };

    beforeEach(async () => {
        ({ node, cb } = await bootNode());

        node.setTeam('white');
        addPeer(node, MASTER, 'black');
        addPeer(node, MIDDLE, 'white');
    });

    afterEach(() => node.stop());

    it('ignores game_start from a lower key that is not the lowest', () => {
        node.gameState.beginCountdown('', Date.now() + 60_000);
        cb.onGameStart({ ...start, gameId: 'wrong-game' }, MIDDLE);
        expect(node.gameState.gameId).toBe('');
    });

    it('adopts the master game_start while counting down', () => {
        node.gameState.beginCountdown('', Date.now() + 60_000);
        cb.onGameStart(start, MASTER);
        expect(node.gameState.gameId).toBe('the-real-game');
    });

    it('adopts it even if our own ready check has not fired yet', () => {
        node.gameState.setWaitingForPeers();
        cb.onGameStart(start, MASTER);
        expect(node.gameState.phase).toBe('starting');
        expect(node.gameState.gameId).toBe('the-real-game');
    });
});

describe('Node applies only a tally it can verify (#24)', () => {
    let node: Node;
    let cb: MessageCallbacks;

    // Real keys: the node checks every vote's signature.
    const master   = getOrCreateIdentity();   // black, and the master
    const teammate = getOrCreateIdentity();   // white

    function signedVote(by: { publicKey: string; privateKey: string }, move: string): SignedVote {
        const payload = {
            key: by.publicKey, type: 'vote' as const, turnIndex: 0, round: 0,
            move, timestamp: Date.now(), nonce: randomUUID(),
        };
        return { payload, signature: signMessage(JSON.stringify(payload), by.privateKey) };
    }

    const claim = (votes: SignedVote[], outcome: TallyClaim['outcome'], move: string | null): TallyClaim => ({
        turnIndex: 0, round: 0, fenBefore: node.gameState.fen, outcome, move, votes,
    });

    beforeEach(async () => {
        ({ node, cb } = await bootNode());

        node.setTeam('white');
        node.gameState.beginCountdown('game-1', Date.now());
        node.gameState.begin();
        (node as unknown as { _voting: VotingState })._voting = new VotingState(0, Date.now() + 30_000);

        addPeer(node, master.publicKey,   'black');
        addPeer(node, teammate.publicKey, 'white');
    });

    afterEach(() => node.stop());

    /** Which key counts as master normally depends on sort order; pin it for the test. */
    const makeMaster = (key: string) =>
        vi.spyOn(node as unknown as { masterKey(): string }, 'masterKey').mockReturnValue(key);

    it('applies an honest result from the master', () => {
        makeMaster(master.publicKey);
        const done = vi.fn();
        node.on('tally:done', done);

        cb.onTallyResult(master.publicKey, claim([signedVote(teammate, 'e2e4')], 'winner', 'e2e4'));

        expect(done).toHaveBeenCalledWith(expect.objectContaining({ move: 'e2e4' }));
        expect(node.gameState.moveHistory).toHaveLength(1);
    });

    it('stops the game, instead of desyncing, when the master miscounts', () => {
        makeMaster(master.publicKey);
        // one vote for e2e4, but the master announces d2d4
        cb.onTallyResult(master.publicKey, claim([signedVote(teammate, 'e2e4')], 'winner', 'd2d4'));

        expect(node.gameState.phase).toBe('finished');
        expect(node.gameState.result?.reason).toBe('desync');
        expect(node.gameState.moveHistory).toHaveLength(0);
    });

    it('ignores a result from a peer that is not the master', () => {
        makeMaster(master.publicKey);
        cb.onTallyResult(teammate.publicKey, claim([signedVote(teammate, 'e2e4')], 'winner', 'e2e4'));

        expect(node.gameState.phase).toBe('in_progress');
        expect(node.gameState.moveHistory).toHaveLength(0);
    });

    it('as master, publishes a result that other nodes accept', () => {
        makeMaster(node.identity.publicKey);
        cb.onVote(teammate.publicKey, 0, 0, 'e2e4', Date.now(), signedVote(teammate, 'e2e4'));

        const fenBefore = node.gameState.fen;
        (node as unknown as { onTallyDue(): void }).onTallyDue();

        const publish = (node.network as unknown as { broadcastTallyResult: ReturnType<typeof vi.fn> }).broadcastTallyResult;
        expect(publish).toHaveBeenCalledOnce();
        const published = publish.mock.calls[0][0] as TallyClaim;

        // Check it the way any other node would.
        const verdict = verifyTally(published, {
            turnIndex: 0, round: 0, fen: fenBefore, sideToMove: 'white',
            legalMoves: ['e2e4', 'd2d4'],
            teamOf: key => (key === teammate.publicKey ? 'white' : null),
        });
        expect(verdict.ok).toBe(true);
        // and applied it locally too
        expect(node.gameState.moveHistory[0].move).toBe('e2e4');
    });
});
