import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Peer, PeerData, PeerStatus } from '../network/peer.js';
import { WebSocket } from 'ws';

// Minimal socket stub — only the properties Peer actually uses.
function makeSocket(readyState: number = WebSocket.OPEN): WebSocket {
    return {
        readyState,
        send:  vi.fn(),
        close: vi.fn(),
        on:    vi.fn(),
        once:  vi.fn(),
        off:   vi.fn(),
    } as unknown as WebSocket;
}

const sampleData: PeerData = {
    peerPublicNodeId: 'a'.repeat(64),
    ip:   '192.168.1.10',
    port: 9001,
};

describe('Peer', () => {
    let socket: WebSocket;
    let peer:   Peer;

    beforeEach(() => {
        socket = makeSocket();
        peer   = new Peer(sampleData, socket);
    });

    it('exposes peerPublicNodeId from PeerData', () => {
        expect(peer.peerPublicNodeId).toBe(sampleData.peerPublicNodeId);
    });

    it('exposes PeerIp from PeerData', () => {
        expect(peer.PeerIp).toBe('192.168.1.10');
    });

    it('initialises with status Alive', () => {
        expect(peer.status).toBe(PeerStatus.Alive);
    });

    it('initialises ready as false', () => {
        expect(peer.ready).toBe(false);
    });

    it('initialises team as null', () => {
        expect(peer.team).toBeNull();
    });

    it('touch() updates lastSeen to approximately now', () => {
        const before = Date.now();
        peer.touch();
        const after  = Date.now();
        expect(peer.lastSeen).toBeGreaterThanOrEqual(before);
        expect(peer.lastSeen).toBeLessThanOrEqual(after);
    });

    it('send() calls socket.send when socket is OPEN', () => {
        peer.send({ type: 'ping' });
        expect(socket.send).toHaveBeenCalledOnce();
    });

    it('send() does NOT call socket.send when socket is CLOSED', () => {
        const closedSocket = makeSocket(WebSocket.CLOSED);
        const closedPeer   = new Peer(sampleData, closedSocket);
        closedPeer.send({ type: 'ping' });
        expect(closedSocket.send).not.toHaveBeenCalled();
    });

    it('allows status to be set to Dead', () => {
        peer.status = PeerStatus.Dead;
        expect(peer.status).toBe(PeerStatus.Dead);
    });

    it('PeerStatus enum values match expected strings', () => {
        expect(PeerStatus.Alive).toBe('alive');
        expect(PeerStatus.Dead).toBe('dead');
    });
});
