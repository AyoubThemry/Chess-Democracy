// Mounts once in App.tsx. Hydrates the store from node state on boot and
// registers all PUSH event subscriptions for the lifetime of the session.

import { useEffect, useRef } from 'react';
import { useStore } from './store';
import { ipc, bridge } from './bridge';
import type { NetworkKind, Visibility, PublicGame } from './ipc-types';

/**
 * A time on the game clock as a time on this computer's clock. The node keeps
 * its clock in step with the game's master, which can be seconds off from
 * this computer's, so a countdown against Date.now() needs this.
 */
export function onThisClock(gameTime: number, clockOffsetMs = 0): number {
    return gameTime - clockOffsetMs;
}

export function useChessDemocracy(): void {
    const countdownId = useRef<ReturnType<typeof setInterval> | null>(null);

    useEffect(() => {
        // Actions only. Subscribing here would re-render the whole app on
        // every store change, and state read from this snapshot would go
        // stale: read it with useStore.getState() when it's needed.
        const store = useStore.getState();
        const api = ipc();
        if (!api) {
            // Running in browser dev mode without Electron — skip IPC entirely
            console.warn('[useChessDemocracy] window.chessDemocracy not found — running without IPC');
            store.setHydrated();
            store.setAuthenticated(true);
            return;
        }

        // 1. Load the remembered identity if there is one. That skips the login
        //    screen, but not the network screen: networking only starts once
        //    the player has picked a network.

        const init = async () => {
            const prefsRes = await api.getIdentityPrefs();
            if (prefsRes.ok && prefsRes.value.remembered && prefsRes.value.identityPath) {
                const startRes = await api.startNode(prefsRes.value.identityPath);
                if (startRes.ok) {
                    store.setAuthenticated(true);
                } else {
                    // Saved PEM is gone / corrupt — fall through to login screen
                    console.warn('[useChessDemocracy] saved identity failed to load — showing login');
                }
            }
            store.setHydrated();   // mark hydrated so App doesn't show spinner
        };

        init().catch(console.error);

        // 2. PUSH subscriptions

        const unsubPeerJoined = api.on.peerJoined((data) => {
            store.upsertPeer({
                peerId: data.peerId,
                team:   null,
                ready:  false,
                status: 'alive',
            });
            // After a short delay, refresh the full peer list so that side-choice
            // messages sent by the existing peer to the new joiner have time to
            // arrive and be processed — this ensures the late-joiner sees the
            // existing peer's chosen team in the lobby UI.
            setTimeout(async () => {
                const peersRes = await api.getPeers();
                if (peersRes.ok) store.setPeers(peersRes.value);
            }, 500);
        });

        const unsubPeerLeft = api.on.peerLeft((data) => {
            store.removePeer(data.peerId);
        });

        const unsubPeerTeamUpdated = api.on.peerTeamUpdated((data) => {
            store.updatePeerTeam(data.peerId, data.team);
        });

        const unsubPeerReadyChanged = api.on.peerReadyChanged((data) => {
            store.updatePeerReady(data.peerId, data.ready);
        });

        const unsubWaitingSide = api.on.waitingForSide((data) => {
            store.setSideBalance({
                whites:     data.whites,
                blacks:     data.blacks,
                waitingFor: data.waitingFor,
            });
        });

        const unsubGameStarting = api.on.gameStarting((data) => {
            store.setStarting(data.startsAt, data.countdownMs, data.myTeam);

            // Start the live countdown ticker
            if (countdownId.current) clearInterval(countdownId.current);
            countdownId.current = setInterval(() => {
                store.tickCountdown();
            }, 1000);
        });

        const unsubGameStarted = api.on.gameStarted((data) => {
            // Stop the countdown ticker
            if (countdownId.current) {
                clearInterval(countdownId.current);
                countdownId.current = null;
            }
            store.setStarted(data.gameId, data.myTeam, data.fen, data.legalMoves);
        });

        const unsubGameMove = api.on.gameMove((data) => {
            store.applyMove(
                data.move,
                data.moveIndex,
                data.senderTeam,
                data.fen,
                data.legalMoves,
                data.isMyTurn,
            );
        });

        const unsubGameOver = api.on.gameOver((data) => {
            store.setGameOver(data.gameId, data.result, data.lastFen, data.moveCount);
            store.closeVotingWindow();
            store.closeResignVote();
        });


        const unsubConfigUpdated = api.on.configUpdated((data) => {
            store.setConfigUpdated(data.voteWindowMs, data.maxRevotes, data.resignThreshold, data.resignWindowMs, data.version, data.proposerKey);
        });

        const unsubConfigPeerAccepted = api.on.configPeerAccepted((data) => {
            store.addPeerAcceptedConfig(data.peerId);
        });

        const unsubConfigSelfAccepted = api.on.configSelfAccepted((data) => {
            store.setSelfAcceptedConfig(data.version);
        });


        const unsubVoteWindowOpened = api.on.voteWindowOpened((data) => {
            store.openVotingWindow(data.turnIndex, onThisClock(data.windowCloseAt, data.clockOffsetMs), data.voteWindowMs, data.isMyTurn);
        });

        const unsubVoteReceived = api.on.voteReceived((data) => {
            const isSelf = useStore.getState().identity?.publicKey === data.peerId;
            store.addVote(data.peerId, data.move, isSelf);
        });

        const unsubTallyDone = api.on.tallyDone((data) => {
            store.closeVotingWindow();
            store.applyMove(
                data.move,
                data.turnIndex,
                data.appliedByTeam,
                data.fen,
                data.legalMoves,
                data.isMyTurn,
            );
        });

        const unsubRevoteStarted = api.on.revoteStarted((data) => {
            store.applyRevote(data.turnIndex, onThisClock(data.windowCloseAt, data.clockOffsetMs), data.voteWindowMs, data.revoteCount);
        });

        const unsubGameReset = api.on.gameReset(() => {
            if (countdownId.current) {
                clearInterval(countdownId.current);
                countdownId.current = null;
            }
            store.resetGame();
        });


        const unsubDrawOffered  = api.on.drawOffered?.((data) => {
            const message = data.fromSelf ? 'You offered a draw.'
                          : data.byOpponent ? 'Opponent offered a draw.'
                          : 'A teammate offered a draw. The other side decides.';
            store.setNotification({ type: 'info', message });
        });
        const unsubDrawDeclined = api.on.drawDeclined?.(() => {
            store.setNotification({ type: 'info', message: 'Draw offer declined.' });
        });


        const unsubResignVoteStarted = api.on.resignVoteStarted?.((data) => {
            store.openResignVote(data.expiresAt, 1);
        });
        const unsubResignVoteUpdated = api.on.resignVoteUpdated?.((data) => {
            store.updateResignVote(data.yesVotes, data.connectedTeamSize);
        });
        const unsubNetworkReach = api.on.networkReach?.((data) => {
            store.setReach(data);
        });
        const unsubResignVoteExpired = api.on.resignVoteExpired?.(() => {
            store.closeResignVote();
            store.setNotification({ type: 'info', message: 'Resign vote expired.' });
        });

        // Cleanup

        return () => {
            unsubPeerJoined();
            unsubPeerLeft();
            unsubPeerTeamUpdated();
            unsubPeerReadyChanged();
            unsubWaitingSide();
            unsubGameStarting();
            unsubGameStarted();
            unsubGameMove();
            unsubGameOver();
            unsubConfigUpdated();
            unsubConfigPeerAccepted();
            unsubConfigSelfAccepted();
            unsubVoteWindowOpened();
            unsubVoteReceived();
            unsubTallyDone();
            unsubRevoteStarted();
            unsubGameReset();
            unsubDrawOffered?.();
            unsubDrawDeclined?.();
            unsubResignVoteStarted?.();
            unsubResignVoteUpdated?.();
            unsubResignVoteExpired?.();
            unsubNetworkReach?.();
            if (countdownId.current) clearInterval(countdownId.current);
        };

    }, []); // mount once only
}

