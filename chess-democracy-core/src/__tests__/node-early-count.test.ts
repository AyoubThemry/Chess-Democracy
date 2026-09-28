import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Node } from '../core/node.js';
import { VotingState, type SignedVote } from '../game/voting-state.js';
import type { MessageCallbacks } from '../network/message-service.js';
import type { GameNetwork } from '../network/game-network.js';
import type { Peer } from '../network/peer.js';
import { bootNode, addPeer } from './helpers/fake-network.js';

// Signatures aren't checked on this path: the master counts the votes it
// recorded. Only the move has to be there.
const signed = (key: string, move: string) =>
    ({ payload: { key, type: 'vote', turnIndex: 0, round: 0, move, timestamp: 0, nonce: key }, signature: '' }) as SignedVote;

// Hex public keys sort between these, so the prefix picks who is master.
const AFTER_US = 'zz-';
const BEFORE_US = '00-';

describe('Node counting early', () => {
    let node: Node;
    let cb: MessageCallbacks;
    let net: GameNetwork;
    const WINDOW = 30_000;

    async function setUp(prefix: string) {
        ({ node, cb, net } = await bootNode());
        vi.mocked(net.broadcastVote).mockImplementation((_t, _r, move) => signed(node.identity.publicKey, move));

        // White to move, turn 0, a fresh window.
        node.setTeam('white');
        node.gameState.beginCountdown('game-1', Date.now());
        node.gameState.begin();
        (node as unknown as { _voting: VotingState })._voting = new VotingState(0, Date.now() + WINDOW);

        return {
            teammate: addPeer(node, `${prefix}white`, 'white'),
            opponent: addPeer(node, `${prefix}black`, 'black'),
        };
    }

    const voteFrom = (peer: Peer, move = 'e2e4') =>
        cb.onVote(peer.peerPublicNodeId, 0, 0, move, Date.now(), signed(peer.peerPublicNodeId, move));

    afterEach(() => node.stop());

    describe('as master', () => {
        let teammate: Peer;
        beforeEach(async () => { ({ teammate } = await setUp(AFTER_US)); });

        it('waits while a connected teammate still has to vote', () => {
            node.castVote('e2e4');
            expect(net.broadcastTallyResult).not.toHaveBeenCalled();
        });

        it('counts the moment the last player on the side votes', () => {
            node.castVote('e2e4');
            voteFrom(teammate);

            expect(net.broadcastTallyResult).toHaveBeenCalledOnce();
            const claim = vi.mocked(net.broadcastTallyResult).mock.calls[0][0];
            expect(claim).toMatchObject({ outcome: 'winner', move: 'e2e4', decidedAt: expect.any(Number) });
            expect(node.gameState.moveHistory.map(m => m.move)).toEqual(['e2e4']);
        });

        it("starts the next window from the decision, not the old window's end", () => {
            node.castVote('e2e4');
            voteFrom(teammate);

            const { decidedAt } = vi.mocked(net.broadcastTallyResult).mock.calls[0][0];
            expect(node.activeVoting!.windowCloseAt).toBe(decidedAt! + WINDOW);
        });

        it("doesn't wait for a teammate who dropped out", () => {
            node.castVote('e2e4');
            teammate.status = 'dead' as Peer['status'];
            (node as unknown as { handlePeerDisconnect(p: Peer): void }).handlePeerDisconnect(teammate);

            expect(net.broadcastTallyResult).toHaveBeenCalledOnce();
        });

        it("revotes straight away on a three-way split, from the moment it's known", () => {
            const third = addPeer(node, `${AFTER_US}white-2`, 'white');
            node.castVote('e2e4');
            voteFrom(teammate, 'd2d4');
            voteFrom(third, 'c2c4');

            const claim = vi.mocked(net.broadcastTallyResult).mock.calls[0][0];
            expect(claim).toMatchObject({ outcome: 'no_majority' });
            expect(node.activeVoting!.round).toBe(1);
            expect(node.activeVoting!.windowCloseAt).toBe(claim.decidedAt! + WINDOW);
        });
    });

    it("doesn't count when it isn't the master; the master will", async () => {
        const { teammate } = await setUp(BEFORE_US);
        node.castVote('e2e4');
        voteFrom(teammate);
        expect(net.broadcastTallyResult).not.toHaveBeenCalled();
    });

    describe("trusting the master's decision time", () => {
        beforeEach(async () => { await setUp(BEFORE_US); });
        const early = (t: unknown) => (node as unknown as { earlyDecision(t: unknown): number | undefined }).earlyDecision(t);

        it('takes a time inside the window', () => {
            const now = Date.now();
            expect(early(now)).toBe(now);
        });

        it('ignores times outside the window, and anything that is not a time', () => {
            const closeAt = node.activeVoting!.windowCloseAt;
            expect(early(closeAt - WINDOW - 1)).toBeUndefined();   // before the window opened
            expect(early(closeAt + 60_000)).toBeUndefined();       // well after it closed
            expect(early('soon')).toBeUndefined();
            expect(early(Infinity)).toBeUndefined();
            expect(early(undefined)).toBeUndefined();
        });
    });
});
