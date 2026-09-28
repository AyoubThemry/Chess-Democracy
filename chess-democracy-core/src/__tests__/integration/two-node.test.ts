/**
 * Two-node integration test.
 *
 * Spins up two real Node instances on ephemeral ports, connects them directly
 * (bypassing Bonjour), then walks through the full pre-game handshake:
 *   connect → side selection → config accept → ready → game start → vote round
 *
 * No mocks — real WebSocket sockets, real crypto, real voting timers.
 * Run via:  npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Node } from '../../core/node.js';
import os from 'node:os';
import path from 'node:path';

// ── Helpers ───────────────────────────────────────────────────────────────────

function bootNode(identitySuffix: string): Promise<Node> {
    return new Promise((resolve, reject) => {
        const identityPath = path.join(
            os.tmpdir(),
            `chess-democracy-test-${identitySuffix}-${Date.now()}.pem`,
        );
        const node = new Node(identityPath);
        const timer = setTimeout(() => reject(new Error(`Node ${identitySuffix} boot timed out`)), 6000);

        const poll = setInterval(() => {
            if (node.boundPort > 0) {
                clearInterval(poll);
                clearTimeout(timer);
                resolve(node);
            }
        }, 10);

        node.boot(0);
    });
}

function waitForEvent(node: Node, event: string, timeoutMs = 6000): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`Timeout (${timeoutMs}ms) waiting for '${event}' on node ${node.identity.publicKey.slice(0, 8)}`)),
            timeoutMs,
        );
        node.once(event as any, (data: unknown) => {
            clearTimeout(timer);
            resolve(data);
        });
    });
}

// ── Fixture ───────────────────────────────────────────────────────────────────

let nodeA: Node;
let nodeB: Node;

beforeAll(async () => {
    [nodeA, nodeB] = await Promise.all([bootNode('A'), bootNode('B')]);
}, 12_000);

afterAll(() => {
    nodeA?.stop();
    nodeB?.stop();
});

// ── Tests — run sequentially, each builds on the previous ────────────────────

describe('Two-node integration', () => {

    it('both nodes boot with distinct identities', () => {
        expect(nodeA.identity.publicKey).toHaveLength(64);
        expect(nodeB.identity.publicKey).toHaveLength(64);
        expect(nodeA.identity.publicKey).not.toBe(nodeB.identity.publicKey);
        expect(nodeA.boundPort).toBeGreaterThan(0);
        expect(nodeB.boundPort).toBeGreaterThan(0);
    });

    it('nodes connect to each other', async () => {
        const peerJoinedOnA = waitForEvent(nodeA, 'peer:joined');
        const peerJoinedOnB = waitForEvent(nodeB, 'peer:joined');

        await nodeB.network!.connectTo!({
            ip:               '127.0.0.1',
            port:             nodeA.boundPort,
            peerPublicNodeId: nodeA.identity.publicKey,
        });

        await Promise.all([peerJoinedOnA, peerJoinedOnB]);

        expect(nodeA.allPeers.size).toBe(1);
        expect(nodeB.allPeers.size).toBe(1);
        expect(nodeA.allPeers.has(nodeB.identity.publicKey)).toBe(true);
        expect(nodeB.allPeers.has(nodeA.identity.publicKey)).toBe(true);
    }, 8_000);

    it('side selection propagates to peer', async () => {
        const teamUpdateOnA = waitForEvent(nodeA, 'peer:team_updated');
        nodeB.setTeam('black');
        const update = await teamUpdateOnA as any;
        expect(update.peerId).toBe(nodeB.identity.publicKey);
        expect(update.team).toBe('black');
    }, 5_000);

    it('nodeA picks the other team', () => {
        const ok = nodeA.setTeam('white');
        expect(ok).toBe(true);
        expect(nodeA.chosenTeam).toBe('white');
    });

    it('config proposal is received and B explicitly accepts it', async () => {
        // setConfig increments the version, so B won't auto-accept — it must
        // call acceptConfig() after receiving config:updated.
        const configUpdatedOnB = waitForEvent(nodeB, 'config:updated');
        const peerAcceptedOnA  = waitForEvent(nodeA, 'config:peer_accepted');

        nodeA.setConfig(
            nodeA.gameConfig.voteWindowMs,
            nodeA.gameConfig.maxRevotes,
        );

        await configUpdatedOnB;  // B received the proposal
        nodeB.acceptConfig();    // B accepts it
        const ev = await peerAcceptedOnA as any;

        expect(ev.peerId).toBe(nodeB.identity.publicKey);
    }, 6_000);

    it('ready is not blocked by config (all accepted)', () => {
        const result = nodeA.ready();
        expect(result).not.toMatch(/config_not_accepted/);
    });

    // Register game:started AND vote:window_opened listeners before triggering
    // ready() — both events fire in the same setTimeout, so the listener for
    // vote:window_opened must already be attached when game:started resolves.
    let voteWindowA: unknown;
    let voteWindowB: unknown;

    it('game starts and vote window opens on both nodes', async () => {
        const gameStartedOnA  = waitForEvent(nodeA, 'game:started',      20_000);
        const gameStartedOnB  = waitForEvent(nodeB, 'game:started',      20_000);
        const windowOnA       = waitForEvent(nodeA, 'vote:window_opened', 20_000);
        const windowOnB       = waitForEvent(nodeB, 'vote:window_opened', 20_000);

        nodeB.ready();

        const [evA, evB, wA, wB] = await Promise.all([
            gameStartedOnA, gameStartedOnB, windowOnA, windowOnB,
        ]) as any[];

        expect(evA.fen).toContain('rnbqkbnr');
        expect(evB.fen).toBe(evA.fen);
        expect(evA.gameId).toBe(evB.gameId);

        expect(wA.turnIndex).toBe(0);
        expect(wB.turnIndex).toBe(0);
        expect(wA.windowCloseAt).toBe(wB.windowCloseAt);

        voteWindowA = wA;
        voteWindowB = wB;
    }, 25_000);

    // Set up before white votes: white is the only player on its side, so
    // once it has voted the master counts straight away instead of waiting
    // out the 30-second window.
    let tallies:     Promise<unknown[]>;
    let nextWindows: Promise<unknown[]>;
    let verified:    ReturnType<typeof vi.spyOn>;
    let votedAt = 0;

    it('white casts e2e4 and the other node receives it', async () => {
        const whiteNode = nodeA.chosenTeam === 'white' ? nodeA : nodeB;
        const otherNode = whiteNode === nodeA ? nodeB : nodeA;
        const nonMaster = nodeA.identity.publicKey < nodeB.identity.publicKey ? nodeB : nodeA;

        const voteOnOther = waitForEvent(otherNode, 'vote:received', 6_000);
        tallies     = Promise.all([waitForEvent(nodeA, 'tally:done', 10_000), waitForEvent(nodeB, 'tally:done', 10_000)]);
        nextWindows = Promise.all([waitForEvent(nodeA, 'vote:window_opened', 10_000), waitForEvent(nodeB, 'vote:window_opened', 10_000)]);
        verified    = vi.spyOn(nonMaster as any, 'handleTallyResult');

        votedAt = Date.now();
        const result = whiteNode.castVote('e2e4');
        expect(result).toBe('ok');

        const ev = await voteOnOther as any;
        expect(ev.move).toBe('e2e4');
        expect(ev.peerId).toBe(whiteNode.identity.publicKey);
    }, 8_000);

    it('the master counts as soon as everyone has voted, the other node verifies, both apply the same move', async () => {
        // Lowest public key is the master. The other node must not count on its
        // own; it has to receive the master's signed result and check it.
        const [masterNode, otherNode] =
            nodeA.identity.publicKey < nodeB.identity.publicKey ? [nodeA, nodeB] : [nodeB, nodeA];

        const [tA, tB] = await tallies as any[];
        expect(Date.now() - votedAt).toBeLessThan(5_000);   // not at the end of the window
        expect(tA.move).toBe('e2e4');
        expect(tB.move).toBe('e2e4');
        expect(tA.fen).toBe(tB.fen);
        expect(tA.turnIndex).toBe(0);

        expect(verified).toHaveBeenCalledWith(masterNode.identity.publicKey, expect.objectContaining({
            move:      'e2e4',
            votes:     [expect.objectContaining({ payload: expect.objectContaining({ move: 'e2e4' }) })],
            decidedAt: expect.any(Number),
        }));
        expect(otherNode.gameState.phase).toBe('in_progress');   // not stopped as out of sync
        expect(masterNode.gameState.phase).toBe('in_progress');

        // Black's window starts from the moment the vote was decided, the same on both.
        const [wA, wB] = await nextWindows as any[];
        expect(wA.turnIndex).toBe(1);
        expect(wA.windowCloseAt).toBe(wB.windowCloseAt);
        expect(wA.windowCloseAt - Date.now()).toBeGreaterThan(nodeA.gameConfig.voteWindowMs - 5_000);
    }, 15_000);

});
