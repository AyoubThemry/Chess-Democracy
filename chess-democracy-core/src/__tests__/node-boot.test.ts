// Extra node tests covering the boot path that requires a running WebSocket service.
// Kept separate from node.test.ts because those tests mock the entire service layer.
import { describe, it, expect, vi } from 'vitest';
import { Node } from '../core/node.js';

vi.mock('../network/websocket-service.js', () => ({
    WebsocketService: class {
        _cbs: Record<string, Function[]> = {};
        boot  = vi.fn((port: number) => {
            // Immediately simulate "ready" so boot() completes synchronously in tests
            setTimeout(() => this._cbs['ready']?.forEach(fn => fn(port || 9000)), 0);
        });
        stop  = vi.fn();
        on    = vi.fn((ev: string, fn: Function) => { (this._cbs[ev] ??= []).push(fn); });
        once  = vi.fn();
        emit  = vi.fn();
    },
}));

vi.mock('../network/localnetwork/local-network-controller.js', () => ({
    LocalNetworkController: class {
        on            = vi.fn();
        start         = vi.fn();
        stop          = vi.fn();
        broadcastReady = vi.fn();
        sync          = vi.fn();
    },
}));

describe('Node — boot and stop lifecycle', () => {
    it('boot() calls service.boot with the given port', () => {
        const node = new Node();
        node.boot(9500);
        expect((node as any).service.boot).toHaveBeenCalledWith(9500);
    });

    it('stop() clears the peer map', async () => {
        const node = new Node();
        node.boot(0);
        await new Promise(r => setTimeout(r, 10)); // let "ready" fire
        node.stop();
        expect(node.allPeers.size).toBe(0);
    });

    it('each Node instance has an independent peer count', () => {
        const a = new Node();
        const b = new Node();
        a.adjustAlivePeersCount('+', 3);
        expect(b.totalAlivePeersCount).toBe(0);
    });
});
