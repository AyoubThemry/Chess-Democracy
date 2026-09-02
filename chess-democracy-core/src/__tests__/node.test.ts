import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Node } from '../core/node.js';

// ── Stub the WebsocketService so no real sockets are created ─────────────────
vi.mock('../network/websocket-service.js', () => ({
    WebsocketService: class {
        boot  = vi.fn();
        stop  = vi.fn();
        on    = vi.fn();
        once  = vi.fn();
        emit  = vi.fn();
    },
}));

// ── Stub LocalNetworkController ───────────────────────────────────────────────
vi.mock('../network/localnetwork/local-network-controller.js', () => ({
    LocalNetworkController: class {
        on            = vi.fn();
        start         = vi.fn();
        stop          = vi.fn();
        broadcastReady = vi.fn();
        sync          = vi.fn();
    },
}));

// ─────────────────────────────────────────────────────────────────────────────

describe('Node — state management', () => {
    let node: Node;

    beforeEach(() => {
        node = new Node();
    });

    it('starts with zero alive peers', () => {
        expect(node.totalAlivePeersCount).toBe(0);
    });

    it('starts accepting connections', () => {
        expect(node.acceptingConnectionStatus).toBe(true);
    });

    it('starts with an empty peer map', () => {
        expect(node.allPeers.size).toBe(0);
    });

    it('has a valid 64-char hex public key', () => {
        expect(node.identity.publicKey).toHaveLength(64);
        expect(node.identity.publicKey).toMatch(/^[a-f0-9]{64}$/);
    });

    it('has a PEM private key', () => {
        expect(node.identity.privateKey).toContain('BEGIN PRIVATE KEY');
    });

    it('starts in waiting_for_side phase', () => {
        expect(node.gameState.phase).toBe('waiting_for_side');
    });

    it('chosenTeam is null before setTeam()', () => {
        expect(node.chosenTeam).toBeNull();
    });

    it('setTeam() sets the team and advances phase', () => {
        const ok = node.setTeam('white');
        expect(ok).toBe(true);
        expect(node.chosenTeam).toBe('white');
        expect(node.gameState.phase).toBe('waiting_for_ready');
    });

    it('setTeam() can be changed before ready (lobby side-switch)', () => {
        node.setTeam('white');
        const second = node.setTeam('black');
        expect(second).toBe(true);
        expect(node.chosenTeam).toBe('black');
        expect(node.gameState.phase).toBe('waiting_for_ready');
    });

    it('setTeam() returns false after ready is broadcast', () => {
        node.setTeam('white');
        // Manually push phase forward past waiting_for_ready
        (node.gameState as any)._phase = 'waiting_for_peers';
        const result = node.setTeam('black');
        expect(result).toBe(false);
    });

    it('adjustAlivePeersCount("+") increments count', () => {
        node.adjustAlivePeersCount('+', 1);
        expect(node.totalAlivePeersCount).toBe(1);
    });

    it('adjustAlivePeersCount("-") decrements count', () => {
        node.adjustAlivePeersCount('+', 3);
        node.adjustAlivePeersCount('-', 2);
        expect(node.totalAlivePeersCount).toBe(1);
    });

    it('adjustAlivePeersCount("-") never goes below zero', () => {
        node.adjustAlivePeersCount('-', 99);
        expect(node.totalAlivePeersCount).toBe(0);
    });

    it('getSynchronizedTime returns approximately Date.now() with zero offset', () => {
        const before = Date.now();
        const synced = node.getSynchronizedTime();
        const after  = Date.now();
        expect(synced).toBeGreaterThanOrEqual(before);
        expect(synced).toBeLessThanOrEqual(after + 1);
    });

    it('setTimeOffset shifts getSynchronizedTime', () => {
        node.setTimeOffset(1000);
        const synced = node.getSynchronizedTime();
        expect(synced).toBeGreaterThan(Date.now()); // shifted forward
    });

    it('setTimeOffset with negative value shifts backward', () => {
        node.setTimeOffset(-1000);
        const synced = node.getSynchronizedTime();
        expect(synced).toBeLessThan(Date.now()); // shifted backward
    });

    it('two Node instances are fully independent', () => {
        const nodeA = new Node();
        const nodeB = new Node();
        nodeA.adjustAlivePeersCount('+', 5);
        expect(nodeB.totalAlivePeersCount).toBe(0); // not shared
    });

    it('stop() does not throw', () => {
        expect(() => node.stop()).not.toThrow();
    });
});
