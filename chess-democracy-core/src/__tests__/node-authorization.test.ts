import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Node } from '../core/node.js';
import { Peer } from '../network/peer.js';
import { VotingState } from '../game/voting-state.js';
import type { MessageCallbacks } from '../network/localnetwork/message-service.js';
import type { WebSocket } from 'ws';

// Node builds its MessageCallbacks inside boot() and hands them to the
// LocalNetworkController constructor. Capture them there so the tests can
// deliver messages exactly as the network layer would.
const h = vi.hoisted(() => ({
    onReady:   undefined as undefined | ((port: number) => void),
    callbacks: undefined as unknown,
}));

vi.mock('../network/websocket-service.js', () => ({
    WebsocketService: class {
        boot = vi.fn();
        stop = vi.fn();
        on   = vi.fn((event: string, cb: (port: number) => void) => {
            if (event === 'ready') h.onReady = cb;
        });
    },
}));

vi.mock('../network/localnetwork/local-network-controller.js', () => ({
    LocalNetworkController: class {
        constructor(...args: unknown[]) { h.callbacks = args[8]; }
        on                  = vi.fn();
        start               = vi.fn();
        stop                = vi.fn();
        broadcastSideChoice = vi.fn();
    },
}));

function fakeSocket(): WebSocket {
    return { readyState: 1, send: vi.fn(), close: vi.fn(), on: vi.fn() } as unknown as WebSocket;
}

function addPeer(node: Node, key: string, team: 'white' | 'black'): void {
    const peer = new Peer({ peerPublicNodeId: key, ip: '127.0.0.1', port: 9000 }, fakeSocket());
    peer.team = team;
    node.allPeers.set(key, peer);
}

describe('Node rejects messages from peers who may not send them', () => {
    let node: Node;
    let cb: MessageCallbacks;

    beforeEach(() => {
        node = new Node();
        node.boot(0);
        h.onReady!(9000);
        cb = h.callbacks as MessageCallbacks;

        // White to move, turn 0, vote window open for 30s.
        node.setTeam('white');
        node.gameState.beginCountdown('game-1', Date.now());
        node.gameState.begin();
        (node as unknown as { _voting: VotingState })._voting =
            new VotingState(0, Date.now() + 30_000);

        addPeer(node, 'white-teammate', 'white');
        addPeer(node, 'black-opponent', 'black');
    });

    afterEach(() => node.stop());

    const votes = () => node.activeVoting!.votes;

    it('records a legal vote from the side to move', () => {
        cb.onVote('white-teammate', 0, 'e2e4', Date.now());
        expect(votes().get('white-teammate')).toBe('e2e4');
    });

    it('ignores a vote from the side not to move (#20)', () => {
        cb.onVote('black-opponent', 0, 'e2e4', Date.now());
        expect(votes().has('black-opponent')).toBe(false);
    });

    it('ignores a vote from a sender it has no peer record for', () => {
        cb.onVote('stranger', 0, 'e2e4', Date.now());
        expect(votes().size).toBe(0);
    });

    it('ignores an illegal move so it cannot win the tally (#21)', () => {
        cb.onVote('white-teammate', 0, 'e2e5', Date.now());
        expect(votes().size).toBe(0);
    });

    it('ignores a resign vote from the opposing side (#22)', () => {
        const started = vi.fn();
        node.on('resign:vote_started', started);

        cb.onResignVote('black-opponent');

        expect(started).not.toHaveBeenCalled();
        expect((node as unknown as { _resignVote: unknown })._resignVote).toBeNull();
    });

    it('opens the resign vote for a teammate', () => {
        const started = vi.fn();
        node.on('resign:vote_started', started);

        cb.onResignVote('white-teammate');

        expect(started).toHaveBeenCalledOnce();
    });

    // ── game_over (#23) ──────────────────────────────────────────────────

    const gameOver = (sender: string, gameId: string, winner: unknown, reason: string) =>
        cb.onGameOver({ type: 'game_over', gameId, result: { winner, reason } as never }, sender);

    const phase = () => node.gameState.phase;

    it('ignores a game_over for a different game', () => {
        gameOver('black-opponent', 'some-other-game', 'white', 'resignation');
        expect(phase()).toBe('in_progress');
    });

    it('ignores a claimed checkmate, since every node detects those itself', () => {
        gameOver('black-opponent', 'game-1', 'black', 'checkmate');
        expect(phase()).toBe('in_progress');
    });

    it('ignores a resignation sent on behalf of the other side', () => {
        // black claims white resigned, i.e. black wins
        gameOver('black-opponent', 'game-1', 'black', 'resignation');
        expect(phase()).toBe('in_progress');
    });

    it('accepts a side resigning for itself', () => {
        gameOver('black-opponent', 'game-1', 'white', 'resignation');
        expect(phase()).toBe('finished');
        expect(node.gameState.result).toEqual({ winner: 'white', reason: 'resignation' });
    });

    it('ignores a timeout claimed long before the turn could have timed out', () => {
        (node as unknown as { _moveTimeoutStartedAt: number })._moveTimeoutStartedAt = Date.now();
        gameOver('black-opponent', 'game-1', null, 'timeout');
        expect(phase()).toBe('in_progress');
    });

    it('accepts a timeout once the turn has really run out', () => {
        (node as unknown as { _moveTimeoutStartedAt: number })._moveTimeoutStartedAt = Date.now() - 121_000;
        gameOver('black-opponent', 'game-1', null, 'timeout');
        expect(phase()).toBe('finished');
    });

    it('accepts an agreed draw', () => {
        gameOver('black-opponent', 'game-1', 'draw', 'draw_agreement');
        expect(phase()).toBe('finished');
    });
});

describe('Node accepts game_start only from the master (#25)', () => {
    let node: Node;
    let cb: MessageCallbacks;

    // Sort order decides the master: the all-zero key is lowest, so it's the
    // master. The second key is lower than ours but isn't the lowest.
    const MASTER = '0'.repeat(64);
    const MIDDLE = '0'.repeat(63) + '1';

    const start = { type: 'game_start', gameId: 'the-real-game', startsAt: Date.now() + 60_000 };

    beforeEach(() => {
        node = new Node();
        node.boot(0);
        h.onReady!(9000);
        cb = h.callbacks as MessageCallbacks;

        node.setTeam('white');
        addPeer(node, MASTER, 'black');
        addPeer(node, MIDDLE, 'white');
    });

    afterEach(() => node.stop());

    it('ignores game_start from a lower key that is not the lowest', () => {
        node.gameState.beginCountdown('', Date.now() + 60_000);
        cb.onGameStart({ ...start, gameId: 'wrong-game' }, MIDDLE);
        expect(node.gameState.gameId).toBe('');
    });

    it('adopts the master game_start while counting down', () => {
        node.gameState.beginCountdown('', Date.now() + 60_000);
        cb.onGameStart(start, MASTER);
        expect(node.gameState.gameId).toBe('the-real-game');
    });

    it('adopts it even if our own ready check has not fired yet', () => {
        node.gameState.setWaitingForPeers();
        cb.onGameStart(start, MASTER);
        expect(node.gameState.phase).toBe('starting');
        expect(node.gameState.gameId).toBe('the-real-game');
    });
});
