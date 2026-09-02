import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageService }   from '../network/localnetwork/message-service.js';
import { Peer, PeerStatus, PeerData } from '../network/peer.js';
import { getOrCreateIdentity }        from '../protocol/generateidentity.js';
import { signMessage, verifySignature } from '../protocol/verifysignsignature.js';
import { randomUUID }                 from 'crypto';
import { WebSocket }                  from 'ws';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeSocket(readyState = WebSocket.OPEN): WebSocket {
    return {
        readyState,
        send:  vi.fn(),
        close: vi.fn(),
        on:    vi.fn(),
        once:  vi.fn(),
        off:   vi.fn(),
    } as unknown as WebSocket;
}

function makePeer(id: string, socket?: WebSocket): Peer {
    const data: PeerData = { peerPublicNodeId: id, ip: '127.0.0.1', port: 9000 };
    return new Peer(data, socket ?? makeSocket());
}

function buildSignedMessage(payload: Record<string, unknown>, privKey: string) {
    const signature = signMessage(JSON.stringify(payload), privKey);
    return { payload, signature };
}

// ─────────────────────────────────────────────────────────────────────────────

function makeCallbacks(overrides: Record<string, unknown> = {}) {
    return {
        setTimeOffset:    vi.fn(),
        onGameStart:      vi.fn(),
        onMove:           vi.fn(),
        onGameOver:       vi.fn(),
        onSideChoice:     vi.fn(),
        onReady:          vi.fn(),
        onUnready:        vi.fn(),
        onConfigProposal: vi.fn(),
        onConfigAccept:   vi.fn(),
        onVote:           vi.fn(),
        ...overrides,
    };
}

