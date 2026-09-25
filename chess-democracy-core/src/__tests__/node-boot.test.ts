// Node's boot path: it asks its network factory for a transport, starts it,
// and wires up peer events. A fake transport stands in, so no sockets open.
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { Node } from '../core/node.js';
import type { GameNetwork, NetworkFactory } from '../network/game-network.js';

function fakeTransport() {
    const network = Object.assign(new EventEmitter(), { start: vi.fn(), stop: vi.fn() }) as unknown as GameNetwork;
    const factory = vi.fn<NetworkFactory>(async () => ({ network, boundPort: 9123 }));
    return { network, factory };
}

const settle = () => new Promise(r => setImmediate(r));

describe('Node — boot and stop lifecycle', () => {
    it('boot() hands the requested port to the network factory', () => {
        const { factory } = fakeTransport();
        new Node(undefined, factory).boot(9500);
        expect(factory).toHaveBeenCalledWith(expect.anything(), 9500);
    });

    it('starts the transport and reports the port it got', async () => {
        const { network, factory } = fakeTransport();
        const node = new Node(undefined, factory);
        node.boot(0);
        await settle();
        expect(network.start).toHaveBeenCalledOnce();
        expect(node.boundPort).toBe(9123);
        expect(node.network).toBe(network);
    });

    it('stop() stops the transport and clears the peer map', async () => {
        const { network, factory } = fakeTransport();
        const node = new Node(undefined, factory);
        node.boot(0);
        await settle();
        node.stop();
        expect(network.stop).toHaveBeenCalledOnce();
        expect(node.allPeers.size).toBe(0);
    });

    it('a transport that finishes starting after stop() is shut down, not used', async () => {
        const { network, factory } = fakeTransport();
        const node = new Node(undefined, factory);
        node.boot(0);
        node.stop();          // before the factory's promise resolves
        await settle();
        expect(network.start).not.toHaveBeenCalled();
        expect(network.stop).toHaveBeenCalledOnce();
    });

    it('each Node instance has an independent peer count', () => {
        const a = new Node();
        const b = new Node();
        a.adjustAlivePeersCount('+', 3);
        expect(b.totalAlivePeersCount).toBe(0);
    });
});
