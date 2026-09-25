/**
 * Three real nodes, real sockets, real signatures. The master drops out
 * mid-game; the other two carry on under a new master; the dropped node
 * reconnects on its own, catches up from a snapshot, and play continues.
 *
 * Run via: npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Node } from '../../core/node.js';
import os from 'node:os';
import path from 'node:path';

function bootNode(label: string): Promise<Node> {
    return new Promise((resolve, reject) => {
        const node  = new Node(path.join(os.tmpdir(), `chess-democracy-resync-${label}-${Date.now()}.pem`));
        const timer = setTimeout(() => reject(new Error(`${label} did not boot`)), 6000);
        const poll  = setInterval(() => {
            if (node.boundPort > 0) { clearInterval(poll); clearTimeout(timer); resolve(node); }
        }, 10);
        node.boot(0);
    });
}

function waitFor(node: Node, event: string, match: (d: any) => boolean = () => true, timeoutMs = 30_000): Promise<any> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
        const handler = (d: any) => {
            if (!match(d)) return;
            clearTimeout(timer);
            node.off(event, handler);
            resolve(d);
        };
        node.on(event, handler);
    });
}

async function until(what: string, check: () => boolean, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (!check()) {
        if (Date.now() - start > timeoutMs) throw new Error(`never happened: ${what}\n${describeNodes()}`);
        await new Promise(r => setTimeout(r, 50));
    }
}

function describeNodes(): string {
    return [master, second, third].filter(Boolean).map((n, i) => {
        const peers = [...n.allPeers.values()].map(p => `${p.peerPublicNodeId.slice(0, 6)}:${p.team}`).join(',');
        const acc   = [...n.peerAcceptedVersions].map(([k, v]) => `${k.slice(0, 6)}=v${v}`).join(',');
        return `  ${['master', 'second', 'third'][i]} ${n.identity.publicKey.slice(0, 6)} phase=${n.gameState.phase} `
             + `cfg=v${n.configVersion} self=${n.selfAcceptedConfigVersion} peers=[${peers}] accepted=[${acc}]`;
    }).join('\n');
}

const connect = (from: Node, to: Node) => from.network!.connectTo!({
    ip: '127.0.0.1', port: to.boundPort, peerPublicNodeId: to.identity.publicKey,
});

// Sorted by key: `master` has the lowest, so it starts as master.
let master: Node, second: Node, third: Node;

beforeAll(async () => {
    const nodes = await Promise.all(['a', 'b', 'c'].map(bootNode));
    [master, second, third] = nodes.sort((x, y) => (x.identity.publicKey < y.identity.publicKey ? -1 : 1));
}, 15_000);

afterAll(() => { master?.stop(); second?.stop(); third?.stop(); });

describe('Three nodes: the master drops out and comes back', () => {

    it('connects, picks sides, agrees on config', async () => {
        await connect(second, master);
        await connect(third, master);
        await connect(third, second);
        await until('all three connected', () => [master, second, third].every(n => n.allPeers.size === 2));

        master.setTeam('black');
        second.setTeam('white');
        third.setTeam('white');
        await until('sides known everywhere', () => [master, second, third].every(n => [...n.allPeers.values()].every(p => p.team)));

        // A 10 s window leaves room for the outage and the catch-up.
        const accepted = Promise.all([
            waitFor(master, 'config:peer_accepted', d => d.peerId === second.identity.publicKey),
            waitFor(master, 'config:peer_accepted', d => d.peerId === third.identity.publicKey),
        ]);
        const proposalOn = (n: Node) => waitFor(n, 'config:updated');
        const [onSecond, onThird] = [proposalOn(second), proposalOn(third)];
        master.setConfig(10_000, 3);
        await onSecond; second.acceptConfig();
        await onThird;  third.acceptConfig();
        await accepted;
        await until('second and third see both accepts', () => [second, third].every(n => n.peerAcceptedVersions.size === 2));
    }, 20_000);

    it('starts the game on all three', async () => {
        const started = Promise.all([master, second, third].map(n => waitFor(n, 'game:started')));
        expect(master.ready()).toBe('ok');
        expect(second.ready()).toBe('ok');
        expect(third.ready()).toBe('ok');
        const [a, b, c] = await started;
        expect(new Set([a.gameId, b.gameId, c.gameId]).size).toBe(1);
    }, 30_000);

    it('the other two keep playing under a new master while it is gone', async () => {
        // Hold off its reconnect attempts, then cut all its connections.
        const blocked = vi.spyOn(master.network as any, 'connectToPeer').mockResolvedValue(undefined);
        for (const peer of [...master.allPeers.values()]) peer.connection.close();
        await until('master cut off everywhere', () => second.allPeers.size === 1 && third.allPeers.size === 1 && master.allPeers.size === 0);

        const played = Promise.all([second, third].map(n => waitFor(n, 'tally:done', d => d.turnIndex === 0)));
        expect(second.castVote('e2e4')).toBe('ok');
        expect(third.castVote('e2e4')).toBe('ok');
        const [b, c] = await played;
        expect(b.move).toBe('e2e4');
        expect(c.fen).toBe(b.fen);

        // Alone, it has no quorum, so it must not have played on by itself.
        expect(master.gameState.moveHistory).toHaveLength(0);
        expect(master.gameState.phase).toBe('in_progress');

        blocked.mockRestore();   // let it reconnect
    }, 40_000);

    it('reconnects by itself and catches up from a snapshot', async () => {
        const caughtUp = waitFor(master, 'tally:done', d => d.turnIndex === 0 && d.move === 'e2e4');
        await caughtUp;
        await until('reconnected', () => master.allPeers.size === 2);

        expect(master.gameState.moveHistory.map(m => m.move)).toEqual(['e2e4']);
        expect(master.gameState.fen).toBe(second.gameState.fen);
        expect(master.activeVoting?.turnIndex).toBe(1);
    }, 30_000);

    it('takes over as master again and all three stay in step', async () => {
        const played = Promise.all([master, second, third].map(n => waitFor(n, 'tally:done', d => d.turnIndex === 1)));
        expect(master.castVote('e7e5')).toBe('ok');   // black to move, and it's the only black player
        const results = await played;

        expect(results.map(r => r.move)).toEqual(['e7e5', 'e7e5', 'e7e5']);
        expect(new Set(results.map(r => r.fen)).size).toBe(1);
        expect([master, second, third].every(n => n.gameState.phase === 'in_progress')).toBe(true);
    }, 40_000);
});
