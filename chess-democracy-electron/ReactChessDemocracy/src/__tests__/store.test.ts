/**
 * store.test.ts
 *
 * Unit tests for the Zustand store. Each test resets the store so actions
 * don't bleed across cases. We test pure state transitions only — no IPC,
 * no React component, no window.chessHive.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../store';
import type { GameResult, PeerSummary } from '../ipc-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getState() {
    return useStore.getState();
}

function reset() {
    useStore.setState(useStore.getInitialState?.() ?? {
        hydrated:        false,
        isAuthenticated: false,
        identity:        null,
        peers:           [],
        game: {
            phase:       'waiting_for_side',
            gameId:      '',
            myTeam:      null,
            currentTurn: 'white',
            isMyTurn:    false,
            fen:         'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
            legalMoves:  [],
            moveHistory: [],
            result:      null,
            startsAt:    null,
            countdownMs: null,
        },
        config: {
            voteWindowMs:    30_000,
            maxRevotes:      3,
            version:         0,
            proposerKey:     '',
            selfAccepted:    true,
            peerAcceptedIds: [],
        },
        voting:       null,
        sideBalance:  null,
        notification: null,
    } as any);
}

const PEER_A: PeerSummary = { peerId: 'aaa', team: null, ready: false, status: 'alive' };
const PEER_B: PeerSummary = { peerId: 'bbb', team: 'white', ready: true, status: 'alive' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(reset);

describe('hydration', () => {
    it('starts un-hydrated', () => {
        expect(getState().hydrated).toBe(false);
    });

    it('setHydrated marks the store as hydrated', () => {
        getState().setHydrated();
        expect(getState().hydrated).toBe(true);
    });

    it('setAuthenticated toggles authentication flag', () => {
        getState().setAuthenticated(true);
        expect(getState().isAuthenticated).toBe(true);
        getState().setAuthenticated(false);
        expect(getState().isAuthenticated).toBe(false);
    });
});

describe('peer management', () => {
    it('setPeers replaces the full list', () => {
        getState().setPeers([PEER_A, PEER_B]);
        expect(getState().peers).toHaveLength(2);
    });

    it('upsertPeer adds a new peer', () => {
        getState().upsertPeer(PEER_A);
        expect(getState().peers).toHaveLength(1);
        expect(getState().peers[0].peerId).toBe('aaa');
    });

    it('upsertPeer updates an existing peer without clobbering team', () => {
        getState().upsertPeer(PEER_B); // team: 'white'
        // peer:joined always arrives with team: null — must NOT wipe the team
        getState().upsertPeer({ ...PEER_B, team: null, ready: false });
        const peer = getState().peers[0];
        expect(peer.team).toBe('white');   // preserved
        expect(peer.ready).toBe(false);     // updated
    });

    it('updatePeerTeam changes only the team field', () => {
        getState().setPeers([PEER_A]);
        getState().updatePeerTeam('aaa', 'black');
        expect(getState().peers[0].team).toBe('black');
    });

    it('updatePeerTeam is a no-op for unknown peerId', () => {
        getState().setPeers([PEER_A]);
        getState().updatePeerTeam('zzz', 'white');
        expect(getState().peers[0].team).toBeNull();
    });

    it('updatePeerReady changes only the ready field', () => {
        getState().setPeers([PEER_A]);
        getState().updatePeerReady('aaa', true);
        expect(getState().peers[0].ready).toBe(true);
    });

    it('removePeer removes the peer by id', () => {
        getState().setPeers([PEER_A, PEER_B]);
        getState().removePeer('aaa');
        expect(getState().peers).toHaveLength(1);
        expect(getState().peers[0].peerId).toBe('bbb');
    });
});

describe('game flow', () => {
    it('setStarting transitions to starting phase', () => {
        const now = Date.now();
        getState().setStarting(now + 5000, 5000, 'white');
        const g = getState().game;
        expect(g.phase).toBe('starting');
        expect(g.countdownMs).toBe(5000);
        expect(g.myTeam).toBe('white');
    });

    it('tickCountdown decrements countdownMs by 1000', () => {
        getState().setStarting(Date.now() + 3000, 3000, null);
        getState().tickCountdown();
        expect(getState().game.countdownMs).toBe(2000);
    });

    it('tickCountdown does not go below 0', () => {
        getState().setStarting(Date.now(), 500, null);
        getState().tickCountdown(); // 500 → −500 clamped to 0
        expect(getState().game.countdownMs).toBe(0);
    });

    it('setStarted transitions to in_progress', () => {
        const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
        getState().setStarted('game-1', 'white', fen, ['e2e4']);
        const g = getState().game;
        expect(g.phase).toBe('in_progress');
        expect(g.isMyTurn).toBe(true);  // myTeam=white, currentTurn=white
        expect(g.fen).toBe(fen);
    });

    it('applyMove updates board and flips currentTurn', () => {
        const fen2 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
        getState().setStarted('game-1', 'black', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', []);
        getState().applyMove('e2e4', 0, 'white', fen2, ['e7e5'], true);
        const g = getState().game;
        expect(g.fen).toBe(fen2);
        expect(g.currentTurn).toBe('black');
        expect(g.moveHistory).toHaveLength(1);
        expect(g.moveHistory[0].move).toBe('e2e4');
    });

    it('setGameOver moves to finished phase with result', () => {
        const result: GameResult = { winner: 'white', reason: 'checkmate' };
        getState().setGameOver('game-1', result, 'rnb1kbnr/pppp1ppp/4p3/8/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3', 3);
        const g = getState().game;
        expect(g.phase).toBe('finished');
        expect(g.result?.reason).toBe('checkmate');
        expect(g.result?.winner).toBe('white');
    });

    it('setGameOver handles timeout reason', () => {
        const result: GameResult = { winner: null, reason: 'timeout' };
        getState().setGameOver('game-1', result, '', 0);
        expect(getState().game.result?.reason).toBe('timeout');
    });

    it('setGameOver handles draw_agreement reason', () => {
        const result: GameResult = { winner: 'draw', reason: 'draw_agreement' };
        getState().setGameOver('game-1', result, '', 0);
        const g = getState().game;
        expect(g.result?.winner).toBe('draw');
        expect(g.result?.reason).toBe('draw_agreement');
    });

    it('resetGame returns to default game state', () => {
        getState().setStarted('game-1', 'white', '', []);
        getState().resetGame();
        const g = getState().game;
        expect(g.phase).toBe('waiting_for_side');
        expect(g.myTeam).toBeNull();
    });
});

describe('voting', () => {
    const NOW = Date.now();

    it('openVotingWindow initialises voting state', () => {
        getState().openVotingWindow(0, NOW + 30000, 30000, true);
        const v = getState().voting!;
        expect(v.turnIndex).toBe(0);
        expect(v.myVote).toBeNull();
        expect(v.revoteCount).toBe(0);
    });

    it('addVote records a peer vote', () => {
        getState().openVotingWindow(0, NOW + 30000, 30000, false);
        getState().addVote('aaa', 'e2e4', false);
        expect(getState().voting!.currentVotes['aaa']).toBe('e2e4');
        expect(getState().voting!.myVote).toBeNull();
    });

    it('addVote records own vote and sets myVote', () => {
        getState().openVotingWindow(0, NOW + 30000, 30000, true);
        getState().addVote('self', 'e2e4', true);
        expect(getState().voting!.myVote).toBe('e2e4');
    });

    it('closeVotingWindow clears voting state', () => {
        getState().openVotingWindow(0, NOW + 30000, 30000, true);
        getState().closeVotingWindow();
        expect(getState().voting).toBeNull();
    });

    it('applyRevote resets votes and updates window', () => {
        getState().openVotingWindow(0, NOW + 30000, 30000, true);
        getState().addVote('self', 'e2e4', true);
        getState().applyRevote(0, NOW + 60000, 30000, 1);
        const v = getState().voting!;
        expect(v.myVote).toBeNull();
        expect(v.revoteCount).toBe(1);
        expect(Object.keys(v.currentVotes)).toHaveLength(0);
    });

    it('applyRevote is a no-op for wrong turnIndex', () => {
        getState().openVotingWindow(2, NOW + 30000, 30000, true);
        getState().applyRevote(99, NOW + 60000, 30000, 1);
        expect(getState().voting!.turnIndex).toBe(2);
    });
});

describe('config', () => {
    it('setConfigUpdated marks self as not accepted', () => {
        getState().setConfigUpdated(45000, 5, 0.67, 60000, 2, 'proposer-key');
        const c = getState().config;
        expect(c.selfAccepted).toBe(false);
        expect(c.version).toBe(2);
        expect(c.voteWindowMs).toBe(45000);
    });

    it('setSelfAcceptedConfig sets selfAccepted when version matches', () => {
        getState().setConfigUpdated(30000, 3, 0.67, 60000, 1, 'x');
        getState().setSelfAcceptedConfig(1);
        expect(getState().config.selfAccepted).toBe(true);
    });

    it('setSelfAcceptedConfig is a no-op for wrong version', () => {
        getState().setConfigUpdated(30000, 3, 0.67, 60000, 1, 'x');
        getState().setSelfAcceptedConfig(99);
        expect(getState().config.selfAccepted).toBe(false);
    });

    it('addPeerAcceptedConfig adds a peer and deduplicates', () => {
        getState().addPeerAcceptedConfig('peerA');
        getState().addPeerAcceptedConfig('peerA'); // duplicate
        getState().addPeerAcceptedConfig('peerB');
        expect(getState().config.peerAcceptedIds).toHaveLength(2);
    });
});

describe('notifications', () => {
    it('setNotification sets and clears a notification', () => {
        getState().setNotification({ type: 'error', message: 'oops' });
        expect(getState().notification?.message).toBe('oops');
        getState().setNotification(null);
        expect(getState().notification).toBeNull();
    });
});
