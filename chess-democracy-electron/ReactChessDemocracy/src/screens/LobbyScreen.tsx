
import { useState }  from 'react';
import { useStore }  from '../store';
import type { Team, PeerSummary } from '../ipc-types';
import './LobbyScreen.css';

const MIN_WINDOW_SECS  = 5;
const MAX_WINDOW_SECS  = 120;
const MIN_RESIGN_PCT   = 50;   // 50% minimum threshold
const MAX_RESIGN_PCT   = 100;
const MIN_RESIGN_SECS  = 10;
const MAX_RESIGN_SECS  = 300;


function TeamBadge({ team }: { team: Team | null }) {
    if (!team) return <span className="badge badge--unknown">?</span>;
    return (
        <span className={`badge badge--${team}`}>
            {team === 'white' ? '♔ White' : '♚ Black'}
        </span>
    );
}

function PeerRow({ peer }: { peer: PeerSummary }) {
    const shortId = peer.peerId.slice(0, 8) + '…';
    return (
        <div className={`peer-row ${peer.status === 'dead' ? 'peer-row--dead' : ''}`}>
            <div className="peer-id" title={peer.peerId}>{shortId}</div>
            <TeamBadge team={peer.team} />
            <div className={`peer-ready ${peer.ready ? 'peer-ready--yes' : ''}`}>
                {peer.ready ? '✓ Ready' : 'Waiting'}
            </div>
        </div>
    );
}

function CountdownBanner({ ms }: { ms: number | null }) {
    if (ms === null) return null;
    const secs = Math.max(0, Math.ceil(ms / 1000));
    return (
        <div className="countdown-banner">
            <div className="countdown-ring">
                <span className="countdown-num">{secs}</span>
            </div>
            <p>Game starting…</p>
        </div>
    );
}

function SideWarning({ whites, blacks, waitingFor }:
    { whites: number; blacks: number; waitingFor: Team }) {
    return (
        <div className="side-warning">
            <span className="side-warning-icon">⚠</span>
            <span>
                Need at least one <strong>{waitingFor}</strong> player to start.
                Currently: <strong>{whites} white</strong>, <strong>{blacks} black</strong>.
            </span>
        </div>
    );
}


