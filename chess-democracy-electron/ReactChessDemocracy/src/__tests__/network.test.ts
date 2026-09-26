import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useStore } from '../store';
import { joinNetwork, leaveNetwork, browsePublicGames } from '../useChessDemocracy';

const ok = <T,>(value: T) => Promise.resolve({ ok: true, value });

function fakeBridge(overrides: Record<string, unknown> = {}) {
    const api = {
        connectNetwork: vi.fn(() => ok({ network: 'local' })),
        leaveNetwork:   vi.fn(() => ok(undefined)),
        getIdentity:    vi.fn(() => ok({ publicKey: 'abc123', team: null, phase: 'waiting_for_side' })),
        getState:       vi.fn(() => ok({
            phase: 'waiting_for_side', gameId: '', myTeam: null, currentTurn: 'white', isMyTurn: false,
            fen: 'start', legalMoves: [], moveHistory: [], result: null, startsAt: null,
        })),
        getPeers:  vi.fn(() => ok([{ peerId: 'p1', team: 'black', ready: false, status: 'alive' }])),
        getConfig: vi.fn(() => ok({
            config: { voteWindowMs: 30_000, maxRevotes: 3, resignThreshold: 0.67, resignWindowMs: 60_000 },
            version: 0, selfAccepted: true, peerAcceptedIds: [],
        })),
        ...overrides,
    };
    (window as any).chessDemocracy = api;
    return api;
}

describe('choosing a network', () => {
    beforeEach(() => {
        useStore.setState({ network: null, identity: null, peers: [] });
    });

    it('connects, loads the node state, then records the network', async () => {
        const api = fakeBridge();
        expect(await joinNetwork('local')).toBeNull();

        expect(api.connectNetwork).toHaveBeenCalledWith('local', undefined, undefined);   // no room on a LAN
        const s = useStore.getState();
        expect(s.network).toBe('local');
        expect(s.identity?.publicKey).toBe('abc123');
        expect(s.peers).toHaveLength(1);
    });

    it('stays on the network screen and reports why when connecting fails', async () => {
        fakeBridge({ connectNetwork: vi.fn(() => Promise.resolve({ ok: false, error: 'The global network is not available yet' })) });
        expect(await joinNetwork('global')).toMatch(/not available yet/);
        expect(useStore.getState().network).toBeNull();
    });

    it('leaving clears the network, the peers and the game', async () => {
        fakeBridge();
        await joinNetwork('local');
        expect(await leaveNetwork()).toBeNull();

        const s = useStore.getState();
        expect(s.network).toBeNull();
        expect(s.peers).toEqual([]);
        expect(s.game.phase).toBe('waiting_for_side');
    });

    it('refuses to leave once the player is committed to a game', async () => {
        fakeBridge({ leaveNetwork: vi.fn(() => Promise.resolve({ ok: false, error: 'in_game:waiting_for_peers' })) });
        await joinNetwork('local');
        expect(await leaveNetwork()).toBe('in_game:waiting_for_peers');
        expect(useStore.getState().network).toBe('local');
    });
});

describe('playing over the internet', () => {
    beforeEach(() => {
        useStore.setState({ network: null, room: null, visibility: null, identity: null, peers: [] });
    });

    it('passes the room code along and keeps it for sharing', async () => {
        const api = fakeBridge();
        expect(await joinNetwork('global', 'k7mq-x2pd')).toBeNull();
        expect(api.connectNetwork).toHaveBeenCalledWith('global', 'k7mq-x2pd', undefined);
        expect(useStore.getState().room).toBe('k7mq-x2pd');
    });

    it('says whether the game is public or private', async () => {
        const api = fakeBridge();
        await joinNetwork('global', 'k7mq-x2pd', 'public');
        expect(api.connectNetwork).toHaveBeenCalledWith('global', 'k7mq-x2pd', 'public');
        expect(useStore.getState().visibility).toBe('public');
    });

    it('drops what it knew about the room when the network changes', () => {
        useStore.getState().setReach({ found: 2, connected: 1, stuck: true });
        useStore.getState().setNetwork(null);
        expect(useStore.getState().reach).toBeNull();
    });

    it('forgets the room code when leaving', async () => {
        fakeBridge();
        await joinNetwork('global', 'k7mq-x2pd', 'private');
        await leaveNetwork();
        expect(useStore.getState()).toMatchObject({ room: null, visibility: null });
    });
});

describe('public games', () => {
    const listing = { room: 'k7mq-x2pd', hostKey: 'abc', players: 2, whites: 1, blacks: 1, updatedAt: 1 };

    it('returns the games found', async () => {
        fakeBridge({ browsePublicGames: vi.fn(() => ok([listing])) });
        expect(await browsePublicGames()).toEqual({ games: [listing], error: null });
    });

    it('returns no games and the reason when looking fails', async () => {
        fakeBridge({ browsePublicGames: vi.fn(() => Promise.resolve({ ok: false, error: 'offline' })) });
        expect(await browsePublicGames()).toEqual({ games: [], error: 'offline' });
    });
});
