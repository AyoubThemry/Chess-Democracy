import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { BaseNetworkController } from '../network/base-network-controller.js';
import { Peer, PeerData, PeerStatus } from '../network/peer.js';
import { WebsocketService } from '../network/websocket-service.js';
import { getOrCreateIdentity } from '../protocol/generateidentity.js';
import { signMessage } from '../protocol/verifysignsignature.js';
import { NETWORK_CONFIG } from '../utils/config.js';
import { WebSocket } from 'ws';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeSocket(): WebSocket {
    const handlers: Record<string, Function[]> = {};
    const stub = {
        readyState: WebSocket.OPEN,
        send:  vi.fn((_d: any, cb?: (e?: Error) => void) => cb?.()),
        close: vi.fn(),
        on:    (ev: string, fn: Function) => { (handlers[ev] ??= []).push(fn); return stub; },
        once:  (ev: string, fn: Function) => { (handlers[ev] ??= []).push(fn); return stub; },
        off:   vi.fn(),
        _trigger: (ev: string, ...args: any[]) => handlers[ev]?.forEach(fn => fn(...args)),
    } as unknown as WebSocket;
    return stub;
}

function makeListenerStub(): WebsocketService {
    const ee = new EventEmitter() as WebsocketService;
    return ee;
}

// ── Concrete subclass to test the abstract base ───────────────────────────────

const identity = getOrCreateIdentity();
let   peers    = new Map<string, Peer>();

class TestController extends BaseNetworkController {
    constructor(listener: WebsocketService, accepting = true) {
        super(
            listener,
            identity,
            9000,
            () => peers.size,
            () => peers,
            () => accepting,
        );
    }
    start() {}
    stop()  { this.stopBase(); }
    getPeers() { return peers; }
    getMessageCallbacks() {
        return {
            setTimeOffset: (_n: number) => {},
            onGameStart:   (_m: any, _k: string) => {},
            onMove:        (_m: any, _k: string) => {},
            onGameOver:    (_m: any, _k: string) => {},
        };
    }
}

// ─────────────────────────────────────────────────────────────────────────────

describe('BaseNetworkController — rate limiting', () => {
    let listener:    WebsocketService;
    let controller:  TestController;

    beforeEach(() => {
        peers      = new Map();
        listener   = makeListenerStub();
        controller = new TestController(listener);
    });

    afterEach(() => controller.stop());

    it('allows a connection under the rate limit', () => {
        const socket = makeSocket();
        listener.emit('connection', socket, { socket: { remoteAddress: '10.0.0.1' } });
        // socket.once('message') has been registered → socket is not closed
        expect(socket.close).not.toHaveBeenCalled();
    });

    it('rejects connections from an IP that exceeds the limit', () => {
        const limit = NETWORK_CONFIG.MAX_HANDSHAKES_PER_MIN + 1;
        for (let i = 0; i < limit; i++) {
            const s = makeSocket();
            listener.emit('connection', s, { socket: { remoteAddress: '10.0.0.2' } });
        }
        const overflow = makeSocket();
        listener.emit('connection', overflow, { socket: { remoteAddress: '10.0.0.2' } });
        expect(overflow.close).toHaveBeenCalled();
    });

    it('allows a connection when IP is different (no cross-IP pollution)', () => {
        const limit = NETWORK_CONFIG.MAX_HANDSHAKES_PER_MIN;
        for (let i = 0; i < limit; i++) {
            listener.emit('connection', makeSocket(), { socket: { remoteAddress: '10.0.0.3' } });
        }
        const different = makeSocket();
        listener.emit('connection', different, { socket: { remoteAddress: '10.0.0.4' } });
        expect(different.close).not.toHaveBeenCalled();
    });
});

describe('BaseNetworkController — capacity gate', () => {
    it('closes socket immediately when not accepting connections', () => {
        const listener   = makeListenerStub();
        const controller = new TestController(listener, false /* not accepting */);
        const socket     = makeSocket();
        listener.emit('connection', socket, { socket: { remoteAddress: '10.0.0.5' } });
        expect(socket.close).toHaveBeenCalled();
        controller.stop();
    });

    it('closes socket when peer map is at MAX_PEERS', () => {
        peers = new Map(
            Array.from({ length: NETWORK_CONFIG.MAX_PEERS }, (_, i) => {
                const id = String(i).padStart(64, '0');
                return [id, { peerPublicNodeId: id } as Peer];
            }),
        );
        const listener   = makeListenerStub();
        const controller = new TestController(listener);
        const socket     = makeSocket();
        listener.emit('connection', socket, { socket: { remoteAddress: '10.0.0.6' } });
        expect(socket.close).toHaveBeenCalled();
        controller.stop();
    });
});