export default function LobbyScreen() {
    const phase           = useStore(s => s.game.phase);
    const myTeam          = useStore(s => s.game.myTeam);
    const identity        = useStore(s => s.identity);
    const peers           = useStore(s => s.peers);
    const sideBalance     = useStore(s => s.sideBalance);
    const countdownMs     = useStore(s => s.game.countdownMs);
    const config          = useStore(s => s.config);
    const applySnapshot      = useStore(s => s.applySnapshot);
    const applyConfigSnapshot = useStore(s => s.applyConfigSnapshot);
    const setSelfAccepted     = useStore(s => s.setSelfAcceptedConfig);
    const setNotification     = useStore(s => s.setNotification);

    const [readying,       setReadying]      = useState(false);
    const [switching,      setSwitching]     = useState<Team | null>(null);
    const [proposing,      setProposing]     = useState(false);
    const [accepting,      setAccepting]     = useState(false);
    const [voteWindowSecs,   setVoteWindowSecs]   = useState(() => Math.round(config.voteWindowMs / 1000));
    const [maxRevotes,       setMaxRevotes]       = useState(() => config.maxRevotes);
    const [resignThreshPct,  setResignThreshPct]  = useState(() => Math.round(config.resignThreshold * 100));
    const [resignWindowSecs, setResignWindowSecs] = useState(() => Math.round(config.resignWindowMs / 1000));

    const isReadied  = phase === 'waiting_for_peers' || phase === 'starting';
    const isStarting = phase === 'starting';
    const canSwitch  = phase === 'waiting_for_ready';
    const canConfig  = phase === 'waiting_for_side' || phase === 'waiting_for_ready';

    const allAccepted = config.selfAccepted &&
        peers.every(p => config.peerAcceptedIds.includes(p.peerId));

    const whites = peers.filter(p => p.team === 'white').length + (myTeam === 'white' ? 1 : 0);
    const blacks  = peers.filter(p => p.team === 'black').length + (myTeam === 'black' ? 1 : 0);
    const total   = peers.length + 1; // +1 = this node

    async function handleProposeConfig() {
        if (proposing || !canConfig) return;
        const vms              = voteWindowSecs * 1000;
        const resignThreshold  = resignThreshPct / 100;
        const resignWindowMs   = resignWindowSecs * 1000;
        setProposing(true);
        try {
            const api = (window as any).chessHive;
            const res = await api.setConfig(vms, maxRevotes, resignThreshold, resignWindowMs);
            if (!res.ok) {
                setNotification({ type: 'error', message: res.error });
                return;
            }
            const cfgRes = await api.getConfig();
            if (cfgRes.ok) applyConfigSnapshot(cfgRes.value);
            // Mark self accepted since we're the proposer
            setSelfAccepted(config.version + 1);
        } catch {
            setNotification({ type: 'error', message: 'Failed to propose config' });
        } finally {
            setProposing(false);
        }
    }

    async function handleAcceptConfig() {
        if (accepting || !canConfig) return;
        setAccepting(true);
        try {
            const api = (window as any).chessHive;
            const res = await api.acceptConfig();
            if (!res.ok) {
                setNotification({ type: 'error', message: res.error });
                return;
            }
            setSelfAccepted(config.version);
        } catch {
            setNotification({ type: 'error', message: 'Failed to accept config' });
        } finally {
            setAccepting(false);
        }
    }

    async function handleSwitchSide(team: Team) {
        if (switching || myTeam === team) return;
        setSwitching(team);
        try {
            const api = (window as any).chessHive;
            const res = await api.setTeam(team);
            if (!res.ok) {
                setNotification({ type: 'error', message: res.error });
                setSwitching(null);
                return;
            }
            const stateRes = await api.getState();
            if (stateRes.ok) applySnapshot(stateRes.value);
        } catch {
            setNotification({ type: 'error', message: 'Failed to switch side' });
        } finally {
            setSwitching(null);
        }
    }

    async function handleReady() {
        if (isReadied || readying) return;
        setReadying(true);
        try {
            const api = (window as any).chessHive;
            const res = await api.ready();
            if (!res.ok) {
                setNotification({ type: 'error', message: res.error });
                setReadying(false);
                return;
            }
            const stateRes = await api.getState();
            if (stateRes.ok) applySnapshot(stateRes.value);
            setReadying(false);
        } catch {
            setNotification({ type: 'error', message: 'Failed to signal ready' });
            setReadying(false);
        }
    }

    async function handleUnready() {
        setReadying(false); // clear any leftover spinner state
        try {
            const api = (window as any).chessHive;
            const res = await api.unready();
            if (!res.ok) {
                setNotification({ type: 'error', message: res.error });
                return;
            }
            const stateRes = await api.getState();
            if (stateRes.ok) applySnapshot(stateRes.value);
        } catch {
            setNotification({ type: 'error', message: 'Failed to cancel ready' });
        }
    }

    return (
        <div className="lobby-screen">

            {/* ── Identity bar ───────────────────────────────────────────── */}
            <header className="lobby-header">
                <div className="lobby-title">
                    <span className="lobby-logo">♟</span>
                    <h1>Chess Democracy</h1>
                </div>
                <div className="lobby-identity">
                    <span className="lobby-key" title={identity?.publicKey}>
                        {identity?.publicKey.slice(0, 12)}…
                    </span>
                    <TeamBadge team={myTeam} />
                    <button
                        className="logout-btn"
                        title="Switch identity"
                        onClick={async () => {
                            await (window as any).chessHive.logout();
                        }}
                    >
                        ⏏
                    </button>
                </div>
            </header>

            <main className="lobby-main">

                {/* ── Countdown (starting phase only) ────────────────────── */}
                {isStarting && <CountdownBanner ms={countdownMs} />}

                {/* ── Peer list ───────────────────────────────────────────── */}
                <section className="peer-section">
                    <div className="peer-section-title">
                        <h3>Players on network</h3>
                        <span className="peer-count">{total} connected</span>
                    </div>

                    {/* This node row */}
                    <div className="peer-row peer-row--self">
                        <div className="peer-id">
                            {identity?.publicKey.slice(0, 8)}… <span className="you-tag">you</span>
                        </div>
                        <TeamBadge team={myTeam} />
                        <div className={`peer-ready ${isReadied ? 'peer-ready--yes' : ''}`}>
                            {isReadied ? '✓ Ready' : 'Not ready'}
                        </div>
                    </div>

                    {peers.length === 0 ? (
                        <div className="peer-empty">
                            <div className="spinner" style={{ width: 20, height: 20, borderWidth: 2 }} />
                            <span>Discovering peers…</span>
                        </div>
                    ) : (
                        peers.map(p => <PeerRow key={p.peerId} peer={p} />)
                    )}

                    {/* Team tally */}
                    <div className="team-tally">
                        <span className="tally-white">♔ White: {whites}</span>
                        <span className="tally-divider">·</span>
                        <span className="tally-black">♚ Black: {blacks}</span>
                    </div>
                </section>

                {/* ── Side balance warning ─────────────────────────────────── */}
                {sideBalance && !isStarting && (
                    <SideWarning
                        whites={sideBalance.whites}
                        blacks={sideBalance.blacks}
                        waitingFor={sideBalance.waitingFor}
                    />
                )}

                {/* ── Side switcher (only before pressing Ready) ──────────── */}
                {canSwitch && (
                    <section className="side-switch-section">
                        <p className="side-switch-label">Switch side:</p>
                        <div className="boot-sides">
                            <button
                                className={`side-btn side-btn--white ${myTeam === 'white' ? 'side-btn--active' : ''}`}
                                onClick={() => handleSwitchSide('white')}
                                disabled={switching !== null || myTeam === 'white'}
                            >
                                {switching === 'white'
                                    ? <span className="btn-spinner" />
                                    : <span className="side-icon">♔</span>
                                }
                                <span className="side-label">White</span>
                            </button>
                            <div className="side-divider">vs</div>
                            <button
                                className={`side-btn side-btn--black ${myTeam === 'black' ? 'side-btn--active' : ''}`}
                                onClick={() => handleSwitchSide('black')}
                                disabled={switching !== null || myTeam === 'black'}
                            >
                                {switching === 'black'
                                    ? <span className="btn-spinner" />
                                    : <span className="side-icon">♚</span>
                                }
                                <span className="side-label">Black</span>
                            </button>
                        </div>
                    </section>
                )}

                {/* ── Config panel ─────────────────────────────────────────── */}
                {canConfig && (
                    <section className="config-section">
                        <div className="config-header">
                            <h3>Vote Config</h3>
                            <span className={`config-status ${allAccepted ? 'config-status--ok' : 'config-status--pending'}`}>
                                {allAccepted ? '✓ All accepted' : '⏳ Waiting for acceptance'}
                            </span>
                        </div>

                        <div className="config-inputs">
                            <label className="config-label">
                                <span>Vote window</span>
                                <div className="config-input-row">
                                    <input
                                        type="number"
                                        min={MIN_WINDOW_SECS}
                                        max={MAX_WINDOW_SECS}
                                        value={voteWindowSecs}
                                        onChange={e => setVoteWindowSecs(Math.max(MIN_WINDOW_SECS, Math.min(MAX_WINDOW_SECS, Number(e.target.value))))}
                                        className="config-input"
                                    />
                                    <span className="config-unit">seconds</span>
                                </div>
                            </label>
                            <label className="config-label">
                                <span>Max re-votes</span>
                                <div className="config-input-row">
                                    <input
                                        type="number"
                                        min={0}
                                        max={10}
                                        value={maxRevotes}
                                        onChange={e => setMaxRevotes(Math.max(0, Math.min(10, Number(e.target.value))))}
                                        className="config-input"
                                    />
                                </div>
                            </label>
                            <label className="config-label">
                                <span>Resign threshold</span>
                                <div className="config-input-row">
                                    <input
                                        type="number"
                                        min={MIN_RESIGN_PCT}
                                        max={MAX_RESIGN_PCT}
                                        step={5}
                                        value={resignThreshPct}
                                        onChange={e => setResignThreshPct(Math.max(MIN_RESIGN_PCT, Math.min(MAX_RESIGN_PCT, Number(e.target.value))))}
                                        className="config-input"
                                    />
                                    <span className="config-unit">%</span>
                                </div>
                            </label>
                            <label className="config-label">
                                <span>Resign window</span>
                                <div className="config-input-row">
                                    <input
                                        type="number"
                                        min={MIN_RESIGN_SECS}
                                        max={MAX_RESIGN_SECS}
                                        step={10}
                                        value={resignWindowSecs}
                                        onChange={e => setResignWindowSecs(Math.max(MIN_RESIGN_SECS, Math.min(MAX_RESIGN_SECS, Number(e.target.value))))}
                                        className="config-input"
                                    />
                                    <span className="config-unit">seconds</span>
                                </div>
                            </label>
                        </div>

                        <div className="config-actions">
                            <button
                                className="btn-secondary"
                                onClick={handleProposeConfig}
                                disabled={proposing}
                            >
                                {proposing ? <><span className="btn-spinner" /> Proposing…</> : 'Propose Config'}
                            </button>

                            {!config.selfAccepted && (
                                <button
                                    className="btn-primary"
                                    onClick={handleAcceptConfig}
                                    disabled={accepting}
                                >
                                    {accepting ? <><span className="btn-spinner" /> Accepting…</> : 'Accept Config'}
                                </button>
                            )}
                        </div>

                        {/* Per-peer acceptance status */}
                        <div className="config-peers">
                            <div className={`config-peer-row ${config.selfAccepted ? 'config-peer-row--ok' : ''}`}>
                                <span className="config-peer-id">{identity?.publicKey.slice(0, 8)}… (you)</span>
                                <span>{config.selfAccepted ? '✓' : '⏳'}</span>
                            </div>
                            {peers.map(p => {
                                const accepted = config.peerAcceptedIds.includes(p.peerId);
                                return (
                                    <div key={p.peerId} className={`config-peer-row ${accepted ? 'config-peer-row--ok' : ''}`}>
                                        <span className="config-peer-id">{p.peerId.slice(0, 8)}…</span>
                                        <span>{accepted ? '✓' : '⏳'}</span>
                                    </div>
                                );
                            })}
                        </div>
                    </section>
                )}

                {/* ── Ready / Unready buttons ──────────────────────────────── */}
                {!isStarting && (
                    phase === 'waiting_for_peers'
                        ? (
                            <button
                                className="ready-btn ready-btn--cancel"
                                onClick={handleUnready}
                            >
                                ✕ Cancel ready
                            </button>
                        ) : (
                            <button
                                className={`ready-btn ${isReadied ? 'ready-btn--done' : 'btn-primary'}`}
                                onClick={handleReady}
                                disabled={isReadied || readying}
                            >
                                {readying
                                    ? <><span className="btn-spinner" /> Signalling…</>
                                    : 'Ready to play'
                                }
                            </button>
                        )
                )}

                <p className="lobby-hint">
                    {isStarting
                        ? 'All players ready. Game is about to begin!'
                        : isReadied
                            ? 'Waiting for all peers to signal ready…'
                            : !allAccepted
                                ? 'All players must accept the vote config before readying.'
                                : 'Press Ready when you want to start. All peers must press Ready.'
                    }
                </p>

            </main>
        </div>
    );
}
