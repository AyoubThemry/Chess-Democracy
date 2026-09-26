/**
 * A game over real hyperswarm: real DHT, NAT-traversal code paths and
 * encrypted streams. The DHT is a local testnet, so this runs offline and
 * doesn't touch the public network.
 *
 * Run via: npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import createTestnet, { type Testnet } from 'hyperdht/testnet.js';
import { Node } from '../../core/node.js';
import { HyperswarmNetwork } from '../../network/globalnetwork/hyperswarm-network.js';

let testnet: Testnet;
let white: Node, black: Node, elsewhere: Node;

function joinRoom(room: string): Node {
    return new Node(undefined, HyperswarmNetwork.create({ room, bootstrap: testnet.bootstrap }));
}

function waitFor(node: Node, event: string, match: (d: any) => boolean = () => true, ms = 30_000): Promise<any> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
        const handler = (d: any) => { if (!match(d)) return; clearTimeout(timer); node.off(event, handler); resolve(d); };
        node.on(event, handler);
    });
}

async function until(what: string, check: () => boolean, ms = 30_000): Promise<void> {
    const start = Date.now();
    while (!check()) {
        if (Date.now() - start > ms) throw new Error(`never happened: ${what}`);
        await new Promise(r => setTimeout(r, 50));
    }
}

beforeAll(async () => {
    testnet   = await createTestnet(3);
    white     = joinRoom('knight-4821');
    black     = joinRoom('knight-4821');
    elsewhere = joinRoom('bishop-9930');   // a different game
    [white, black, elsewhere].forEach(n => n.boot(0));
}, 20_000);

afterAll(async () => {
    [white, black, elsewhere].forEach(n => n?.stop());
    await testnet?.destroy();
});

describe('A game over hyperswarm', () => {

    it('players with the same room code find each other; others do not', async () => {
        await until('the two players connect', () =>
            white.allPeers.has(black.identity.publicKey) && black.allPeers.has(white.identity.publicKey));

        await new Promise(r => setTimeout(r, 2000));   // give a wrong connection time to show up
        expect(white.allPeers.has(elsewhere.identity.publicKey)).toBe(false);
        expect(elsewhere.allPeers.size).toBe(0);
    }, 40_000);

    it('agrees on sides and config', async () => {
        white.setTeam('white');
        black.setTeam('black');
        await until('sides known', () =>
            white.allPeers.get(black.identity.publicKey)?.team === 'black' &&
            black.allPeers.get(white.identity.publicKey)?.team === 'white');

        const proposal = waitFor(black, 'config:updated');
        const accepted = waitFor(white, 'config:peer_accepted');
        white.setConfig(5_000, 3);
        await proposal;
        black.acceptConfig();
        await accepted;
    }, 20_000);

    it('starts the game on both', async () => {
        const started = Promise.all([white, black].map(n => waitFor(n, 'game:started')));
        expect(white.ready()).toBe('ok');
        expect(black.ready()).toBe('ok');
        const [a, b] = await started;
        expect(a.gameId).toBe(b.gameId);
    }, 30_000);

    it('the master counts, the other verifies, both play the same move', async () => {
        const played = Promise.all([white, black].map(n => waitFor(n, 'tally:done', d => d.turnIndex === 0)));
        expect(white.castVote('e2e4')).toBe('ok');
        const [a, b] = await played;
        expect(a.move).toBe('e2e4');
        expect(b.fen).toBe(a.fen);
        expect([white, black].every(n => n.gameState.phase === 'in_progress')).toBe(true);
    }, 30_000);
});
