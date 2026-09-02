import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConnectorService } from '../network/localnetwork/connector-service.js';
import { getOrCreateIdentity } from '../protocol/generateidentity.js';
import { signMessage } from '../protocol/verifysignsignature.js';
import { PeerData, Peer } from '../network/peer.js';
import { WebSocketServer, WebSocket } from 'ws';

// ── socket stub for sendConnectionAck (no real network needed) ────────────────

function makeSocketStub(sendError?: Error): WebSocket {
    return {
        readyState: WebSocket.OPEN,
        send: vi.fn((_d: any, cb?: (e?: Error) => void) => cb?.(sendError)),
        close: vi.fn(),
        on:   vi.fn().mockReturnThis(),
        once: vi.fn().mockReturnThis(),
        off:  vi.fn().mockReturnThis(),
    } as unknown as WebSocket;
}

// ─────────────────────────────────────────────────────────────────────────────

const myId   = getOrCreateIdentity();
const peerId = getOrCreateIdentity();

const peerData: PeerData = {
    peerPublicNodeId: peerId.publicKey,
    ip:   '127.0.0.1',
    port: 0, // assigned dynamically in real-server tests
};

// ── sendConnectionAck ─────────────────────────────────────────────────────────

describe('ConnectorService.sendConnectionAck', () => {
    let service: ConnectorService;

    beforeEach(() => { service = new ConnectorService(); });

    it('returns true when socket.send succeeds', async () => {
        const socket = makeSocketStub();
        const result = await service.sendConnectionAck(
            socket, myId.privateKey, 9000, myId.publicKey, peerId.publicKey,
        );
        expect(result).toBe(true);
        expect(socket.send).toHaveBeenCalledOnce();
    });

    it('returns false when socket.send calls back with an error', async () => {
        const socket = makeSocketStub(new Error('write EPIPE'));
        const result = await service.sendConnectionAck(
            socket, myId.privateKey, 9000, myId.publicKey, peerId.publicKey,
        );
        expect(result).toBe(false);
    });

    it('sends a packet with type=connectionack and a valid signature', async () => {
        const socket = makeSocketStub();
        await service.sendConnectionAck(
            socket, myId.privateKey, 9000, myId.publicKey, peerId.publicKey,
        );
        const raw    = (socket.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        const parsed = JSON.parse(raw);
        expect(parsed.payload.type).toBe('connectionack');
        expect(parsed.payload.key).toBe(myId.publicKey);
        expect(parsed.signature).toBeTruthy();
    });

    it('includes a nonce UUID in the packet', async () => {
        const socket = makeSocketStub();
        await service.sendConnectionAck(
            socket, myId.privateKey, 9000, myId.publicKey, peerId.publicKey,
        );
        const raw    = (socket.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        const parsed = JSON.parse(raw);
        expect(parsed.payload.nonce).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
    });
});

// ── connect() — tested with a real loopback WebSocket server ─────────────────

describe('ConnectorService.connect', () => {
    let wss:     WebSocketServer;
    let port:    number;
    let service: ConnectorService;

    beforeEach(async () => {
        service = new ConnectorService();
        wss     = new WebSocketServer({ port: 0 });
        await new Promise<void>(r => wss.once('listening', r));
        port = (wss.address() as any).port;
    });

    afterEach(async () => {
        // Force-close any lingering client connections so wss.close() doesn't hang
        for (const client of wss.clients) client.terminate();
        await new Promise<void>(r => wss.close(() => r()));
    }, 5000);

    it('resolves with a Peer when the server sends a valid ACK', async () => {
        // Server: receive handshake → reply with a valid connectionack
        wss.once('connection', (serverSocket) => {
            serverSocket.once('message', (data) => {
                const { payload } = JSON.parse(data.toString());
                const ackPayload  = {
                    key:           peerId.publicKey,
                    type:          'connectionack',
                    yourpublickey: payload.key,
                    timestamp:     Date.now(),
                    nonce:         'test-nonce',
                    port,
                };
                const sig = signMessage(JSON.stringify(ackPayload), peerId.privateKey);
                serverSocket.send(JSON.stringify({ payload: ackPayload, signature: sig }));
            });
        });

        const pd: PeerData = { peerPublicNodeId: peerId.publicKey, ip: '127.0.0.1', port };
        const peer = await service.connect(pd, myId.publicKey, myId.privateKey, 9000);
        expect(peer).toBeInstanceOf(Peer);
        expect(peer.peerPublicNodeId).toBe(peerId.publicKey);
    });

    it('rejects when the server sends an invalid signature in the ACK', async () => {
        wss.once('connection', (serverSocket) => {
            serverSocket.once('message', () => {
                const ackPayload = {
                    key:  peerId.publicKey,
                    type: 'connectionack',
                    port,
                };
                // Bad signature
                serverSocket.send(JSON.stringify({ payload: ackPayload, signature: 'badsig==' }));
            });
        });

        const pd: PeerData = { peerPublicNodeId: peerId.publicKey, ip: '127.0.0.1', port };
        await expect(service.connect(pd, myId.publicKey, myId.privateKey, 9000))
            .rejects.toThrow('Invalid handshake ACK');
    });

    it('rejects with ECONNREFUSED when no server is listening', async () => {
        // close the server first
        await new Promise<void>(r => wss.close(() => r()));
        const pd: PeerData = { peerPublicNodeId: peerId.publicKey, ip: '127.0.0.1', port };
        await expect(service.connect(pd, myId.publicKey, myId.privateKey, 9000))
            .rejects.toThrow();
    });
});
