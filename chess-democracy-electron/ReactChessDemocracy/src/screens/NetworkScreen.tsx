/**
 * NetworkScreen.tsx
 *
 * Shown after login, before choosing a side: where does this game happen?
 * Nothing connects until the player picks. The list comes from the core, so a
 * network shows up as playable as soon as it's marked available there.
 *
 * Playing over the internet needs a room code, since there's no "same Wi-Fi"
 * to find each other by: one player creates a game and sends the code, the
 * others join with it.
 */

import { useEffect, useState } from 'react';
import { joinNetwork } from '../useChessDemocracy';
import { newRoomCode, normalizeRoomCode } from '../roomCode';
import type { NetworkKind, NetworkOption } from '../ipc-types';
import './BootScreen.css';
import './NetworkScreen.css';

const COPY: Record<NetworkKind, { icon: string; label: string; hint: string }> = {
    local:  { icon: '⌂', label: 'Local network',     hint: 'Friends on the same Wi-Fi' },
    global: { icon: '◎', label: 'Over the internet', hint: 'Friends anywhere' },
};

export default function NetworkScreen() {
    const [options,  setOptions]  = useState<NetworkOption[]>([
        { kind: 'local', available: true, needsRoom: false },
        { kind: 'global', available: false, needsRoom: true },
    ]);
    const [roomFor,  setRoomFor]  = useState<NetworkKind | null>(null);   // showing the room step
    const [code,     setCode]     = useState('');
    const [joining,  setJoining]  = useState(false);
    const [error,    setError]    = useState<string | null>(null);

    const api = () => (window as any).chessDemocracy;

    useEffect(() => {
        // Missing when the renderer runs in a plain browser during development.
        api()?.getNetworkOptions().then((res: any) => { if (res.ok) setOptions(res.value); });
    }, []);

    async function join(kind: NetworkKind, room?: string) {
        setError(null);
        setJoining(true);
        const problem = await joinNetwork(kind, room);
        if (problem) {
            setError(problem);
            setJoining(false);
        }
    }

    function pick(option: NetworkOption) {
        if (option.needsRoom) { setError(null); setRoomFor(option.kind); }
        else join(option.kind);
    }

    const typed = normalizeRoomCode(code);

    return (
        <div className="boot-screen">

            <header className="boot-header">
                <div className="boot-logo">♟</div>
                <h1>Chess Democracy</h1>
                <p>Where are you playing?</p>
            </header>

            {!roomFor && (
                <div className="boot-card">
                    <h2>Choose a network</h2>
                    <p className="boot-sub">
                        Everyone in a game has to be on the same one.<br />
                        You can switch before pressing Ready.
                    </p>

                    <div className="boot-sides">
                        {options.map(option => (
                            <button
                                key={option.kind}
                                className={`side-btn network-btn network-btn--${option.kind}`}
                                onClick={() => pick(option)}
                                disabled={!option.available || joining}
                            >
                                {joining && !option.needsRoom
                                    ? <span className="btn-spinner" />
                                    : <span className="side-icon">{COPY[option.kind].icon}</span>
                                }
                                <span className="side-label">{COPY[option.kind].label}</span>
                                <span className="side-hint">{option.available ? COPY[option.kind].hint : 'Coming soon'}</span>
                            </button>
                        ))}
                    </div>

                    {error && <p className="boot-error">⚠ {error}</p>}
                </div>
            )}

            {roomFor && (
                <div className="boot-card">
                    <h2>Play over the internet</h2>
                    <p className="boot-sub">
                        Start a game and send the code to your friends,<br />
                        or enter the code someone sent you.
                    </p>

                    <div className="room-options">
                        <button
                            className="enter-btn room-create"
                            onClick={() => join(roomFor, newRoomCode())}
                            disabled={joining}
                        >
                            {joining && !typed ? <span className="btn-spinner" /> : 'Create a game'}
                        </button>

                        <div className="room-divider">or</div>

                        <form
                            className="room-join"
                            onSubmit={e => { e.preventDefault(); if (typed) join(roomFor, typed); }}
                        >
                            <label className="room-label" htmlFor="room-code">Room code</label>
                            <div className="room-join-row">
                                <input
                                    id="room-code"
                                    className="room-input"
                                    value={code}
                                    onChange={e => setCode(e.target.value)}
                                    placeholder="k7mq-x2pd"
                                    autoComplete="off"
                                    spellCheck={false}
                                    disabled={joining}
                                />
                                <button className="back-btn" type="submit" disabled={!typed || joining}>
                                    {joining && typed ? <span className="btn-spinner" /> : 'Join'}
                                </button>
                            </div>
                        </form>
                    </div>

                    {error && <p className="boot-error">⚠ {error}</p>}

                    <button className="change-network-btn" onClick={() => { setRoomFor(null); setError(null); }} disabled={joining}>
                        ← Back
                    </button>
                </div>
            )}

            <button className="network-switch-identity" onClick={() => api().logout()}>
                Use a different identity
            </button>
        </div>
    );
}
