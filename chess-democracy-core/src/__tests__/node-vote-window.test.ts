import { describe, it, expect, vi, afterEach } from 'vitest';
import { Node } from '../core/node.js';
import { bootNode, addPeer } from './helpers/fake-network.js';

describe('vote window events', () => {
    let node: Node;
    afterEach(() => node.stop());

    it('say how far the game clock is from this one, for countdowns', async () => {
        ({ node } = await bootNode());
        node.setTeam('white');
        addPeer(node, 'zz-teammate', 'white');   // so our vote doesn't close the window at once
        node.setTimeOffset(4_000);
        node.gameState.beginCountdown('game-1', Date.now());
        node.gameState.begin();

        const opened = vi.fn();
        node.on('vote:window_opened', opened);
        (node as unknown as { openVotingWindow(turn: number, start: number): void })
            .openVotingWindow(0, node.getSynchronizedTime());

        expect(opened).toHaveBeenCalledWith(expect.objectContaining({ clockOffsetMs: 4_000 }));
        const { windowCloseAt } = opened.mock.calls[0][0];
        expect(windowCloseAt - 4_000 - Date.now()).toBeLessThanOrEqual(node.gameConfig.voteWindowMs);
    });
});
