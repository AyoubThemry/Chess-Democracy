/**
 * Public and private games over real hyperswarm, on a local DHT testnet.
 *
 * Run via: npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import createTestnet, { type Testnet } from 'hyperdht/testnet.js';
import { Node } from '../../core/node.js';
import { HyperswarmNetwork } from '../../network/globalnetwork/hyperswarm-network.js';
import { browsePublicGames } from '../../network/globalnetwork/lobby.js';

let testnet: Testnet;
const nodes: Node[] = [];

function host(room: string, visibility: 'public' | 'private'): Node {
    const node = new Node(undefined, HyperswarmNetwork.create({
        room, public: visibility === 'public', bootstrap: testnet.bootstrap,
    }));
    node.boot(0);
    nodes.push(node);
    return node;
}

const browse = () => browsePublicGames({ bootstrap: testnet.bootstrap });

async function until(what: string, check: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
    const start = Date.now();
    while (!(await check())) {
        if (Date.now() - start > ms) throw new Error(`never happened: ${what}`);
        await new Promise(r => setTimeout(r, 200));
    }
}

function waitFor(node: Node, event: string, ms = 30_000): Promise<any> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
        node.once(event, (d: any) => { clearTimeout(timer); resolve(d); });
    });
}

beforeAll(async () => { testnet = await createTestnet(3); }, 20_000);
afterAll(async () => { nodes.forEach(n => n.stop()); await testnet?.destroy(); });

describe('Public lobbies', () => {
    let publicHost: Node;

    it('lists a public game and not a private one', async () => {
        publicHost = host('open-4821', 'public');
        host('secret-7730', 'private');
        publicHost.setTeam('white');

        await until('the public game shows up', async () => (await browse()).some(g => g.room === 'open-4821'));
        const games = await browse();
        expect(games.map(g => g.room)).toEqual(['open-4821']);                       // the private one never appears
        expect(games[0]).toMatchObject({ players: 1, whites: 1, blacks: 0, hostKey: publicHost.identity.publicKey });
    }, 45_000);

    it('a player who finds it in the list can join with its code', async () => {
        const [listing] = await browse();
        const joiner = host(listing.room, 'public');
        await until('the joiner connects', () => publicHost.allPeers.has(joiner.identity.publicKey));
        joiner.setTeam('black');

        await until('the listing shows both players', async () =>
            (await browse()).some(g => g.room === 'open-4821' && g.players === 2 && g.blacks === 1));
    }, 45_000);

    it('the game leaves the list once it starts', async () => {
        const joiner = nodes[2];
        await until('sides known', () => publicHost.allPeers.get(joiner.identity.publicKey)?.team === 'black');

        const starting = waitFor(publicHost, 'game:starting');
        expect(publicHost.ready()).toBe('ok');
        expect(joiner.ready()).toBe('ok');
        await starting;

        await until('the game is gone from the list', async () => (await browse()).length === 0);
    }, 45_000);
});
