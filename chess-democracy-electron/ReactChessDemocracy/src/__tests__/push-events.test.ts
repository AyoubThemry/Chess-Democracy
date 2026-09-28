import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useStore } from '../store';
import { useChessDemocracy } from '../useChessDemocracy';

const ok = <T,>(value: T) => Promise.resolve({ ok: true, value });

/** A bridge whose push subscriptions can be fired by hand. */
function fakeBridge() {
    const handlers: Record<string, (data: unknown) => void> = {};
    const on = new Proxy({}, {
        get: (_t, name: string) => (cb: (data: unknown) => void) => {
            handlers[name] = cb;
            return () => { delete handlers[name]; };
        },
    });
    (window as unknown as { chessDemocracy: unknown }).chessDemocracy = {
        getIdentityPrefs: vi.fn(() => ok({ remembered: false, identityPath: null })),
        on,
    };
    return handlers;
}

describe('push events', () => {
    beforeEach(() => {
        useStore.setState({ identity: null, voting: null, notification: null });
    });

    it('recognises our own vote once the identity has loaded', async () => {
        const handlers = fakeBridge();
        renderHook(() => useChessDemocracy());

        // The identity arrives after the hook mounted, as it does in the app.
        act(() => {
            useStore.setState({ identity: { publicKey: 'me', team: 'white', phase: 'in_progress' } });
            useStore.getState().openVotingWindow(0, Date.now() + 30_000, 30_000, true);
        });
        act(() => handlers.voteReceived({ peerId: 'me', turnIndex: 0, move: 'e2e4' }));

        expect(useStore.getState().voting?.myVote).toBe('e2e4');
    });

    it("counts down on this computer's clock, not the game's", () => {
        const handlers = fakeBridge();
        renderHook(() => useChessDemocracy());
        const closeOnGameClock = Date.now() + 30_000;

        // The game clock runs 5 s ahead of this computer's.
        act(() => handlers.voteWindowOpened({ turnIndex: 0, windowCloseAt: closeOnGameClock, voteWindowMs: 30_000, isMyTurn: true, clockOffsetMs: 5_000 }));
        expect(useStore.getState().voting?.windowCloseAt).toBe(closeOnGameClock - 5_000);

        act(() => handlers.revoteStarted({ turnIndex: 0, revoteCount: 1, windowCloseAt: closeOnGameClock + 30_500, voteWindowMs: 30_000, clockOffsetMs: 5_000 }));
        expect(useStore.getState().voting?.windowCloseAt).toBe(closeOnGameClock + 30_500 - 5_000);
    });

    it("doesn't re-render the app for store changes it doesn't use", () => {
        fakeBridge();
        let renders = 0;
        renderHook(() => { renders++; useChessDemocracy(); });
        const before = renders;

        act(() => useStore.getState().setNotification({ type: 'info', message: 'hello' }));

        expect(renders).toBe(before);
    });
});
