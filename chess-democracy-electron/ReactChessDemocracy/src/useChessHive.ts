// Mounts once in App.tsx. Hydrates the store from node state on boot and
// registers all PUSH event subscriptions for the lifetime of the session.

import { useEffect, useRef } from 'react';
import { useStore } from './store';

// Check whether we are inside the Electron preload context.
const ipc = () =>
    typeof window !== 'undefined' && (window as any).chessHive
        ? (window as any).chessHive
        : null;

export function useChessHive(): void {
    const store       = useStore();
    const countdownId = useRef<ReturnType<typeof setInterval> | null>(null);

    useEffect(() => {
        const api = ipc();
        if (!api) {
            // Running in browser dev mode without Electron — skip IPC entirely
            console.warn('[useChessHive] window.chessHive not found — running without IPC');
            store.setHydrated();
            store.setAuthenticated(true);
            return;
        }

        // 1. Hydrate store from node state

        async function hydrate() {
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

            store.setHydrated();
        }

        // 2. Auto-start with remembered identity, or fall through to login screen

        async function init() {
            const prefsRes = await api.getIdentityPrefs();
            if (prefsRes.ok && prefsRes.value.remembered && prefsRes.value.identityPath) {
                const startRes = await api.startNode(prefsRes.value.identityPath);
                if (startRes.ok) {
                    store.setAuthenticated(true);
                    await hydrate();
                    return;
                }
                // Saved PEM is gone / corrupt — fall through to login screen
                console.warn('[useChessHive] saved identity failed to load — showing login');
            }
            // Not remembered or failed — show the login screen
            store.setHydrated();   // mark hydrated so App doesn't show spinner
        }

        init().catch(console.error);

        // 3. PUSH subscriptions

        const unsubPeerJoined = api.on.peerJoined((data: any) => {
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

        const unsubPeerLeft = api.on.peerLeft((data: any) => {
            store.removePeer(data.peerId);
        });

        const unsubPeerTeamUpdated = api.on.peerTeamUpdated((data: any) => {
            store.updatePeerTeam(data.peerId, data.team);
        });

        const unsubPeerReadyChanged = api.on.peerReadyChanged((data: any) => {
            store.updatePeerReady(data.peerId, data.ready);
        });

        const unsubWaitingSide = api.on.waitingForSide((data: any) => {
            store.setSideBalance({
                whites:     data.whites,
                blacks:     data.blacks,
                waitingFor: data.waitingFor,
            });
        });

        const unsubGameStarting = api.on.gameStarting((data: any) => {
            store.setStarting(data.startsAt, data.countdownMs, data.myTeam);

            // Start the live countdown ticker
            if (countdownId.current) clearInterval(countdownId.current);
            countdownId.current = setInterval(() => {
                store.tickCountdown();
            }, 1000);
        });

        const unsubGameStarted = api.on.gameStarted((data: any) => {
            // Stop the countdown ticker
            if (countdownId.current) {
                clearInterval(countdownId.current);
                countdownId.current = null;
            }
            store.setStarted(data.gameId, data.myTeam, data.fen, data.legalMoves);
        });

        const unsubGameMove = api.on.gameMove((data: any) => {
            store.applyMove(
                data.move,
                data.moveIndex,
                data.senderTeam,
                data.fen,
                data.legalMoves,
                data.isMyTurn,
            );
        });

        const unsubGameOver = api.on.gameOver((data: any) => {
            store.setGameOver(data.gameId, data.result, data.lastFen, data.moveCount);
            store.closeVotingWindow();
            store.closeResignVote();
        });


        const unsubConfigUpdated = api.on.configUpdated((data: any) => {
            store.setConfigUpdated(data.voteWindowMs, data.maxRevotes, data.resignThreshold, data.resignWindowMs, data.version, data.proposerKey);
        });

        const unsubConfigPeerAccepted = api.on.configPeerAccepted((data: any) => {
            store.addPeerAcceptedConfig(data.peerId);
        });

        const unsubConfigSelfAccepted = api.on.configSelfAccepted((data: any) => {
            store.setSelfAcceptedConfig(data.version);
        });


        const unsubVoteWindowOpened = api.on.voteWindowOpened((data: any) => {
            store.openVotingWindow(data.turnIndex, data.windowCloseAt, data.voteWindowMs, data.isMyTurn);
        });

        const unsubVoteReceived = api.on.voteReceived((data: any) => {
            const identity = store.identity;
            const isSelf   = identity?.publicKey === data.peerId;
            store.addVote(data.peerId, data.move, isSelf);
        });

        const unsubTallyDone = api.on.tallyDone((data: any) => {
            store.closeVotingWindow();
            store.applyMove(
                data.move,
                data.turnIndex,
                data.appliedByTeam as any,
                data.fen,
                data.legalMoves,
                data.isMyTurn,
            );
        });

        const unsubRevoteStarted = api.on.revoteStarted((data: any) => {
            store.applyRevote(data.turnIndex, data.windowCloseAt, data.voteWindowMs, data.revoteCount);
        });

        const unsubGameReset = api.on.gameReset(() => {
            if (countdownId.current) {
                clearInterval(countdownId.current);
                countdownId.current = null;
            }
            store.resetGame();
        });


        const unsubDrawOffered  = api.on.drawOffered?.((data: any) => {
            store.setNotification({ type: 'info', message: data.fromSelf ? 'You offered a draw.' : 'Opponent offered a draw.' });
        });
        const unsubDrawDeclined = api.on.drawDeclined?.(() => {
            store.setNotification({ type: 'info', message: 'Draw offer declined.' });
        });


        const unsubResignVoteStarted = api.on.resignVoteStarted?.((data: any) => {
            store.openResignVote(data.expiresAt, 1);
        });
        const unsubResignVoteUpdated = api.on.resignVoteUpdated?.((data: any) => {
            store.updateResignVote(data.yesVotes, data.connectedTeamSize);
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
            if (countdownId.current) clearInterval(countdownId.current);
        };

    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []); // mount once only — store actions are stable references
}
