/**
 * NetworkScreen.tsx
 *
 * Shown after login, before choosing a side: where does this game happen?
 * Nothing connects until the player picks. The list comes from the core, so a
 * network shows up as playable as soon as it's marked available there.
 *
 * Playing over the internet needs a room code, since there's no "same Wi-Fi"
 * to find each other by. A public game is also listed here for anyone to
 * join; a private one is only reachable with its code.
 */

import { useEffect, useState } from 'react';
import { joinNetwork, browsePublicGames } from '../useChessDemocracy';
import { newRoomCode, normalizeRoomCode } from '../roomCode';
import type { NetworkKind, NetworkOption, PublicGame, Visibility } from '../ipc-types';
import { ipc, bridge } from '../bridge';
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
    const [games,    setGames]    = useState<PublicGame[]>([]);
    const [browsing, setBrowsing] = useState(false);
    const [browseError, setBrowseError] = useState<string | null>(null);

    useEffect(() => {
        // Missing when the renderer runs in a plain browser during development.
        ipc()?.getNetworkOptions().then(res => { if (res.ok) setOptions(res.value); });
    }, []);

    async function refresh() {
        setBrowsing(true);
        setBrowseError(null);
        const found = await browsePublicGames();
        setGames(found.games);
        setBrowseError(found.error);
        setBrowsing(false);
    }

    // Look for public games as soon as the internet step opens.
    useEffect(() => { if (roomFor) refresh(); }, [roomFor]);

    async function join(kind: NetworkKind, room?: string, visibility?: Visibility) {
        setError(null);
        setJoining(true);
        const problem = await joinNetwork(kind, room, visibility);
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
                <div className="boot-card room-card">
                    <div className="room-card-head">
                        <button className="change-network-btn" onClick={() => { setRoomFor(null); setError(null); }} disabled={joining}>
                            ← Back
                        </button>
                        <h2>Play over the internet</h2>
                    </div>

                    <div className="room-columns">
                        <section className="room-public" aria-labelledby="public-games-title">
                            <div className="room-section-head">
                                <h3 id="public-games-title">Public games</h3>
                                <button className="change-network-btn" onClick={refresh} disabled={browsing || joining}>
                                    {browsing ? 'Looking…' : 'Refresh'}
                                </button>
                            </div>

                            <ul className="public-list" aria-busy={browsing}>
                                {games.length === 0 && (
                                    <li className="public-empty">
                                        {browsing
                                            ? 'Looking for games…'
                                            : <>No public games right now.<br />Start one and it shows up here for everyone.</>}
                                    </li>
                                )}
                                {games.map(game => (
                                    <li key={game.room} className="public-game">
                                        <div className="public-game-info">
                                            <span className="public-game-players">
                                                {game.players} {game.players === 1 ? 'player' : 'players'}
                                            </span>
                                            <span className="public-game-sides">
                                                <span className="side-dot side-dot--white" />{game.whites}
                                                <span className="side-dot side-dot--black" />{game.blacks}
                                            </span>
                                        </div>
                                        <code className="public-game-room">{game.room}</code>
                                        <button
                                            className="public-game-join"
                                            onClick={() => join(roomFor, game.room, 'public')}
                                            disabled={joining}
                                        >
                                            Join
                                        </button>
                                    </li>
                                ))}
                            </ul>
                            {browseError && <p className="boot-error">⚠ {browseError}</p>}
                        </section>

                        <section className="room-side">
                            <div className="room-block">
                                <h3>Start a game</h3>
                                <div className="room-start">
                                    <button className="enter-btn" onClick={() => join(roomFor, newRoomCode(), 'public')} disabled={joining}>
                                        Public
                                    </button>
                                    <button className="back-btn" onClick={() => join(roomFor, newRoomCode(), 'private')} disabled={joining}>
                                        Private
                                    </button>
                                </div>
                                <p className="room-hint">Public games are listed for anyone. Private ones need the code.</p>
                            </div>

                            <form
                                className="room-block"
                                onSubmit={e => { e.preventDefault(); if (typed) join(roomFor, typed, 'private'); }}
                            >
                                <label htmlFor="room-code"><h3>Join with a code</h3></label>
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
                                    <button className="back-btn" type="submit" disabled={!typed || joining}>Join</button>
                                </div>
                            </form>
                        </section>
                    </div>

                    {joining && <p className="room-hint room-connecting"><span className="btn-spinner" /> Connecting…</p>}
                    {error && <p className="boot-error">⚠ {error}</p>}
                </div>
            )}

            <button className="network-switch-identity" onClick={() => bridge().logout()}>
                Use a different identity
            </button>
        </div>
    );
}
