/**
 * BootScreen.tsx
 *
 * Shown when phase === 'waiting_for_side'.
 * The user must pick white or black before anything else can happen.
 * Calls window.chessHive.setTeam() then getState() to advance the phase.
 */

import { useState } from 'react';
import { useStore }  from '../store';
import type { Team } from '../ipc-types';
import './BootScreen.css';

export default function BootScreen() {
    const [loading, setLoading] = useState<Team | null>(null);
    const [error,   setError]   = useState<string | null>(null);
    const applySnapshot = useStore(s => s.applySnapshot);

    async function choose(team: Team) {
        setError(null);
        setLoading(team);
        try {
            const api = (window as any).chessHive;
            const res = await api.setTeam(team);

            if (!res.ok) {
                setError(res.error);
                setLoading(null);
                return;
            }

            // Fetch the updated snapshot so the store (and App router) advances
            const stateRes = await api.getState();
            if (stateRes.ok) applySnapshot(stateRes.value);
        } catch (e) {
            setError('Failed to connect to node');
            setLoading(null);
        }
    }

    return (
        <div className="boot-screen">

            <header className="boot-header">
                <div className="boot-logo">♟</div>
                <h1>Chess Democracy</h1>
                <p>Decentralised P2P chess over your local network</p>
            </header>

            <div className="boot-card">
                <h2>Choose your side</h2>
                <p className="boot-sub">
                    Your choice is broadcast to every peer on the network.<br />
                    You cannot switch sides after pressing Ready.
                </p>

                <div className="boot-sides">
                    <button
                        className="side-btn side-btn--white"
                        onClick={() => choose('white')}
                        disabled={loading !== null}
                    >
                        {loading === 'white'
                            ? <span className="btn-spinner" />
                            : <span className="side-icon">♔</span>
                        }
                        <span className="side-label">White</span>
                        <span className="side-hint">Moves first</span>
                    </button>

                    <div className="side-divider">vs</div>

                    <button
                        className="side-btn side-btn--black"
                        onClick={() => choose('black')}
                        disabled={loading !== null}
                    >
                        {loading === 'black'
                            ? <span className="btn-spinner" />
                            : <span className="side-icon">♚</span>
                        }
                        <span className="side-label">Black</span>
                        <span className="side-hint">Moves second</span>
                    </button>
                </div>

                {error && (
                    <p className="boot-error">⚠ {error}</p>
                )}
            </div>

            <p className="boot-footer">
                Chess Democracy — peer-to-peer, no server required
            </p>
        </div>
    );
}
