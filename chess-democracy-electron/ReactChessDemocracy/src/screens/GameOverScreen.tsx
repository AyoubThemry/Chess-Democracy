/**
 * GameOverScreen.tsx — Task 5
 *
 * Shows the result, the final board position, and a button to return to lobby.
 */

import { Chessboard } from 'react-chessboard';
import { useStore }   from '../store';
import './GameOverScreen.css';

function resultLabel(winner: string | null, reason: string, myTeam: string | null): {
    headline: string;
    sub: string;
    isWin: boolean | null;
} {
    const isWin  = winner === myTeam;
    const isDraw = winner === 'draw';

    let headline = '';
    let sub      = '';

    if (isDraw) {
        headline = 'Draw';
        sub      = reason === 'stalemate'          ? 'Stalemate'
                 : reason === 'draw_agreement'     ? 'Draw agreed'
                 : reason === 'revotes_exhausted'  ? 'Voting exhausted — no consensus'
                 : reason === 'timeout'            ? 'Move timeout'
                 : 'Draw';
    } else if (isWin) {
        headline = 'You won!';
        sub      = reason === 'checkmate'   ? 'By checkmate'
                 : reason === 'resignation' ? 'Opponent resigned'
                 : reason === 'disconnect'  ? 'Opponent disconnected'
                 : 'Game over';
    } else {
        headline = 'You lost';
        sub      = reason === 'checkmate'   ? 'By checkmate'
                 : reason === 'resignation' ? 'You resigned'
                 : reason === 'disconnect'  ? 'Connection lost'
                 : 'Game over';
    }

    return { headline, sub, isWin: isDraw ? null : isWin };
}

export default function GameOverScreen() {
    const game     = useStore(s => s.game);
    const myTeam   = game.myTeam;
    const result   = game.result;
    const resetGame = useStore(s => s.resetGame);

    const { headline, sub, isWin } = result
        ? resultLabel(result.winner as string, result.reason, myTeam)
        : { headline: 'Game Over', sub: '', isWin: null };

    const resultClass = isWin === null ? 'result--draw'
                      : isWin         ? 'result--win'
                                      : 'result--loss';

    async function handlePlayAgain() {
        await (window as any).chessHive.resetGame();
        resetGame();
    }

    return (
        <div className="gameover-screen">

            <header className="gameover-header">
                <span className="game-logo">♟ Chess Democracy</span>
            </header>

            <main className="gameover-main">

                {/* ── Result banner ────────────────────────────────────────── */}
                <div className={`result-banner ${resultClass}`}>
                    <div className="result-icon">
                        {isWin === null ? '🤝' : isWin ? '🏆' : '💀'}
                    </div>
                    <h1 className="result-headline">{headline}</h1>
                    <p  className="result-sub">{sub}</p>
                </div>

                {/* ── Final board ──────────────────────────────────────────── */}
                <div className="gameover-board">
                    <Chessboard options={{
                        position:         game.fen,
                        boardOrientation: myTeam === 'black' ? 'black' : 'white',
                        darkSquareStyle:  { backgroundColor: 'var(--black-sq)' },
                        lightSquareStyle: { backgroundColor: 'var(--white-sq)' },
                        boardStyle: {
                            borderRadius: '8px',
                            boxShadow: '0 8px 32px #0008',
                            opacity: 0.85,
                        },
                    }} />
                </div>

                {/* ── Stats ───────────────────────────────────────────────── */}
                <div className="gameover-stats">
                    <div className="stat">
                        <span className="stat-label">Moves played</span>
                        <span className="stat-value">{game.moveHistory.length}</span>
                    </div>
                    <div className="stat">
                        <span className="stat-label">Your side</span>
                        <span className="stat-value">
                            {myTeam === 'white' ? '♔ White' : '♚ Black'}
                        </span>
                    </div>
                    <div className="stat">
                        <span className="stat-label">Game ID</span>
                        <span className="stat-value mono">
                            {game.gameId.slice(0, 8)}…
                        </span>
                    </div>
                </div>

                {/* ── Actions ─────────────────────────────────────────────── */}
                <div className="gameover-actions">
                    <button className="btn-primary play-again-btn" onClick={handlePlayAgain}>
                        Play again
                    </button>
                </div>

            </main>
        </div>
    );
}