describe('BaseNetworkController — handshake validation', () => {
    let listener:   WebsocketService;
    let controller: TestController;

    beforeEach(() => {
        peers      = new Map();
        listener   = makeListenerStub();
        controller = new TestController(listener);
    });

    afterEach(() => controller.stop());

    async function sendHandshake(socket: WebSocket, payload: object, sigKey: string) {
        // Trigger the inbound connection
        listener.emit('connection', socket, { socket: { remoteAddress: '10.0.0.7' } });
        // Send the handshake message that the controller is now listening for
        const msg = JSON.stringify(payload);
        const sig = signMessage(msg, sigKey);
        const packet = Buffer.from(JSON.stringify({ payload, signature: sig }));
        await (socket as any)._trigger('message', packet);
        // give async handleHandshake a tick to run
        await new Promise(r => setImmediate(r));
    }

    it('rejects a handshake with a bad signature', async () => {
        const socket  = makeSocket();
        const payload = { key: identity.publicKey, type: 'handshake', timestamp: Date.now(), port: 9001 };
        listener.emit('connection', socket, { socket: { remoteAddress: '10.0.0.7' } });
        const badPacket = Buffer.from(JSON.stringify({ payload, signature: 'badsig==' }));
        await (socket as any)._trigger('message', badPacket);
        await new Promise(r => setImmediate(r));
        expect(socket.close).toHaveBeenCalled();
    });

    it('rejects a handshake with a timestamp too far in the past', async () => {
        const socket  = makeSocket();
        const staleTs = Date.now() - NETWORK_CONFIG.TIME_SKEW_TOLERANCE_MS - 1000;
        const payload = { key: identity.publicKey, type: 'handshake', timestamp: staleTs, port: 9001 };
        const sig     = signMessage(JSON.stringify(payload), identity.privateKey);
        listener.emit('connection', socket, { socket: { remoteAddress: '10.0.0.7' } });
        const packet = Buffer.from(JSON.stringify({ payload, signature: sig }));
        await (socket as any)._trigger('message', packet);
        await new Promise(r => setImmediate(r));
        expect(socket.close).toHaveBeenCalled();
    });

    it('rejects a handshake with an invalid port', async () => {
        const socket  = makeSocket();
        const payload = { key: identity.publicKey, type: 'handshake', timestamp: Date.now(), port: 80 };
        const sig     = signMessage(JSON.stringify(payload), identity.privateKey);
        listener.emit('connection', socket, { socket: { remoteAddress: '10.0.0.7' } });
        const packet = Buffer.from(JSON.stringify({ payload, signature: sig }));
        await (socket as any)._trigger('message', packet);
        await new Promise(r => setImmediate(r));
        expect(socket.close).toHaveBeenCalled();
    });
});

describe('BaseNetworkController — ghost detection', () => {
    it('marks a timed-out peer as Dead and calls onPeerDied', () => {
        const listener   = makeListenerStub();
        const controller = new TestController(listener);
        const socket     = makeSocket();

        const peer = new Peer(
            { peerPublicNodeId: 'a'.repeat(64), ip: '127.0.0.1', port: 9999 },
            socket,
        );
        // Make the peer look stale
        peer.lastSeen = Date.now() - NETWORK_CONFIG.GHOST_TIMEOUT_MS - 1000;
        peers = new Map([['a'.repeat(64), peer]]);

        const died = vi.fn();
        // Access protected via cast
        (controller as any).removeGhosts(peers, died);

        expect(died).toHaveBeenCalledWith(1);
        expect(peer.status).toBe(PeerStatus.Dead);
        expect(socket.close).toHaveBeenCalled();
        controller.stop();
    });

    it('does NOT remove a peer that was recently seen', () => {
        const listener   = makeListenerStub();
        const controller = new TestController(listener);
        const socket     = makeSocket();

        const peer = new Peer(
            { peerPublicNodeId: 'b'.repeat(64), ip: '127.0.0.1', port: 9999 },
            socket,
        );
        peer.lastSeen = Date.now(); // fresh
        peers = new Map([['b'.repeat(64), peer]]);

        const died = vi.fn();
        (controller as any).removeGhosts(peers, died);

        expect(died).not.toHaveBeenCalled();
        expect(peer.status).toBe(PeerStatus.Alive);
        controller.stop();
    });
});

describe('BaseNetworkController — outbound connectToPeer', () => {
    it('skips connecting to self', async () => {
        const listener   = makeListenerStub();
        const controller = new TestController(listener);
        const spy        = vi.spyOn((controller as any).connector, 'connect');

        await (controller as any).connectToPeer({
            peerPublicNodeId: identity.publicKey, // same as controller identity
            ip:   '127.0.0.1',
            port: 9001,
        });

        expect(spy).not.toHaveBeenCalled();
        controller.stop();
    });

    it('skips connecting to an already-known peer', async () => {
        const other = getOrCreateIdentity();
        peers = new Map([[other.publicKey, {} as Peer]]);

        const listener   = makeListenerStub();
        const controller = new TestController(listener);
        const spy        = vi.spyOn((controller as any).connector, 'connect');

        await (controller as any).connectToPeer({
            peerPublicNodeId: other.publicKey,
            ip:   '127.0.0.1',
            port: 9001,
        });

        expect(spy).not.toHaveBeenCalled();
        controller.stop();
    });
});
