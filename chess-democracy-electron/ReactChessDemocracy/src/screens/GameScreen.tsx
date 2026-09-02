/**
 * GameScreen.tsx
 *
 * Layout:
 *   ┌─────────────────────────────────────────┐
 *   │ header: logo · turn indicator · resign  │
 *   ├───────────────────────┬─────────────────┤
 *   │                       │ opponent info   │
 *   │   chess board         │ move history   │
 *   │                       │ vote panel      │
 *   │                       │ my info         │
 *   └───────────────────────┴─────────────────┘
 *
 * Move submission: players select a move then click "Cast Vote".
 * The tally fires after the vote window closes and applies the winning move.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { Chessboard }            from 'react-chessboard';
import { Chess }                 from 'chess.js';
import { useStore }              from '../store';
import './GameScreen.css';

// ── Promotion picker ──────────────────────────────────────────────────────────

const PROMO_PIECES = ['q', 'r', 'b', 'n'] as const;
type PromoPiece = typeof PROMO_PIECES[number];
const PROMO_LABELS: Record<PromoPiece, string> = { q: '♛ Queen', r: '♜ Rook', b: '♝ Bishop', n: '♞ Knight' };

function PromotionPicker({
    onPick,
    onCancel,
}: { onPick: (piece: PromoPiece) => void; onCancel: () => void }) {
    return (
        <div className="promo-overlay" onClick={onCancel}>
            <div className="promo-picker" onClick={e => e.stopPropagation()}>
                <p className="promo-title">Choose promotion piece</p>
                <div className="promo-choices">
                    {PROMO_PIECES.map(p => (
                        <button key={p} className="promo-btn" onClick={() => onPick(p)}>
                            {PROMO_LABELS[p]}
                        </button>
                    ))}
                </div>
                <button className="promo-cancel" onClick={onCancel}>Cancel</button>
            </div>
        </div>
    );
}

// ── End-game overlay ──────────────────────────────────────────────────────────

const RESULT_LABELS: Record<string, string> = {
    checkmate:         'Checkmate',
    stalemate:         'Stalemate',
    resignation:       'Resignation',
    disconnect:        'Disconnected',
    draw_agreement:    'Draw by agreement',
    revotes_exhausted: 'No consensus — voting exhausted',
    timeout:           'Move timeout — 2 min exceeded',
};

function EndGameOverlay({
    myTeam,
    onRematch,
}: { myTeam: 'white' | 'black' | null; onRematch: () => void }) {
    const result = useStore(s => s.game.result);
    if (!result) return null;

    const won  = result.winner === myTeam;
    const draw = result.winner === 'draw' || result.winner === null;
    const headline = draw ? 'Draw' : won ? 'You won!' : 'You lost';

    return (
        <div className="end-overlay">
            <div className="end-card">
                <div className={`end-headline end-headline--${draw ? 'draw' : won ? 'win' : 'loss'}`}>
                    {headline}
                </div>
                <div className="end-reason">{RESULT_LABELS[result.reason] ?? result.reason}</div>
                <button className="btn-primary end-rematch-btn" onClick={onRematch}>
                    Rematch
                </button>
            </div>
        </div>
    );
}

// ── Move history panel ────────────────────────────────────────────────────────

function MoveHistory() {
    const moveHistory = useStore(s => s.game.moveHistory);

    const pairs: Array<[string, string | null]> = [];
    for (let i = 0; i < moveHistory.length; i += 2) {
        pairs.push([
            moveHistory[i]?.move ?? '',
            moveHistory[i + 1]?.move ?? null,
        ]);
    }

    if (pairs.length === 0) {
        return (
            <div className="move-history move-history--empty">
                <p>No moves yet</p>
            </div>
        );
    }

    return (
        <div className="move-history">
            <div className="move-history-inner">
                {pairs.map(([w, b], idx) => (
                    <div key={idx} className="move-pair">
                        <span className="move-num">{idx + 1}.</span>
                        <span className="move-cell move-cell--white">{uciToAlgebraic(w)}</span>
                        <span className="move-cell move-cell--black">{b ? uciToAlgebraic(b) : ''}</span>
                    </div>
                ))}
            </div>
        </div>
    );
}

function uciToAlgebraic(uci: string): string {
    if (!uci) return '';
    return uci.slice(2, 4) + (uci.length === 5 ? '=' + uci[4].toUpperCase() : '');
}

// ── Player info strip ─────────────────────────────────────────────────────────

function PlayerStrip({
    label, team, isActive,
}: { label: string; team: 'white' | 'black'; isActive: boolean }) {
    return (
        <div className={`player-strip ${isActive ? 'player-strip--active' : ''}`}>
            <span className="player-icon">{team === 'white' ? '♔' : '♚'}</span>
            <span className="player-label">{label}</span>
            {isActive && <span className="turn-pip" />}
        </div>
    );
}

// ── Vote panel ────────────────────────────────────────────────────────────────

function VotePanel() {
    const voting       = useStore(s => s.voting);
    const myTeam       = useStore(s => s.game.myTeam);
    const currentTurn  = useStore(s => s.game.currentTurn);
    const identity     = useStore(s => s.identity);
    const [remaining, setRemaining] = useState<number | null>(null);
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

    useEffect(() => {
        if (!voting) {
            setRemaining(null);
            if (intervalRef.current) clearInterval(intervalRef.current);
            return;
        }

        const update = () => {
            const left = Math.max(0, Math.ceil((voting.windowCloseAt - Date.now()) / 1000));
            setRemaining(left);
        };
        update();
        intervalRef.current = setInterval(update, 500);
        return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
    }, [voting?.windowCloseAt]);

    if (!voting) return null;

    const isMyTeamVoting = currentTurn === myTeam;
    const voteEntries    = Object.entries(voting.currentVotes);
    const myVote         = voting.myVote;

    return (
        <div className="vote-panel">
            {voting.revoteCount > 0 && (
                <div className="revote-banner">
                    ⚠ Re-vote #{voting.revoteCount} — no consensus
                </div>
            )}

            <div className="vote-timer">
                <span className="vote-timer-label">
                    {isMyTeamVoting ? 'Vote window' : `${currentTurn === 'white' ? '♔ White' : '♚ Black'} voting`}
                </span>
                <span className={`vote-timer-value ${remaining !== null && remaining <= 10 ? 'vote-timer-value--urgent' : ''}`}>
                    {remaining !== null ? `${remaining}s` : '…'}
                </span>
            </div>

            {isMyTeamVoting && !myVote && (
                <p className="vote-hint">Select a move on the board, then cast your vote.</p>
            )}
            {myVote && (
                <div className="my-vote">
                    ✓ Voted: <strong>{myVote}</strong>
                </div>
            )}

            <div className="votes-list">
                <div className="votes-list-title">
                    Votes ({voteEntries.length})
                </div>
                {voteEntries.length === 0 ? (
                    <p className="votes-empty">No votes yet</p>
                ) : (
                    voteEntries.map(([peerId, move]) => {
                        const isSelf = peerId === identity?.publicKey;
                        return (
                            <div key={peerId} className="vote-entry">
                                <span className="voter-id">
                                    {peerId.slice(0, 8)}…{isSelf ? ' (you)' : ''}
                                </span>
                                <span className="voted-move">{move}</span>
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
}

// ── Main screen ───────────────────────────────────────────────────────────────

export default function GameScreen() {
    const fen           = useStore(s => s.game.fen);
    const legalMoves    = useStore(s => s.game.legalMoves);
    const isMyTurn      = useStore(s => s.game.isMyTurn);
    const myTeam        = useStore(s => s.game.myTeam);
    const currentTurn   = useStore(s => s.game.currentTurn);
    const identity      = useStore(s => s.identity);
    const voting        = useStore(s => s.voting);
    const resignVote    = useStore(s => s.resignVote);
    const phase         = useStore(s => s.game.phase);
    const setNotification = useStore(s => s.setNotification);

    const [voting_move,   setVotingMove]   = useState<string | null>(null);
    const [castingVote,   setCastingVote]  = useState(false);
    const [selectedSq,    setSelectedSq]   = useState<string | null>(null);
    const [highlightSqs,  setHighlightSqs] = useState<Record<string, object>>({});
    const [promoPending,  setPromoPending] = useState<{ from: string; to: string } | null>(null);
    const [drawOffered,   setDrawOffered]  = useState(false);
    const [drawSent,      setDrawSent]     = useState(false);

    const opponentTeam      = myTeam === 'white' ? 'black' : 'white';
    const boardOrientation  = myTeam === 'black' ? 'black' : 'white';
    const isVotingOpen      = !!voting;
    // Use voting.isMyTurn (authoritative — set directly from node event) rather
    // than game.isMyTurn which may not be updated yet when the window opens.
    const isMyVotingTurn    = isVotingOpen && !!(voting?.isMyTurn);
    const alreadyVoted      = !!voting?.myVote;

    // Draw offer subscriptions
    useEffect(() => {
        const api = (window as any).chessHive;
        const unsub1 = api.on.drawOffered((d: any) => {
            if (!d.fromSelf) setDrawOffered(true);
        });
        const unsub2 = api.on.drawDeclined((_d: any) => {
            setDrawSent(false);
            setNotification({ type: 'error', message: 'Draw offer declined' });
        });
        return () => { unsub1(); unsub2(); };
    }, []);

    // Clear draw UI when game ends or resets
    useEffect(() => {
        if (phase !== 'in_progress') {
            setDrawOffered(false);
            setDrawSent(false);
        }
    }, [phase]);

    // Log voting state changes + reset selection on new window
    useEffect(() => {
        console.log('[VOTE] voting state changed:', { voting, isMyTurn, isMyVotingTurn: isMyTurn && !!voting, myTeam, phase });
        setVotingMove(null);
        setSelectedSq(null);
        setHighlightSqs({});
        setCastingVote(false);
    }, [voting?.turnIndex]);

    const legalDests = useCallback((square: string): string[] => {
        return legalMoves
            .filter(m => m.startsWith(square))
            .map(m => m.slice(2, 4));
    }, [legalMoves]);

    // react-chessboard v5: onSquareClick receives { piece, square }
    function onSquareClick({ square }: { piece: unknown; square: string }) {
        console.log('[VOTE] onSquareClick', square, { isMyVotingTurn, alreadyVoted, castingVote, selectedSq, legalMovesCount: legalMoves.length });
        if (!isMyVotingTurn || alreadyVoted || castingVote) {
            console.log('[VOTE] click blocked —', { isMyVotingTurn, alreadyVoted, castingVote });
            return;
        }

        if (selectedSq) {
            if (selectedSq === square) {
                setSelectedSq(null); setHighlightSqs({}); setVotingMove(null);
                return;
            }
            if (legalDests(selectedSq).includes(square)) {
                if (isPromotionMove(fen, selectedSq, square)) {
                    setPromoPending({ from: selectedSq, to: square });
                    setSelectedSq(null); setHighlightSqs({});
                } else {
                    const move = selectedSq + square;
                    console.log('[VOTE] move selected via click:', move);
                    setVotingMove(move);
                    setSelectedSq(null);
                    setHighlightSqs({ [selectedSq]: { backgroundColor: 'rgba(124,106,247,0.35)' }, [square]: { backgroundColor: 'rgba(80,200,120,0.45)' } });
                }
                return;
            }
            const dests = legalDests(square);
            if (dests.length > 0) {
                setSelectedSq(square); setHighlightSqs(buildHighlights(square, dests)); setVotingMove(null);
            } else {
                setSelectedSq(null); setHighlightSqs({}); setVotingMove(null);
            }
        } else {
            const dests = legalDests(square);
            console.log('[VOTE] piece selected:', square, 'legal dests:', dests);
            if (dests.length > 0) {
                setSelectedSq(square);
                setHighlightSqs(buildHighlights(square, dests));
            }
        }
    }

    // react-chessboard v5: onPieceDrop receives { piece, sourceSquare, targetSquare }
    function onPieceDrop({ sourceSquare: from, targetSquare: to }: { piece: unknown; sourceSquare: string; targetSquare: string | null }): boolean {
        console.log('[VOTE] onPieceDrop', from, '->', to, { isMyVotingTurn, alreadyVoted, castingVote });
        if (!to || !isMyVotingTurn || alreadyVoted || castingVote) {
            console.log('[VOTE] drop blocked');
            return false;
        }
        const dests = legalDests(from);
        if (!dests.includes(to)) {
            console.log('[VOTE] drop illegal — dests for', from, ':', dests);
            return false;
        }
        if (isPromotionMove(fen, from, to)) {
            setPromoPending({ from, to });
        } else {
            const move = from + to;
            console.log('[VOTE] move selected via drop:', move);
            setVotingMove(move);
            setHighlightSqs({ [from]: { backgroundColor: 'rgba(124,106,247,0.35)' }, [to]: { backgroundColor: 'rgba(80,200,120,0.45)' } });
        }
        setSelectedSq(null);
        return false;
    }

    function handlePromoPick(piece: PromoPiece) {
        if (!promoPending) return;
        const uci = promoPending.from + promoPending.to + piece;
        setVotingMove(uci);
        setHighlightSqs({ [promoPending.from]: { backgroundColor: 'rgba(124,106,247,0.35)' }, [promoPending.to]: { backgroundColor: 'rgba(80,200,120,0.45)' } });
        setPromoPending(null);
    }

    async function handleRematch() {
        try {
            await (window as any).chessHive.resetGame();
        } catch {
            setNotification({ type: 'error', message: 'Failed to reset game' });
        }
    }

    async function handleCastVote() {
        console.log('[VOTE] handleCastVote called', { voting_move, castingVote, alreadyVoted });
        if (!voting_move || castingVote || alreadyVoted) return;
        setCastingVote(true);
        try {
            const api = (window as any).chessHive;
            console.log('[VOTE] calling api.castVote with:', voting_move);
            const res = await api.castVote(voting_move);
            console.log('[VOTE] castVote result:', res);
            if (!res.ok) {
                setNotification({ type: 'error', message: `Vote rejected: ${res.error}` });
                setVotingMove(null);
            }
        } catch (err) {
            console.error('[VOTE] castVote exception:', err);
            setNotification({ type: 'error', message: 'Failed to cast vote' });
        } finally {
            setCastingVote(false);
        }
    }

    async function handleResign() {
        try {
            const res = await (window as any).chessHive.resign();
            if (!res.ok) {
                if (res.error !== 'error:already_voted') {
                    setNotification({ type: 'error', message: `Resign vote failed: ${res.error}` });
                }
            }
        } catch {
            setNotification({ type: 'error', message: 'Failed to cast resign vote' });
        }
    }

    async function handleOfferDraw() {
        if (drawSent) return;
        setDrawSent(true);
        try {
            const res = await (window as any).chessHive.offerDraw();
            if (!res.ok) {
                setDrawSent(false);
                setNotification({ type: 'error', message: `Draw offer failed: ${res.error}` });
            }
        } catch {
            setDrawSent(false);
            setNotification({ type: 'error', message: 'Failed to offer draw' });
        }
    }

    async function handleDrawResponse(accept: boolean) {
        setDrawOffered(false);
        try {
            await (window as any).chessHive.respondToDraw(accept);
        } catch {
            setNotification({ type: 'error', message: 'Failed to respond to draw offer' });
        }
    }

    return (
        <div className="game-screen">

            {/* ── Promotion picker ─────────────────────────────────────────── */}
            {promoPending && (
                <PromotionPicker
                    onPick={handlePromoPick}
                    onCancel={() => setPromoPending(null)}
                />
            )}

            {/* ── End game overlay ─────────────────────────────────────────── */}
            {phase === 'finished' && (
                <EndGameOverlay myTeam={myTeam} onRematch={handleRematch} />
            )}

            {/* ── Draw offer banner ────────────────────────────────────────── */}
            {drawOffered && (
                <div className="draw-offer-banner">
                    <span>Opponent offers a draw</span>
                    <button className="btn-primary draw-accept-btn" onClick={() => handleDrawResponse(true)}>Accept</button>
                    <button className="btn-danger  draw-decline-btn" onClick={() => handleDrawResponse(false)}>Decline</button>
                </div>
            )}

            {/* ── Resign vote banner ───────────────────────────────────────── */}
            {resignVote && (
                <div className="resign-vote-banner">
                    <span className="resign-vote-label">
                        Resign vote: <strong>{resignVote.yesVotes}</strong> / {resignVote.connectedTeamSize} voted yes
                    </span>
                    <span className="resign-vote-threshold">
                        (need ≥ {Math.ceil(resignVote.connectedTeamSize * 0.67)} votes)
                    </span>
                </div>
            )}

            {/* ── Header ──────────────────────────────────────────────────── */}
            <header className="game-header">
                <div className="game-logo">♟ Chess Democracy</div>

                <div className="turn-indicator">
                    <div className={`turn-dot turn-dot--${currentTurn}`} />
                    <span>
                        {isMyVotingTurn
                            ? 'Your turn — cast a vote'
                            : isVotingOpen
                                ? `${currentTurn === 'white' ? '♔ White' : '♚ Black'} is voting…`
                                : isMyTurn
                                    ? 'Your turn'
                                    : `${currentTurn === 'white' ? '♔ White' : '♚ Black'}'s turn`
                        }
                    </span>
                </div>

                <button
                    className="btn-secondary offer-draw-btn"
                    onClick={handleOfferDraw}
                    disabled={drawSent || phase !== 'in_progress'}
                    title={drawSent ? 'Draw offer sent' : 'Offer a draw'}
                >
                    {drawSent ? 'Draw sent…' : '½ Offer Draw'}
                </button>

                <button
                    className="btn-danger resign-btn"
                    onClick={handleResign}
                    disabled={resignVote?.selfVoted || phase !== 'in_progress'}
                    title={resignVote?.selfVoted ? 'You already voted to resign' : 'Vote to resign'}
                >
                    {resignVote?.selfVoted ? 'Voted ✓' : resignVote ? 'Resign (vote open)' : 'Resign'}
                </button>
            </header>

            {/* ── Body ────────────────────────────────────────────────────── */}
            <div className="game-body">

                {/* ── Board ───────────────────────────────────────────────── */}
                <div className={`board-wrap ${castingVote ? 'board-wrap--busy' : ''}`}>
                    <Chessboard options={{
                        position:         fen,
                        boardOrientation: boardOrientation,
                        onSquareClick:    onSquareClick,
                        onPieceDrop:      onPieceDrop,
                        squareStyles:     highlightSqs,
                        allowDragging:    isMyVotingTurn && !alreadyVoted && !castingVote,
                        darkSquareStyle:  { backgroundColor: 'var(--black-sq)' },
                        lightSquareStyle: { backgroundColor: 'var(--white-sq)' },
                        boardStyle:       { borderRadius: '8px', boxShadow: '0 8px 32px #0008' },
                    }} />
                    {castingVote && (
                        <div className="board-overlay">
                            <div className="spinner" />
                        </div>
                    )}
                </div>

                {/* ── Side panel ──────────────────────────────────────────── */}
                <aside className="game-panel">

                    <PlayerStrip
                        label={`${opponentTeam === 'white' ? '♔ White' : '♚ Black'} (opponent)`}
                        team={opponentTeam}
                        isActive={currentTurn === opponentTeam}
                    />

                    <div className="panel-section">
                        <h3 className="panel-title">Moves</h3>
                        <MoveHistory />
                    </div>

                    {/* Vote panel — shown when a voting window is active */}
                    <VotePanel />

                    {/* Cast Vote button */}
                    {isMyVotingTurn && !alreadyVoted && (
                        <div className="vote-action">
                            {voting_move ? (
                                <button
                                    className="btn-primary cast-vote-btn"
                                    onClick={handleCastVote}
                                    disabled={castingVote}
                                >
                                    {castingVote
                                        ? <><span className="btn-spinner" /> Voting…</>
                                        : <>Cast vote: <strong>{voting_move}</strong></>
                                    }
                                </button>
                            ) : (
                                <p className="vote-select-hint">Click a piece to select your move</p>
                            )}
                        </div>
                    )}

                    <PlayerStrip
                        label={`${myTeam === 'white' ? '♔ White' : '♚ Black'} (you · ${identity?.publicKey.slice(0, 8)}…)`}
                        team={myTeam ?? 'white'}
                        isActive={isMyTurn}
                    />

                </aside>
            </div>
        </div>
    );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildHighlights(from: string, dests: string[]): Record<string, object> {
    const result: Record<string, object> = {
        [from]: { backgroundColor: 'rgba(124,106,247,0.35)' },
    };
    for (const sq of dests) {
        result[sq] = {
            background: 'radial-gradient(circle, rgba(124,106,247,0.55) 30%, transparent 31%)',
        };
    }
    return result;
}

function isPromotionMove(fen: string, from: string, to: string): boolean {
    try {
        const chess = new Chess(fen);
        const piece = chess.get(from as any);
        if (!piece || piece.type !== 'p') return false;
        const toRank = parseInt(to[1]);
        return (piece.color === 'w' && toRank === 8) ||
               (piece.color === 'b' && toRank === 1);
    } catch {
        return false;
    }
}
