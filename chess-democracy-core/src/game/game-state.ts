/**
 * GameState — the authoritative chess engine wrapper for one Chess-Hive game.
 *
 * Responsibilities:
 *  • Wraps chess.js for move validation and FEN tracking
 *  • Owns the state machine: Waiting → Starting → InProgress → Finished
 *  • Resolves team conflicts deterministically from the peer list
 *  • Tracks move history with full metadata (who sent it, when, index)
 *
 * Design rule: GameState is PURE — it holds data and validates moves.
 *  It never sends messages. Node.ts calls GameState methods, then sends
 *  messages based on the results.
 */

import { Chess } from 'chess.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Team = 'white' | 'black';

export type GamePhase =
    | 'waiting_for_side'    // user hasn't chosen white or black yet
    | 'waiting_for_ready'   // side chosen, connected, haven't broadcast ready yet
    | 'waiting_for_peers'   // we've broadcast ready, waiting for all peers
    | 'starting'            // all ready — countdown running (10s)
    | 'in_progress'         // game is live
    | 'finished';           // game ended

export interface RecordedMove {
    moveIndex:  number;     // 0-based, increments per half-move (ply)
    move:       string;     // UCI format e.g. "e2e4", "e7e8q" (promotion)
    senderKey:  string;     // full public key of who sent it
    fenBefore:  string;     // FEN before the move (for verification)
    fenAfter:   string;     // FEN after the move (what both sides agree on)
    timestamp:  number;     // sender's synchronized timestamp
}

export interface GameResult {
    winner:  Team | 'draw' | null;
    reason:  'checkmate' | 'stalemate' | 'resignation' | 'disconnect' | 'draw_agreement' | 'revotes_exhausted' | 'timeout';
}

// ---------------------------------------------------------------------------
// Team validation
// ---------------------------------------------------------------------------

/**
 * Checks whether both sides have at least one player.
 * Returns the team counts so callers can log/display them.
 *
 * The game MUST NOT start if either count is zero — the user on each node
 * chose their side deliberately and we honour that choice unconditionally.
 * No auto-flipping.
 */
export function checkTeamBalance(
    participants: Array<{ publicKey: string; announcedTeam: Team }>,
): { whites: number; blacks: number; canStart: boolean } {
    const whites = participants.filter(p => p.announcedTeam === 'white').length;
    const blacks  = participants.filter(p => p.announcedTeam === 'black').length;
    return { whites, blacks, canStart: whites > 0 && blacks > 0 };
}

/**
 * Builds the final team map from all participants' chosen sides.
 * Every participant keeps the side they announced — no rebalancing.
 * Assumes checkTeamBalance() has already confirmed canStart === true.
 */
export function resolveTeams(
    participants: Array<{ publicKey: string; announcedTeam: Team }>,
): Map<string, Team> {
    const resolved = new Map<string, Team>();
    for (const p of participants) {
        resolved.set(p.publicKey, p.announcedTeam);
    }
    return resolved;
}

// ---------------------------------------------------------------------------
// GameState
// ---------------------------------------------------------------------------

export class GameState {
    private engine:       Chess;
    private _phase:       GamePhase = 'waiting_for_side';  // user must choose first
    private _gameId:      string    = '';
    private _moveHistory: RecordedMove[] = [];
    private _result:      GameResult | null = null;
    private _myTeam:      Team | null = null;
    private _startsAt:    number | null = null;

    constructor() {
        this.engine = new Chess();
    }

    // ── Accessors ──────────────────────────────────────────────────────────

    get phase():       GamePhase         { return this._phase; }
    get gameId():      string            { return this._gameId; }
    get myTeam():      Team | null       { return this._myTeam; }
    get moveHistory(): RecordedMove[]    { return [...this._moveHistory]; }
    get result():      GameResult | null { return this._result; }
    get startsAt():    number | null     { return this._startsAt; }

    get fen(): string { return this.engine.fen(); }

    get currentTurn(): Team {
        return this.engine.turn() === 'w' ? 'white' : 'black';
    }

    get isMyTurn(): boolean {
        return this._myTeam === this.currentTurn && this._phase === 'in_progress';
    }

    get nextMoveIndex(): number {
        return this._moveHistory.length;
    }

    get legalMoves(): string[] {
        return this.engine.moves({ verbose: true }).map(m => m.from + m.to + (m.promotion ?? ''));
    }

    // ── Phase transitions ─────────────────────────────────────────────────

    /**
     * User picks their side. Must be called before anything else.
     * Returns false if a side was already chosen (can't switch after ready).
     */
    setSide(team: Team): boolean {
        if (this._phase !== 'waiting_for_side' && this._phase !== 'waiting_for_ready') {
            logger.warn(`GameState: setSide() called in wrong phase`, { phase: this._phase });
            return false;
        }
        this._myTeam = team;
        this._phase  = 'waiting_for_ready';
        logger.info(`GameState: side chosen`, { team });
        return true;
    }