describe('MessageService.HandleMessage', () => {
    const sender   = getOrCreateIdentity();
    const receiver = getOrCreateIdentity();
    const noop     = vi.fn();

    let peers: Map<string, Peer>;
    let peer:  Peer;

    beforeEach(() => {
        noop.mockClear();
        peer  = makePeer(sender.publicKey);
        peers = new Map([[sender.publicKey, peer]]);
    });

    // ── Signature validation ──────────────────────────────────────────────

    it('rejects a message with an invalid signature', () => {
        const payload = { type: 'ready', team: 'white', nonce: randomUUID(), timestamp: Date.now() };
        const result  = MessageService.HandleMessage(
            payload, 'badsig==', sender.publicKey,
            peers, receiver.publicKey, receiver.privateKey, makeCallbacks({ setTimeOffset: noop }),
        );
        expect(result).toBeNull();
    });

    it('rejects a message from an unknown peer', () => {
        const unknown = getOrCreateIdentity();
        const payload = { type: 'ready', team: 'white', nonce: randomUUID(), timestamp: Date.now() };
        const sig     = signMessage(JSON.stringify(payload), unknown.privateKey);
        const result  = MessageService.HandleMessage(
            payload, sig, unknown.publicKey,
            peers, receiver.publicKey, receiver.privateKey, makeCallbacks({ setTimeOffset: noop }),
        );
        expect(result).toBeNull();
    });

    // ── Replay protection ─────────────────────────────────────────────────

    it('accepts a message the first time', () => {
        const nonce   = randomUUID();
        const payload = { type: 'ready', team: 'white', nonce, timestamp: Date.now() };
        const sig     = signMessage(JSON.stringify(payload), sender.privateKey);
        const result  = MessageService.HandleMessage(
            payload, sig, sender.publicKey,
            peers, receiver.publicKey, receiver.privateKey, makeCallbacks({ setTimeOffset: noop }),
        );
        expect(result).toBe('ready');
    });

    it('rejects the exact same signed message a second time (replay)', () => {
        const nonce   = randomUUID();
        const payload = { type: 'ready', team: 'black', nonce, timestamp: Date.now() };
        const sig     = signMessage(JSON.stringify(payload), sender.privateKey);

        const cbs  = makeCallbacks({ setTimeOffset: noop });
        const args = [payload, sig, sender.publicKey, peers, receiver.publicKey, receiver.privateKey, cbs] as const;

        // First call — OK
        MessageService.HandleMessage(...args);
        // Reset peer state so we can test replay cleanly
        peer = makePeer(sender.publicKey);
        peers = new Map([[sender.publicKey, peer]]);
        args[3] = peers;

        // Second call with SAME nonce — must be rejected
        const result = MessageService.HandleMessage(...args);
        expect(result).toBeNull();
    });

    // ── Message types ─────────────────────────────────────────────────────

    it('handles "ready" — sets peer.ready = true and peer.team', () => {
        const payload = { type: 'ready', team: 'white', nonce: randomUUID(), timestamp: Date.now() };
        const sig     = signMessage(JSON.stringify(payload), sender.privateKey);
        MessageService.HandleMessage(
            payload, sig, sender.publicKey,
            peers, receiver.publicKey, receiver.privateKey, makeCallbacks({ setTimeOffset: noop }),
        );
        expect(peer.ready).toBe(true);
        expect(peer.team).toBe('white');
    });

    it('handles "time_sync_response" — calls setTimeOffset with correct value', () => {
        const clientTime = Date.now() - 200;
        const serverTime = Date.now();
        const payload = {
            type:        'time_sync_response',
            client_time: clientTime,
            server_time: serverTime,
            nonce:       randomUUID(),
            timestamp:   Date.now(),
        };
        const sig = signMessage(JSON.stringify(payload), sender.privateKey);
        MessageService.HandleMessage(
            payload, sig, sender.publicKey,
            peers, receiver.publicKey, receiver.privateKey, makeCallbacks({ setTimeOffset: noop }),
        );
        expect(noop).toHaveBeenCalledWith(serverTime - clientTime);
    });

    it('handles "time_sync_request" — sends a response via the peer socket', () => {
        const payload = {
            type:        'time_sync_request',
            request_id:  randomUUID(),
            client_time: Date.now(),
            nonce:       randomUUID(),
            timestamp:   Date.now(),
        };
        const sig = signMessage(JSON.stringify(payload), sender.privateKey);
        MessageService.HandleMessage(
            payload, sig, sender.publicKey,
            peers, receiver.publicKey, receiver.privateKey, makeCallbacks({ setTimeOffset: noop }),
        );
        expect(peer.socket.send).toHaveBeenCalled();
    });

    it('returns null for an unknown message type', () => {
        const payload = { type: 'unknown_type', nonce: randomUUID(), timestamp: Date.now() };
        const sig     = signMessage(JSON.stringify(payload), sender.privateKey);
        const result  = MessageService.HandleMessage(
            payload, sig, sender.publicKey,
            peers, receiver.publicKey, receiver.privateKey, makeCallbacks({ setTimeOffset: noop }),
        );
        expect(result).toBeNull();
    });

    it('touch() is called on every valid message — lastSeen is updated', () => {
        const before  = peer.lastSeen;
        // small delay so Date.now() will differ
        const payload = { type: 'ready', team: 'white', nonce: randomUUID(), timestamp: Date.now() };
        const sig     = signMessage(JSON.stringify(payload), sender.privateKey);
        MessageService.HandleMessage(
            payload, sig, sender.publicKey,
            peers, receiver.publicKey, receiver.privateKey, makeCallbacks({ setTimeOffset: noop }),
        );
        expect(peer.lastSeen).toBeGreaterThanOrEqual(before);
    });
});

describe('MessageService.SendReady', () => {
    const me   = getOrCreateIdentity();
    const them = getOrCreateIdentity();

    it('sends a packet to alive peers', () => {
        const socket = makeSocket();
        const peer   = makePeer(them.publicKey, socket);
        const peers  = new Map([[them.publicKey, peer]]);

        MessageService.SendReady('white', peers, me.publicKey, me.privateKey);
        expect(socket.send).toHaveBeenCalledOnce();
    });

    it('does not send to dead peers', () => {
        const socket = makeSocket();
        const peer   = makePeer(them.publicKey, socket);
        peer.status  = PeerStatus.Dead;
        const peers  = new Map([[them.publicKey, peer]]);

        MessageService.SendReady('black', peers, me.publicKey, me.privateKey);
        expect(socket.send).not.toHaveBeenCalled();
    });

    it('sends a packet signed with our private key (verifiable)', () => {
        const socket = makeSocket();
        // Capture the sent packet to inspect it
        let sentPacket = '';
        (socket.send as ReturnType<typeof vi.fn>).mockImplementation((data: string) => {
            sentPacket = data;
        });

        const peer  = makePeer(them.publicKey, socket);
        const peers = new Map([[them.publicKey, peer]]);
        MessageService.SendReady('white', peers, me.publicKey, me.privateKey);

        const parsed = JSON.parse(sentPacket);
        const { payload, signature } = parsed;
        expect(verifySignature(JSON.stringify(payload), signature, me.publicKey)).toBe(true);
    });
});
