/**
 * App.tsx — Root component
 *
 * Screen routing by phase:
 *   waiting_for_side   → BootScreen
 *   waiting_for_ready  → LobbyScreen
 *   waiting_for_peers  → LobbyScreen
 *   starting           → LobbyScreen (with countdown)
 *   in_progress        → GameScreen
 *   finished           → GameOverScreen
 *   hydrated = false   → LoadingScreen
 */

import './App.css';
import { useEffect }                        from 'react';
import { useChessHive }                     from './useChessHive';
import { useStore, selPhase, selHydrated }  from './store';
import LoginScreen                          from './login';
import BootScreen                           from './screens/BootScreen';
import LobbyScreen                          from './screens/LobbyScreen';
import GameScreen                           from './screens/GameScreen';
import GameOverScreen                       from './screens/GameOverScreen';

// ── Loading ───────────────────────────────────────────────────────────────────

function LoadingScreen() {
    return (
        <div className="screen screen--loading">
            <div className="spinner" />
            <p>Connecting to node…</p>
        </div>
    );
}

// ── Global notification banner ────────────────────────────────────────────────

function NotificationBanner() {
    const notification    = useStore(s => s.notification);
    const setNotification = useStore(s => s.setNotification);

    useEffect(() => {
        if (!notification) return;
        const t = setTimeout(() => setNotification(null), 4000);
        return () => clearTimeout(t);
    }, [notification, setNotification]);

    if (!notification) return null;

    return (
        <div
            className={`notification notification--${notification.type}`}
            onClick={() => setNotification(null)}
            role="alert"
        >
            {notification.message}
        </div>
    );
}

// ── Root ──────────────────────────────────────────────────────────────────────

export default function App() {
    useChessHive();

    const hydrated         = useStore(selHydrated);
    const isAuthenticated  = useStore(s => s.isAuthenticated);
    const phase            = useStore(selPhase);

    return (
        <>
            <NotificationBanner />

            {!hydrated ? <LoadingScreen /> : !isAuthenticated ? <LoginScreen /> : (() => {
                switch (phase) {
                    case 'waiting_for_side':
                        return <BootScreen />;
                    case 'waiting_for_ready':
                    case 'waiting_for_peers':
                    case 'starting':
                        return <LobbyScreen />;
                    case 'in_progress':
                        return <GameScreen />;
                    case 'finished':
                        return <GameOverScreen />;
                    default:
                        return <LoadingScreen />;
                }
            })()}
        </>
    );
}
