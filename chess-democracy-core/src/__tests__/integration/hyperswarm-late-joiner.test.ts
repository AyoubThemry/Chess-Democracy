/**
 * A player joining a room over hyperswarm after the others have settled in.
 * The DHT is a local testnet, so this runs offline.
 *
 * Run via: npm run test:integration
 */

import { describe, it, beforeAll, afterAll } from 'vitest';
import createTestnet, { type Testnet } from 'hyperdht/testnet.js';
import { Node } from '../../core/node.js';
import { HyperswarmNetwork } from '../../network/globalnetwork/hyperswarm-network.js';

let testnet: Testnet;
const nodes: Node[] = [];

function joinRoom(room: string): Node {
    const node = new Node(undefined, HyperswarmNetwork.create({ room, bootstrap: testnet.bootstrap }));
    node.boot(0);
    nodes.push(node);
    return node;
}

async function until(what: string, check: () => boolean, ms = 30_000): Promise<void> {
    const start = Date.now();
    while (!check()) {
        if (Date.now() - start > ms) throw new Error(`never happened: ${what}`);
        await new Promise(r => setTimeout(r, 100));
    }
}

const sees = (a: Node, b: Node) => a.allPeers.has(b.identity.publicKey);

beforeAll(async () => { testnet = await createTestnet(3); }, 20_000);
afterAll(async () => { nodes.forEach(n => n.stop()); await testnet?.destroy(); });

describe('Joining a room late', () => {
    it('a third player finds both players already there', async () => {
        const first  = joinRoom('rook-5150');
        const second = joinRoom('rook-5150');
        await until('the first two connect', () => sees(first, second) && sees(second, first));

        // Long enough for both to have looked the room up a few times since.
        await new Promise(r => setTimeout(r, 12_000));

        const third = joinRoom('rook-5150');
        await until('the third connects to both', () =>
            sees(third, first) && sees(third, second) && sees(first, third) && sees(second, third), 40_000);
    }, 90_000);
});