// ── Joining and leaving a network ─────────────────────────────────────────────

/** Pulls the node's current state into the store. Call after connecting. */
export async function hydrateFromNode(): Promise<void> {
    const api   = bridge();
    const store = useStore.getState();
    const [idRes, stateRes, peersRes, configRes] = await Promise.all([
        api.getIdentity(),
        api.getState(),
        api.getPeers(),
        api.getConfig(),
    ]);
    if (idRes.ok)     store.setIdentity(idRes.value);
    if (stateRes.ok)  store.applySnapshot(stateRes.value);
    if (peersRes.ok)  store.setPeers(peersRes.value);
    if (configRes.ok) store.applyConfigSnapshot(configRes.value);
}

/**
 * Starts networking on `network`; `room` is the shared code for playing over
 * the internet, and a public game is listed in the lobby. Returns an error
 * message, or null on success.
 */
export async function joinNetwork(network: NetworkKind, room?: string, visibility?: Visibility): Promise<string | null> {
    const res = await bridge().connectNetwork(network, room, visibility);
    if (!res.ok) return res.error;
    await hydrateFromNode();
    useStore.getState().setNetwork(network, room ?? null, visibility ?? null);
    return null;
}

/** The public games open to join right now. Takes a few seconds: it looks them up on the internet. */
export async function browsePublicGames(): Promise<{ games: PublicGame[]; error: string | null }> {
    const res = await bridge().browsePublicGames();
    return res.ok ? { games: res.value, error: null } : { games: [], error: res.error };
}

/** Back to the network screen. Only works before Ready. */
export async function leaveNetwork(): Promise<string | null> {
    const res = await bridge().leaveNetwork();
    if (!res.ok) return res.error;
    const store = useStore.getState();
    store.resetGame();
    store.setPeers([]);
    store.setNetwork(null);
    return null;
}
