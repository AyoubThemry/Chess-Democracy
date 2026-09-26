/**
 * NetworkScreen.tsx
 *
 * Shown after login, before choosing a side: where does this game happen?
 * Nothing connects until the player picks. The list comes from the core, so a
 * network shows up as playable as soon as it's marked available there.
 */

import { useEffect, useState } from 'react';
import { joinNetwork } from '../useChessDemocracy';
import type { NetworkKind, NetworkOption } from '../ipc-types';
import './BootScreen.css';
import './NetworkScreen.css';

const COPY: Record<NetworkKind, { icon: string; label: string; hint: string }> = {
    local:  { icon: '⌂', label: 'Local network',     hint: 'Friends on the same Wi-Fi' },
    global: { icon: '◎', label: 'Over the internet', hint: 'Friends anywhere' },
};

export default function NetworkScreen() {
    const [options, setOptions] = useState<NetworkOption[]>([
        { kind: 'local', available: true }, { kind: 'global', available: false },
    ]);
    const [joining, setJoining] = useState<NetworkKind | null>(null);
    const [error,   setError]   = useState<string | null>(null);

    const api = () => (window as any).chessDemocracy;

    useEffect(() => {
        // Missing when the renderer runs in a plain browser during development.
        api()?.getNetworkOptions().then((res: any) => { if (res.ok) setOptions(res.value); });
    }, []);

    async function choose(kind: NetworkKind) {
        setError(null);
        setJoining(kind);
        const problem = await joinNetwork(kind);
        if (problem) {
            setError(problem);
            setJoining(null);
        }
    }

    return (
        <div className="boot-screen">

            <header className="boot-header">
                <div className="boot-logo">♟</div>
                <h1>Chess Democracy</h1>
                <p>Where are you playing?</p>
            </header>

            <div className="boot-card">
                <h2>Choose a network</h2>
                <p className="boot-sub">
                    Everyone in a game has to be on the same one.<br />
                    You can switch before pressing Ready.
                </p>

                <div className="boot-sides">
                    {options.map(({ kind, available }) => (
                        <button
                            key={kind}
                            className={`side-btn network-btn network-btn--${kind}`}
                            onClick={() => choose(kind)}
                            disabled={!available || joining !== null}
                        >
                            {joining === kind
                                ? <span className="btn-spinner" />
                                : <span className="side-icon">{COPY[kind].icon}</span>
                            }
                            <span className="side-label">{COPY[kind].label}</span>
                            <span className="side-hint">{available ? COPY[kind].hint : 'Coming soon'}</span>
                        </button>
                    ))}
                </div>

                {error && <p className="boot-error">⚠ {error}</p>}
            </div>

            <button className="network-switch-identity" onClick={() => api().logout()}>
                Use a different identity
            </button>
        </div>
    );
}
