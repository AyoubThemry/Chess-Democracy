import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Node } from '../core/node.js';
import type { SignedVote } from '../game/voting-state.js';
import type { GameNetwork } from '../network/game-network.js';
import { bootNode, addPeer } from './helpers/fake-network.js';

// Hex public keys sort before this, so with these peers we're the master.
const AFTER_US = 'zz-';

const signed = (key: string, move: string) =>
    ({ payload: { key, type: 'vote', turnIndex: 0, round: 0, move, timestamp: 0, nonce: key }, signature: '' }) as SignedVote;

describe('Node move timeout', () => {
    let node: Node;
    let net: GameNetwork;

    beforeEach(async () => {
        ({ node, net } = await bootNode());
        vi.mocked(net.broadcastVote).mockImplementation((_t, _r, move) => signed(node.identity.publicKey, move));
        node.setTeam('white');
        addPeer(node, `${AFTER_US}black`, 'black');
    });

    afterEach(() => {
        node.stop();
        vi.useRealTimers();
    });

    /** Starts the game's first vote window, with its timers, under fake time. */
    function startFirstWindow() {
        vi.useFakeTimers();
        node.gameState.beginCountdown('game-1', Date.now());
        node.gameState.begin();
        (node as unknown as { openVotingWindow(turn: number, start: number): void })
            .openVotingWindow(0, node.getSynchronizedTime());
    }

    it('follows the settings: every round of a turn, plus time for the result', () => {
        expect(node.moveTimeoutMs).toBe(4 * 30_500 + 10_000);   // default: 30 s windows, 3 revotes
        node.setConfig(120_000, 0);
        expect(node.moveTimeoutMs).toBe(120_500 + 10_000);
    });

    it('lets every revote run on the default settings', () => {
        startFirstWindow();
        vi.advanceTimersByTime(4 * 30_500 + 1_000);   // nobody votes: the window and 3 revotes run out

        // It used to hit the 2-minute cap first, during the last revote.
        expect(node.gameState.result).toEqual({ winner: null, reason: 'revotes_exhausted' });
    });

    it('counts a 2-minute window instead of timing out just before it closes', () => {
        node.setConfig(120_000, 0);
        addPeer(node, `${AFTER_US}white`, 'white');   // a teammate who doesn't vote, so the window runs out
        startFirstWindow();
        node.castVote('e2e4');

        vi.advanceTimersByTime(121_000);

        expect(node.gameState.phase).toBe('in_progress');
        expect(node.gameState.moveHistory.map(m => m.move)).toEqual(['e2e4']);
    });

    it('still ends a turn that never gets counted, at the limit and not before', () => {
        // Four players, three of them gone: too few to count, so nothing ever is.
        addPeer(node, `${AFTER_US}white`, 'white');
        addPeer(node, `${AFTER_US}black-2`, 'black');
        (node as unknown as { recordRoster(): void }).recordRoster();
        for (const key of [...node.allPeers.keys()]) node.allPeers.delete(key);
        startFirstWindow();

        vi.advanceTimersByTime(node.moveTimeoutMs - 1_000);
        expect(node.gameState.phase).toBe('in_progress');

        vi.advanceTimersByTime(2_000);
        expect(node.gameState.result).toEqual({ winner: null, reason: 'timeout' });
    });
});