    /** Called when we broadcast our own ready message. */
    setWaitingForPeers(): void {
        if (this._phase !== 'waiting_for_ready') {
            logger.warn(`GameState: setWaitingForPeers() called in wrong phase`, { phase: this._phase });
            return;
        }
        this._phase = 'waiting_for_peers';
        logger.info(`GameState: now waiting for all peers to ready`);
    }

    /** Called when the user cancels ready — reverts to waiting_for_ready. */
    setUnready(): boolean {
        if (this._phase !== 'waiting_for_peers') {
            logger.warn(`GameState: setUnready() called in wrong phase`, { phase: this._phase });
            return false;
        }
        this._phase = 'waiting_for_ready';
        logger.info(`GameState: unreadied — back to waiting_for_ready`);
        return true;
    }

    /**
     * Called when all peers have readied AND both sides are populated.
     */
    beginCountdown(gameId: string, startsAt: number): void {
        this._gameId   = gameId;
        this._startsAt = startsAt;
        this._phase    = 'starting';
        logger.info(`GameState: countdown started`, {
            gameId:   gameId.slice(0, 8),
            team:     this._myTeam,
            startsAt: new Date(startsAt).toISOString(),
        });
    }

    /** Called when the countdown fires and the game actually begins. */
    begin(): void {
        if (this._phase !== 'starting') {
            logger.warn(`GameState: begin() called in wrong phase`, { phase: this._phase });
            return;
        }
        this._phase = 'in_progress';
        this.engine  = new Chess();
        logger.info(`GameState: game started`, {
            gameId: this._gameId.slice(0, 8),
            team:   this._myTeam,
            fen:    this.engine.fen(),
        });
    }

    // ── Move handling ─────────────────────────────────────────────────────

    /**
     * Validate and apply an incoming move from the network.
     *
     * Rejects if:
     *  - game is not in_progress
     *  - moveIndex doesn't match what we expect (out-of-order)
     *  - fenBefore doesn't match our current FEN (state divergence)
     *  - move is illegal according to chess.js
     *  - move was sent by the wrong team (cheating attempt)
     *
     * Returns 'ok' on success, or a rejection reason string.
     */
    applyMove(recorded: Omit<RecordedMove, 'fenAfter'> & { fenAfter?: string }, senderTeam: Team): 'ok' | string {
        if (this._phase !== 'in_progress') {
            return `wrong_phase:${this._phase}`;
        }

        // Order check — prevents missing or duplicate moves
        if (recorded.moveIndex !== this.nextMoveIndex) {
            return `wrong_index:expected=${this.nextMoveIndex},got=${recorded.moveIndex}`;
        }

        // State divergence check — both nodes must be on the same FEN
        if (recorded.fenBefore !== this.engine.fen()) {
            return `fen_mismatch:expected=${this.engine.fen()},got=${recorded.fenBefore}`;
        }

        // Turn check — only the correct team may move
        if (senderTeam !== this.currentTurn) {
            return `wrong_turn:expected=${this.currentTurn},sender_is=${senderTeam}`;
        }

        // Parse UCI move e.g. "e2e4" or "e7e8q"
        const from      = recorded.move.slice(0, 2);
        const to        = recorded.move.slice(2, 4);
        const promotion = recorded.move.length === 5 ? recorded.move[4] : undefined;

        const result = this.engine.move({ from, to, promotion });
        if (!result) {
            return `illegal_move:${recorded.move}`;
        }

        const fenAfter = this.engine.fen();

        // Optional: verify sender's claimed fenAfter matches ours
        if (recorded.fenAfter && recorded.fenAfter !== fenAfter) {
            // Roll back and reject — state would diverge
            this.engine.undo();
            return `fen_after_mismatch:expected=${fenAfter},got=${recorded.fenAfter}`;
        }

        this._moveHistory.push({
            ...recorded,
            fenAfter,
        });

        logger.info(`Move applied`, {
            index:  recorded.moveIndex,
            move:   recorded.move,
            sender: recorded.senderKey.slice(0, 8),
            fen:    fenAfter,
        });

        // Check for game end
        if (this.engine.isCheckmate()) {
            this.finish({
                winner: senderTeam,
                reason: 'checkmate',
            });
        } else if (this.engine.isStalemate() || this.engine.isDraw()) {
            this.finish({ winner: 'draw', reason: 'stalemate' });
        }

        return 'ok';
    }

    /** Called when a player resigns or disconnects. */
    finish(result: GameResult): void {
        this._result = result;
        this._phase  = 'finished';
        logger.info(`Game finished`, {
            gameId: this._gameId.slice(0, 8),
            winner: result.winner,
            reason: result.reason,
        });
    }

    /** Reset to initial state — user must choose side again. */
    reset(): void {
        this.engine       = new Chess();
        this._phase       = 'waiting_for_side';
        this._gameId      = '';
        this._moveHistory = [];
        this._result      = null;
        this._myTeam      = null;
        this._startsAt    = null;
    }
}
