import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Node } from '../core/node.js';
import { VotingState } from '../game/voting-state.js';
import type { MessageCallbacks } from '../network/message-service.js';
import type { GameNetwork } from '../network/game-network.js';
import { bootNode, addPeer } from './helpers/fake-network.js';

describe('Node ending a game', () => {
    let node: Node;
    let cb: MessageCallbacks;
    let net: GameNetwork;

    beforeEach(async () => {
        ({ node, cb, net } = await bootNode());

        // White to move, turn 0, vote window open.
        node.setTeam('white');
        node.gameState.beginCountdown('game-1', Date.now());
        node.gameState.begin();
        (node as unknown as { _voting: VotingState })._voting = new VotingState(0, Date.now() + 30_000);

        addPeer(node, 'white-teammate', 'white');
        addPeer(node, 'black-opponent', 'black');
    });

    afterEach(() => {
        node.stop();
        vi.useRealTimers();
    });

    it('a draw closes an open resign vote, so it never expires on the game-over screen', () => {
        vi.useFakeTimers();
        const expired = vi.fn();
        node.on('resign:vote_expired', expired);

        expect(node.castResignVote()).toBe('ok');   // 1 of 2: not enough, stays open
        cb.onDrawOffer('black-opponent');
        expect(node.respondToDraw(true)).toBe('ok');

        vi.advanceTimersByTime(node.gameConfig.resignWindowMs);
        expect(node.gameState.result).toEqual({ winner: 'draw', reason: 'draw_agreement' });
        expect(expired).not.toHaveBeenCalled();
    });

    it('tells the other players about a draw it accepted', () => {
        const over = vi.fn();
        node.on('game:over', over);

        cb.onDrawOffer('black-opponent');
        node.respondToDraw(true);

        expect(net.broadcastGameOver).toHaveBeenCalledWith(
            'game-1', { winner: 'draw', reason: 'draw_agreement' }, node.gameState.fen, 0,
        );
        expect(over).toHaveBeenCalledOnce();
        expect(node.activeVoting).toBeNull();
    });

    it("doesn't repeat a game_over it received from a peer", () => {
        cb.onDrawOffer('white-teammate');   // our side offered
        cb.onGameOver({ type: 'game_over', gameId: 'game-1', result: { winner: 'draw', reason: 'draw_agreement' } }, 'black-opponent');

        expect(node.gameState.phase).toBe('finished');
        expect(net.broadcastGameOver).not.toHaveBeenCalled();
    });
});
