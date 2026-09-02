import { WebsocketService }        from "../network/websocket-service.js";
import { LocalNetworkController }  from "../network/localnetwork/local-network-controller.js";
import { Peer, PeerStatus }         from "../network/peer.js";
import { loadOrCreateIdentity }    from "../protocol/identity-store.js";
import { getOrCreateIdentity }     from "../protocol/generateidentity.js";
import { GAME_CONFIG, VOTE_CONFIG } from "../utils/config.js";
import { logger }                  from "../utils/logger.js";
import { GameState, checkTeamBalance, Team } from "../game/game-state.js";
import { VotingState, GameConfig, DEFAULT_GAME_CONFIG } from "../game/voting-state.js";
import {
    sendGameStart,
    sendMove,
    sendGameOver,
} from "../game/game-protocol.js";
import { MessageCallbacks }        from "../network/localnetwork/message-service.js";
import { randomUUID }              from "crypto";
import { EventEmitter }            from "events";
import { join }                    from "node:path";
import { homedir }                 from "node:os";

function defaultIdentityPath(): string {
    return join(homedir(), '.chess-hive', 'identity.pem');
}

// ---------------------------------------------------------------------------
// Internal node state
// ---------------------------------------------------------------------------
interface NodeState {
    peers:               Map<string, Peer>;
    alivePeersCount:     number;
    acceptingConnection: boolean;
    timeOffset:          number;
    lastConnectionMs:    number;
}

export class Node extends EventEmitter {
    // Identity & transport
    public  readonly identity: { publicKey: string; privateKey: string };
    private readonly service  = new WebsocketService();

    // Network state
    private readonly state: NodeState = {
        peers:               new Map<string, Peer>(),
        alivePeersCount:     0,
        acceptingConnection: true,
        timeOffset:          0,
        lastConnectionMs:    Date.now(),
    };

    // Game state
    private readonly game = new GameState();
    private readyCheckInterval?:  NodeJS.Timeout;
    private readyCheckStartedAt?: number;
    private gameStartTimeout?:    NodeJS.Timeout;

    // Config handshake state
    private _gameConfig:                GameConfig = { ...DEFAULT_GAME_CONFIG };
    private _configVersion:             number     = 0;
    private _selfAcceptedConfigVersion: number | null = 0; // 0 = auto-accept default
    private _peerAcceptedVersions:      Map<string, number> = new Map();

    // Voting state
    private _voting:          VotingState | null = null;
    private _voteTimer?:      NodeJS.Timeout;
    private _moveTimeoutTimer?: NodeJS.Timeout;
    private _gameMode:        'direct' | 'voting' = 'voting';

    // Resign vote state
    private _resignVote: {
        yesVoters: Set<string>;
        expiresAt: number;
        timer:     NodeJS.Timeout;
    } | null = null;

    // Network controller
    private localNetwork?: LocalNetworkController;

    /** The port the WebSocket server is actually bound to (0 until boot completes). */
    public boundPort: number = 0;

    /** Exposed for integration tests — do not use in production code. */
    get network(): LocalNetworkController | undefined { return this.localNetwork; }

    constructor(identityPath?: string) {
        super();
        // TODO(production): always load from identityPath / defaultIdentityPath()
        // this.identity = loadOrCreateIdentity(identityPath ?? defaultIdentityPath());
        this.identity = identityPath
            ? loadOrCreateIdentity(identityPath)
            : getOrCreateIdentity(); // ephemeral — fresh key every run
        logger.info(`Identity loaded`, { id: this.identity.publicKey.slice(0, 8) });
    }

    // Accessors

    get totalAlivePeersCount(): number  { return this.state.alivePeersCount; }
    get allPeers(): Map<string, Peer>   { return this.state.peers; }
    get acceptingConnectionStatus(): boolean { return this.state.acceptingConnection; }
    get gameState(): GameState          { return this.game; }
    get chosenTeam(): Team | null       { return this.game.myTeam; }

    get gameConfig():                GameConfig         { return { ...this._gameConfig }; }
    get configVersion():             number             { return this._configVersion; }
    get selfAcceptedConfigVersion(): number | null      { return this._selfAcceptedConfigVersion; }
    get peerAcceptedVersions():      Map<string, number>{ return new Map(this._peerAcceptedVersions); }
    get activeVoting():              VotingState | null { return this._voting; }

    // Public API

    public setTeam(team: Team): boolean {
        const ok = this.game.setSide(team);
        if (ok) {
            logger.info(`Team selected`, { team, id: this.identity.publicKey.slice(0, 8) });
            this.localNetwork?.broadcastSideChoice(team);
        }
        return ok;
    }

    public setConfig(voteWindowMs: number, maxRevotes: number, resignThreshold?: number, resignWindowMs?: number): string {
        if (this.game.phase !== 'waiting_for_side' && this.game.phase !== 'waiting_for_ready') {
            return `error:wrong_phase:${this.game.phase}`;
        }
        if (voteWindowMs < VOTE_CONFIG.MIN_VOTE_WINDOW_MS || voteWindowMs > VOTE_CONFIG.MAX_VOTE_WINDOW_MS) {
            return `error:invalid_vote_window:${voteWindowMs}`;
        }
        if (maxRevotes < 0 || maxRevotes > 10) {
            return `error:invalid_max_revotes:${maxRevotes}`;
        }
        if (resignThreshold !== undefined && (resignThreshold < 0.5 || resignThreshold > 1.0)) {
            return `error:invalid_resign_threshold:${resignThreshold}`;
        }
        if (resignWindowMs !== undefined && (resignWindowMs < 10_000 || resignWindowMs > 300_000)) {
            return `error:invalid_resign_window:${resignWindowMs}`;
        }

        const newThreshold = resignThreshold ?? this._gameConfig.resignThreshold;
        const newWindow    = resignWindowMs  ?? this._gameConfig.resignWindowMs;

        this._configVersion++;
        this._gameConfig = { voteWindowMs, maxRevotes, resignThreshold: newThreshold, resignWindowMs: newWindow };
        this._selfAcceptedConfigVersion = this._configVersion;
        this._peerAcceptedVersions.clear();

        this.localNetwork?.broadcastConfigProposal(this._gameConfig, this._configVersion);

        logger.info(`Config proposed`, { ...this._gameConfig, version: this._configVersion });
        this.emit('config:updated', {
            voteWindowMs,
            maxRevotes,
            resignThreshold: newThreshold,
            resignWindowMs:  newWindow,
            version:         this._configVersion,
            proposerKey:     this.identity.publicKey,
        });

        return 'ok';
    }

    public acceptConfig(): string {
        if (this.game.phase !== 'waiting_for_side' && this.game.phase !== 'waiting_for_ready') {
            return `error:wrong_phase:${this.game.phase}`;
        }

        this._selfAcceptedConfigVersion = this._configVersion;
        this.localNetwork?.broadcastConfigAccept(this._configVersion);

        logger.info(`Config accepted`, { version: this._configVersion });
        this.emit('config:self_accepted', { version: this._configVersion });

        return 'ok';
    }

    public castVote(uciMove: string): string {
        if (this.game.phase !== 'in_progress') return `error:not_in_progress`;
        if (!this.game.isMyTurn)               return `error:not_your_turn`;
        if (!this._voting)                     return `error:no_vote_window`;
        if (!this.game.legalMoves.includes(uciMove)) return `error:illegal_move`;

        const now    = this.getSynchronizedTime();
        const result = this._voting.castVote(this.identity.publicKey, uciMove, now);
        if (result !== 'ok') return `error:${result}`;

        this.localNetwork?.broadcastVote(this._voting.turnIndex, uciMove, now);
        this.emit('vote:received', {
            peerId:    this.identity.publicKey,
            turnIndex: this._voting.turnIndex,
            move:      uciMove,
        });

        logger.info(`Vote cast`, { move: uciMove, turn: this._voting.turnIndex });
        return 'ok';
    }

    public offerDraw(): string {
        if (this.game.phase !== 'in_progress') return `error:not_in_progress`;
        this.localNetwork?.broadcastDrawOffer();
        this.emit('draw:offered', { from: this.identity.publicKey, fromSelf: true });
        logger.info(`Draw offered by self`);
        return 'ok';
    }

    public respondToDraw(accept: boolean): string {
        if (this.game.phase !== 'in_progress') return `error:not_in_progress`;
        if (accept) {
            this.game.finish({ winner: 'draw', reason: 'draw_agreement' });
            clearTimeout(this._voteTimer);
            clearTimeout(this._moveTimeoutTimer);
            this._voteTimer          = undefined;
            this._moveTimeoutTimer   = undefined;
            this._voting             = null;
            sendGameOver(
                this.allPeers, this.identity.publicKey, this.identity.privateKey,
                this.game.gameId, this.game.result!, this.game.fen, this.game.moveHistory.length,
            );
            this.emit('game:over', {
                gameId:    this.game.gameId,
                result:    this.game.result!,
                lastFen:   this.game.fen,
                moveCount: this.game.moveHistory.length,
            });
        } else {
            this.localNetwork?.broadcastDrawResponse(false);
            this.emit('draw:declined', { by: this.identity.publicKey });
        }
        return 'ok';
    }

    adjustAlivePeersCount(sign: '+' | '-', amount: number): void {
        if (sign === '+') {
            this.state.alivePeersCount += amount;
            this.state.lastConnectionMs = Date.now();
        } else {
            this.state.alivePeersCount = Math.max(0, this.state.alivePeersCount - amount);
        }
    }

    getSynchronizedTime(): number { return Date.now() + this.state.timeOffset; }

    setTimeOffset(offset: number): void {
        this.state.timeOffset = offset;
        logger.info(`Time offset applied`, { offsetMs: offset });
    }

    // Boot

    boot(port: number): void {
        this.service.boot(port);
        this.state.lastConnectionMs = Date.now();

        this.service.on('ready', (actualPort: number) => {
            this.boundPort = actualPort;
            logger.info(`Node online`, { port: actualPort });

            const callbacks: MessageCallbacks = {
                setTimeOffset: (offset) => this.setTimeOffset(offset),
                onGameStart:   (msg, senderKey) => this.handleGameStart(msg, senderKey),
                onMove:        (msg, senderKey) => this.handleMove(msg, senderKey),
                onGameOver:    (msg, senderKey) => this.handleGameOver(msg, senderKey),

                onSideChoice: (senderKey, team) => {
                    this.emit('peer:team_updated', { peerId: senderKey, team });
                },
                onReady: (senderKey) => {
                    this.emit('peer:ready_changed', { peerId: senderKey, ready: true });
                },
                onUnready: (senderKey) => {
                    this.emit('peer:ready_changed', { peerId: senderKey, ready: false });
                },

                onConfigProposal: (senderKey, config, version) => {
                    if (version < this._configVersion) {
                        logger.debug(`Stale config_proposal ignored`, { version, current: this._configVersion });
                        return;
                    }

                    if (
                        typeof config?.voteWindowMs !== 'number' ||
                        typeof config?.maxRevotes   !== 'number' ||
                        config.voteWindowMs < VOTE_CONFIG.MIN_VOTE_WINDOW_MS ||
                        config.voteWindowMs > VOTE_CONFIG.MAX_VOTE_WINDOW_MS ||
                        config.maxRevotes < 0 || config.maxRevotes > 10
                    ) {
                        logger.warn(`Invalid config_proposal rejected`, { senderKey: senderKey.slice(0, 8), config, version });
                        return;
                    }

                    const sameConfig =
                        version === this._configVersion &&
                        config.voteWindowMs === this._gameConfig.voteWindowMs &&
                        config.maxRevotes   === this._gameConfig.maxRevotes   &&
                        this._selfAcceptedConfigVersion === this._configVersion;

                    this._configVersion = version;
                    this._gameConfig    = config;
                    this._peerAcceptedVersions.clear();
                    this._peerAcceptedVersions.set(senderKey, version);

                    if (sameConfig) {
                        // Already on this exact config — auto-accept and reply
                        this._selfAcceptedConfigVersion = version;
                        this.localNetwork?.broadcastConfigAccept(version);
                        logger.debug(`Auto-accepted matching config_proposal`, { version });
                    } else {
                        this._selfAcceptedConfigVersion = null;
                        this.emit('config:updated', {
                            voteWindowMs: config.voteWindowMs,
                            maxRevotes:   config.maxRevotes,
                            version,
                            proposerKey:  senderKey,
                        });
                    }
                },

                onConfigAccept: (senderKey, version) => {
                    if (version !== this._configVersion) return;
                    this._peerAcceptedVersions.set(senderKey, version);
                    logger.info(`Peer accepted config`, { peer: senderKey.slice(0, 8), version });
                    this.emit('config:peer_accepted', { peerId: senderKey, version });
                },

                onDrawOffer: (senderKey) => {
                    this.emit('draw:offered', { from: senderKey, fromSelf: false });
                },

                onDrawResponse: (_senderKey, accepted) => {
                    // accepted=true path: accepter already broadcast game_over; handleGameOver handles it.
                    // declined path: let offeror know via the draw:declined event.
                    if (!accepted) {
                        this.emit('draw:declined', { by: _senderKey });
                    }
                },

                onVote: (senderKey, turnIndex, move, timestamp) => {
                    if (!this._voting || this._voting.turnIndex !== turnIndex) {
                        logger.warn(`Vote for wrong/inactive window`, {
                            turnIndex,
                            activeTurn: this._voting?.turnIndex,
                        });
                        return;
                    }
                    const result = this._voting.castVote(senderKey, move, this.getSynchronizedTime());
                    if (result === 'ok') {
                        logger.info(`Peer vote recorded`, { peer: senderKey.slice(0, 8), move, turnIndex });
                        this.emit('vote:received', { peerId: senderKey, turnIndex, move });
                    } else {
                        logger.warn(`Peer vote rejected`, { peer: senderKey.slice(0, 8), reason: result });
                    }
                },

                onResignVote: (senderKey) => {
                    if (this.game.phase !== 'in_progress') return;

                    // A teammate started a resign vote we don't know about yet —
                    // open a local window so our renderer shows the banner too.
                    if (!this._resignVote) {
                        const expiresAt = Date.now() + this._gameConfig.resignWindowMs;
                        const timer = setTimeout(() => {
                            this._resignVote = null;
                            this.emit('resign:vote_expired', {});
                        }, this._gameConfig.resignWindowMs);
                        timer.unref();
                        this._resignVote = { yesVoters: new Set(), expiresAt, timer };
                        this.emit('resign:vote_started', { expiresAt });
                        logger.info(`Resign vote window opened by teammate`, { peer: senderKey.slice(0, 8) });
                    }

                    if (this._resignVote.yesVoters.has(senderKey)) return; // duplicate
                    this._resignVote.yesVoters.add(senderKey);
                    this.emit('resign:vote_updated', {
                        yesVotes:          this._resignVote.yesVoters.size,
                        connectedTeamSize: this.connectedTeamSize(),
                    });
                    logger.info(`Resign vote received from peer`, { peer: senderKey.slice(0, 8) });
                    this.checkResignThreshold();
                },
            };

            this.localNetwork = new LocalNetworkController(
                'Chess-Hive-Local',
                this.service,
                this.identity,
                actualPort,
                () => this.totalAlivePeersCount,
                () => this.allPeers,
                (sign, amount) => this.adjustAlivePeersCount(sign, amount),
                () => this.acceptingConnectionStatus,
                callbacks,
            );

            this.localNetwork.on('peer:connected',    (p: Peer) => this.addPeer(p));
            this.localNetwork.on('peer:disconnected', (p: Peer) => this.handlePeerDisconnect(p));
            this.localNetwork.start();
        });
    }

    // Ready phase

    public ready(): string {
        if (this.game.phase === 'waiting_for_side') {
            return 'error:choose_a_side_first';
        }
        if (this.game.phase !== 'waiting_for_ready') {
            return `error:already_in_phase:${this.game.phase}`;
        }
        if (!this.localNetwork) {
            return 'error:node_not_booted';
        }
        if (!this.allConfigAccepted()) {
            return 'error:config_not_accepted_by_all';
        }
        this.broadcastReadyAndBeginCheck();
        return 'ok';
    }

    private allConfigAccepted(): boolean {
        if (this.state.peers.size === 0) return true; // solo — no peers to disagree
        if (this._selfAcceptedConfigVersion !== this._configVersion) return false;
        for (const peer of this.state.peers.values()) {
            if ((this._peerAcceptedVersions.get(peer.peerPublicNodeId) ?? -1) !== this._configVersion) {
                return false;
            }
        }
        return true;
    }

    private broadcastReadyAndBeginCheck(): void {
        const myTeam = this.game.myTeam!;
        logger.info(`Broadcasting ready`, { team: myTeam });
        this.localNetwork?.broadcastReady(myTeam);
        this.localNetwork?.sync();
        this.state.acceptingConnection = false;
        this.game.setWaitingForPeers();

        this.readyCheckStartedAt = Date.now();
        this.readyCheckInterval  = setInterval(() => {
            this.checkAllPeersReady();
        }, GAME_CONFIG.READY_CHECK_INTERVAL_MS);
    }

    private checkAllPeersReady(): void {
        const peers   = this.allPeers;
        const elapsed = Date.now() - (this.readyCheckStartedAt ?? Date.now());

        if (elapsed > GAME_CONFIG.READY_TIMEOUT_MS) {
            clearInterval(this.readyCheckInterval);
            logger.error(`Ready timeout`, {
                elapsed,
                total: peers.size,
                ready: [...peers.values()].filter(p => p.ready).length,
            });
            return;
        }

        if (peers.size === 0) return;

        const allReady = [...peers.values()].every(p => p.ready);
        if (!allReady) return;

        const participants: Array<{ publicKey: string; announcedTeam: Team }> = [
            { publicKey: this.identity.publicKey, announcedTeam: this.game.myTeam! },
            ...([...peers.values()].map(p => ({
                publicKey:     p.peerPublicNodeId,
                announcedTeam: (p.team ?? 'white') as Team,
            }))),
        ];

        const { whites, blacks, canStart } = checkTeamBalance(participants);

        if (!canStart) {
            logger.warn(`Cannot start — one side is empty`, { whites, blacks });
            this.emit('waiting:for_side', {
                whites,
                blacks,
                waitingFor: whites === 0 ? 'white' : 'black',
            });
            return;
        }

        clearInterval(this.readyCheckInterval);
        logger.info(`All peers ready — starting`, { whites, blacks });
        this.initiateGameStart();
    }

    // Game start

    private initiateGameStart(): void {
        const myTeam  = this.game.myTeam!;
        const allKeys = [this.identity.publicKey, ...[...this.allPeers.keys()]].sort();
        const isMaster = allKeys[0] === this.identity.publicKey;
        const gameId   = isMaster ? randomUUID() : '';
        const startsAt = this.getSynchronizedTime() + GAME_CONFIG.GAME_START_COUNTDOWN_MS;

        logger.info(`Initiating game start`, {
            myTeam,
            isMaster,
            gameId:  gameId.slice(0, 8) || '(awaiting master)',
            startsAt: new Date(startsAt).toISOString(),
        });

        // Only the master broadcasts game_start (it has the authoritative gameId).
        // Non-master starts a provisional countdown and overwrites it when the
        // master's game_start arrives via handleGameStart().
        if (isMaster) {
            sendGameStart(
                this.allPeers,
                this.identity.publicKey,
                this.identity.privateKey,
                gameId,
                myTeam,
                startsAt,
                this.allPeers.size + 1,
            );
        }

        this.game.beginCountdown(gameId, startsAt);
        this.scheduleGameBegin(startsAt);
    }

    private scheduleGameBegin(startsAt: number): void {
        const delay = Math.max(0, startsAt - this.getSynchronizedTime());
        logger.info(`Game begins in ${Math.round(delay / 1000)}s`);
        this.emit('game:starting', { startsAt, countdownMs: delay, myTeam: this.game.myTeam });

        this.gameStartTimeout = setTimeout(() => {
            this._gameMode = 'voting';
            this.game.begin();
            logger.info(`Game live`, {
                gameId: this.game.gameId.slice(0, 8),
                myTeam: this.game.myTeam,
                fen:    this.game.fen,
            });
            this.emit('game:started', {
                gameId:     this.game.gameId,
                myTeam:     this.game.myTeam,
                fen:        this.game.fen,
                legalMoves: this.game.legalMoves,
            });

            // Open first voting window anchored to game start time
            this.openVotingWindow(0, startsAt);
        }, delay);
    }

    // Voting window management

    private openVotingWindow(turnIndex: number, windowStartTime: number): void {
        const windowCloseAt = windowStartTime + this._gameConfig.voteWindowMs;
        this._voting = new VotingState(turnIndex, windowCloseAt);

        const tallyTime = windowCloseAt + VOTE_CONFIG.VOTE_GRACE_MS;
        const delay     = Math.max(0, tallyTime - this.getSynchronizedTime());
        this._voteTimer = setTimeout(() => this.runTally(), delay);

        // Per-turn timeout: if no move is committed within MOVE_TIMEOUT_MS, end the game.
        clearTimeout(this._moveTimeoutTimer);
        this._moveTimeoutTimer = setTimeout(() => {
            if (this.game.phase !== 'in_progress') return;
            logger.warn(`Move timeout on turn ${turnIndex} — ending game`);
            this.game.finish({ winner: null, reason: 'timeout' });
            clearTimeout(this._voteTimer);
            this._voteTimer = undefined;
            this._voting    = null;
            sendGameOver(
                this.allPeers, this.identity.publicKey, this.identity.privateKey,
                this.game.gameId, this.game.result!, this.game.fen, this.game.moveHistory.length,
            );
            this.emit('game:over', {
                gameId:    this.game.gameId,
                result:    this.game.result!,
                lastFen:   this.game.fen,
                moveCount: this.game.moveHistory.length,
            });
        }, GAME_CONFIG.MOVE_TIMEOUT_MS);

        logger.info(`Vote window opened`, {
            turnIndex,
            team:         this.game.currentTurn,
            windowCloseAt: new Date(windowCloseAt).toISOString(),
        });

        this.emit('vote:window_opened', {
            turnIndex,
            windowCloseAt,
            voteWindowMs: this._gameConfig.voteWindowMs,
            isMyTurn:     this.game.isMyTurn,
        });
    }

    private runTally(): void {
        if (!this._voting) return;

        const voting = this._voting;
        const result = voting.tally();

        logger.info(`Tallying votes`, {
            turnIndex:   voting.turnIndex,
            voteCount:   voting.voteCount,
            outcome:     result.outcome,
        });

        if (result.outcome === 'no_votes' || result.outcome === 'no_majority') {
            this.maybeRevote();
            return;
        }

        const { move, isTiebreak, voteCount, total } = result;
        const prevWindowCloseAt = voting.windowCloseAt;
        const appliedByTeam     = this.game.currentTurn;

        const recorded = {
            moveIndex: voting.turnIndex,
            move,
            senderKey: '',
            fenBefore: this.game.fen,
            timestamp: this.getSynchronizedTime(),
        };

        const applyResult = this.game.applyMove(recorded, appliedByTeam);
        if (applyResult !== 'ok') {
            logger.error(`Tally winner rejected by engine`, { move, reason: applyResult });
            this.maybeRevote();
            return;
        }

        this._voting    = null;
        clearTimeout(this._voteTimer);
        this._voteTimer = undefined;

        logger.info(`Tally applied`, {
            move, isTiebreak, voteCount, total,
            fen: this.game.fen,
        });

        this.emit('tally:done', {
            turnIndex: voting.turnIndex,
            move,
            isTiebreak,
            voteCount,
            total,
            appliedByTeam,
            fen:        this.game.fen,
            legalMoves: this.game.legalMoves,
            isMyTurn:   this.game.isMyTurn,
        });

        // Check for game end
        if (this.game.phase === 'finished' && this.game.result) {
            clearTimeout(this._moveTimeoutTimer);
            this._moveTimeoutTimer = undefined;
            this.emit('game:over', {
                gameId:    this.game.gameId,
                result:    this.game.result,
                lastFen:   this.game.fen,
                moveCount: this.game.moveHistory.length,
            });
            return;
        }

        // Open next window anchored to previous window end (deterministic across nodes)
        const nextWindowStart = prevWindowCloseAt + VOTE_CONFIG.VOTE_GRACE_MS;
        this.openVotingWindow(voting.turnIndex + 1, nextWindowStart);
    }

    private maybeRevote(): void {
        if (!this._voting) return;

        if (this._voting.revoteCount >= this._gameConfig.maxRevotes) {
            logger.warn(`Max revotes exceeded — abandoning game`);
            this.game.finish({ winner: null, reason: 'revotes_exhausted' });
            this._voting    = null;
            clearTimeout(this._voteTimer);
            this._voteTimer = undefined;
            this.emit('game:over', {
                gameId:    this.game.gameId,
                result:    this.game.result!,
                lastFen:   this.game.fen,
                moveCount: this.game.moveHistory.length,
            });
            return;
        }

        const prevWindowCloseAt = this._voting.windowCloseAt;
        const newWindowCloseAt  = prevWindowCloseAt + VOTE_CONFIG.VOTE_GRACE_MS + this._gameConfig.voteWindowMs;
        this._voting.openRevote(newWindowCloseAt);

        const delay = Math.max(0, newWindowCloseAt + VOTE_CONFIG.VOTE_GRACE_MS - this.getSynchronizedTime());
        this._voteTimer = setTimeout(() => this.runTally(), delay);

        logger.info(`Re-vote opened`, {
            turnIndex:   this._voting.turnIndex,
            revoteCount: this._voting.revoteCount,
        });

        this.emit('revote:started', {
            turnIndex:     this._voting.turnIndex,
            revoteCount:   this._voting.revoteCount,
            windowCloseAt: newWindowCloseAt,
            voteWindowMs:  this._gameConfig.voteWindowMs,
        });
    }

    // Inbound game message handlers

    private handleGameStart(msg: Record<string, unknown>, senderKey: string): void {
        const theirGameId = msg.gameId as string | undefined;
        const theirStart  = msg.startsAt as number | undefined;

        if (!theirGameId || !theirStart) {
            logger.warn(`Invalid game_start message`, { sender: senderKey.slice(0, 8) });
            return;
        }

        if (senderKey < this.identity.publicKey && this.game.phase === 'starting') {
            logger.info(`Adopting game_start from master`, {
                master:   senderKey.slice(0, 8),
                gameId:   theirGameId.slice(0, 8),
                startsAt: new Date(theirStart).toISOString(),
            });

            if (this.gameStartTimeout) clearTimeout(this.gameStartTimeout);
            this.game.beginCountdown(theirGameId, theirStart);
            this.scheduleGameBegin(theirStart);
        }
    }

    private handleMove(msg: Record<string, unknown>, senderKey: string): void {
        // Legacy path — in voting mode peers send 'vote' messages, not 'move'.
        // Kept for backward compatibility.
        if (this._gameMode === 'voting') {
            logger.warn(`Ignoring 'move' message in voting mode`, { sender: senderKey.slice(0, 8) });
            return;
        }
        if (this.game.phase !== 'in_progress') return;

        const senderPeer = this.allPeers.get(senderKey);
        const senderTeam = (senderPeer?.team ?? null) as Team | null;
        if (!senderTeam) return;

        const recorded = {
            moveIndex:  msg.moveIndex as number,
            move:       msg.move as string,
            senderKey,
            fenBefore:  msg.fenBefore as string,
            fenAfter:   msg.fenAfter as string,
            timestamp:  msg.timestamp as number,
        };

        const result = this.game.applyMove(recorded, senderTeam);
        if (result !== 'ok') {
            logger.error(`Move rejected`, { reason: result, sender: senderKey.slice(0, 8), move: msg.move });
            return;
        }

        this.emit('game:move', {
            move:       recorded.move,
            moveIndex:  recorded.moveIndex,
            senderTeam,
            fen:        this.game.fen,
            legalMoves: this.game.legalMoves,
            isMyTurn:   this.game.isMyTurn,
        });

        const phaseAfter = (this.game as { phase: string }).phase;
        if (phaseAfter === 'finished' && this.game.result) {
            sendGameOver(
                this.allPeers,
                this.identity.publicKey,
                this.identity.privateKey,
                this.game.gameId,
                this.game.result,
                this.game.fen,
                this.game.moveHistory.length,
            );
        }
    }

    private handleGameOver(msg: Record<string, unknown>, senderKey: string): void {
        if (this.game.phase === 'finished') return;

        const result = msg.result as { winner: string; reason: string } | undefined;
        if (!result) {
            logger.warn(`Invalid game_over message`, { sender: senderKey.slice(0, 8) });
            return;
        }

        this.game.finish({
            winner: result.winner as any,
            reason: result.reason as any,
        });

        // Clear resign vote if one was open
        if (this._resignVote) {
            clearTimeout(this._resignVote.timer);
            this._resignVote = null;
        }

        clearTimeout(this._voteTimer);
        clearTimeout(this._moveTimeoutTimer);
        this._voteTimer        = undefined;
        this._moveTimeoutTimer = undefined;
        this._voting           = null;

        logger.info(`Game over from peer`, {
            sender: senderKey.slice(0, 8),
            winner: result.winner,
            reason: result.reason,
        });

        // Push the game-over event to the renderer — without this the receiving
        // side's screen never transitions away from GameScreen.
        this.emit('game:over', {
            gameId:    this.game.gameId,
            result:    this.game.result!,
            lastFen:   this.game.fen,
            moveCount: this.game.moveHistory.length,
        });
    }

    // Public game API

    public submitMove(uciMove: string): string {
        // In voting mode (active voting window) use castVote instead
        if (this._voting !== null) return 'error:use_cast_vote_in_voting_mode';

        if (!this.game.isMyTurn) {
            return `not_your_turn:current=${this.game.currentTurn},you=${this.game.myTeam}`;
        }

        const fenBefore = this.game.fen;
        const recorded  = {
            moveIndex: this.game.nextMoveIndex,
            move:      uciMove,
            senderKey: this.identity.publicKey,
            fenBefore,
            timestamp: this.getSynchronizedTime(),
        };

        const result = this.game.applyMove(recorded, this.game.myTeam!);
        if (result !== 'ok') return result;

        const fenAfter = this.game.fen;

        sendMove(
            this.allPeers,
            this.identity.publicKey,
            this.identity.privateKey,
            this.game.gameId,
            recorded.moveIndex,
            uciMove,
            fenBefore,
            fenAfter,
            this.game.myTeam!,
        );

        if (this.game.phase === 'finished' && this.game.result) {
            sendGameOver(
                this.allPeers,
                this.identity.publicKey,
                this.identity.privateKey,
                this.game.gameId,
                this.game.result,
                fenAfter,
                this.game.moveHistory.length,
            );
        }

        return 'ok';
    }

    // Resign helpers

    private connectedTeamSize(): number {
        const myTeam = this.game.myTeam;
        if (!myTeam) return 1;
        let count = 1; // self
        for (const peer of this.allPeers.values()) {
            if (peer.team === myTeam && peer.status === PeerStatus.Alive) count++;
        }
        return count;
    }

    private checkResignThreshold(): void {
        if (!this._resignVote || this.game.phase !== 'in_progress') return;
        const teamSize = this.connectedTeamSize();
        const yesVotes = this._resignVote.yesVoters.size;
        if (teamSize > 0 && yesVotes / teamSize >= this._gameConfig.resignThreshold) {
            clearTimeout(this._resignVote.timer);
            this._resignVote = null;
            this._executeResign();
        }
    }

    private _executeResign(): void {
        if (this.game.phase !== 'in_progress') return;
        const myTeam = this.game.myTeam!;
        const winner = myTeam === 'white' ? 'black' : 'white';
        this.game.finish({ winner, reason: 'resignation' });

        clearTimeout(this._voteTimer);
        clearTimeout(this._moveTimeoutTimer);
        this._voteTimer        = undefined;
        this._moveTimeoutTimer = undefined;
        this._voting           = null;

        sendGameOver(
            this.allPeers,
            this.identity.publicKey,
            this.identity.privateKey,
            this.game.gameId,
            { winner, reason: 'resignation' },
            this.game.fen,
            this.game.moveHistory.length,
        );

        this.emit('game:over', {
            gameId:    this.game.gameId,
            result:    this.game.result!,
            lastFen:   this.game.fen,
            moveCount: this.game.moveHistory.length,
        });
    }

    public castResignVote(): string {
        if (this.game.phase !== 'in_progress') return 'error:not_in_progress';
        const myTeam = this.game.myTeam;
        if (!myTeam) return 'error:no_team';

        // Start a new vote window if none is active
        if (!this._resignVote) {
            const expiresAt = Date.now() + this._gameConfig.resignWindowMs;
            const timer = setTimeout(() => {
                this._resignVote = null;
                this.emit('resign:vote_expired', {});
                logger.info(`Resign vote expired`);
            }, this._gameConfig.resignWindowMs);
            timer.unref();
            this._resignVote = { yesVoters: new Set(), expiresAt, timer };
            this.emit('resign:vote_started', { expiresAt });
            logger.info(`Resign vote started`, { expiresAt });
        }

        // Deduplicate — self can only vote once
        if (this._resignVote.yesVoters.has(this.identity.publicKey)) {
            return 'error:already_voted';
        }

        this._resignVote.yesVoters.add(this.identity.publicKey);

        // Send only to alive teammates (opponent never sees this)
        this.localNetwork?.broadcastResignVoteToTeam(myTeam);

        this.emit('resign:vote_updated', {
            yesVotes:         this._resignVote.yesVoters.size,
            connectedTeamSize: this.connectedTeamSize(),
        });

        logger.info(`Resign vote cast`, {
            yesVotes:  this._resignVote.yesVoters.size,
            teamSize:  this.connectedTeamSize(),
            threshold: this._gameConfig.resignThreshold,
        });

        this.checkResignThreshold();
        return 'ok';
    }

    public unready(): string {
        if (this.game.phase !== 'waiting_for_peers') {
            return `error:wrong_phase:${this.game.phase}`;
        }

        clearInterval(this.readyCheckInterval);
        this.readyCheckInterval = undefined;

        this.localNetwork?.broadcastUnready();
        this.state.acceptingConnection = true;
        this.game.setUnready();

        logger.info(`Unreadied — accepting connections again`);
        return 'ok';
    }

    // Lifecycle

    /**
     * Reset game state so the same peers can play again without restarting the
     * process. Keeps the WebSocket server, peer connections, and identity.
     */
    public reset(): void {
        clearInterval(this.readyCheckInterval);
        clearTimeout(this.gameStartTimeout);
        clearTimeout(this._voteTimer);
        clearTimeout(this._moveTimeoutTimer);
        this.readyCheckInterval  = undefined;
        this.gameStartTimeout    = undefined;
        this._voteTimer          = undefined;
        this._moveTimeoutTimer   = undefined;

        if (this._resignVote) {
            clearTimeout(this._resignVote.timer);
            this._resignVote = null;
        }

        this.game.reset();
        this._voting    = null;
        this._gameMode  = 'voting';

        this._gameConfig                = { ...DEFAULT_GAME_CONFIG };
        this._configVersion             = 0;
        this._selfAcceptedConfigVersion = 0;
        this._peerAcceptedVersions.clear();

        this.state.acceptingConnection = true;

        for (const peer of this.state.peers.values()) {
            peer.ready = false;
            peer.team  = null;
        }

        logger.info(`Node reset — ready for new game`);
        this.emit('game:reset');
    }

    stop(): void {
        logger.info(`Node shutting down`);
        clearInterval(this.readyCheckInterval);
        clearTimeout(this.gameStartTimeout);
        clearTimeout(this._voteTimer);
        clearTimeout(this._moveTimeoutTimer);
        if (this._resignVote) {
            clearTimeout(this._resignVote.timer);
            this._resignVote = null;
        }
        this.localNetwork?.stop();
        this.service.stop();
        this.state.peers.clear();
    }

    private addPeer(peer: Peer): void {
        if (this.state.peers.has(peer.peerPublicNodeId)) return;
        this.state.peers.set(peer.peerPublicNodeId, peer);
        this.state.alivePeersCount++;
        this.state.lastConnectionMs = Date.now();

        logger.info(`Peer added`, {
            peer:   peer.peerPublicNodeId.slice(0, 8),
            total:  this.state.alivePeersCount,
        });

        this.emit('peer:joined', {
            peerId: peer.peerPublicNodeId,
            total:  this.state.alivePeersCount,
        });

        // Inform new peer of our side choice
        if (this.game.myTeam && this.localNetwork) {
            this.localNetwork.sendSideChoiceToPeer(this.game.myTeam, peer);
        }

        // Inform new peer of current config so they can accept it
        if (this.localNetwork) {
            this.localNetwork.sendConfigProposalToPeer(this._gameConfig, this._configVersion, peer);
        }
    }

    private handlePeerDisconnect(peer: Peer): void {
        const peerId = peer.peerPublicNodeId;
        if (!this.state.peers.has(peerId)) return;

        this.state.peers.delete(peerId);
        this.state.alivePeersCount = Math.max(0, this.state.alivePeersCount - 1);

        logger.info(`Peer removed on disconnect`, {
            peer:  peerId.slice(0, 8),
            total: this.state.alivePeersCount,
        });

        this.emit('peer:left', {
            peerId,
            total: this.state.alivePeersCount,
        });

        // A disconnecting teammate shrinks the denominator — may push vote over threshold
        this.checkResignThreshold();
    }
}
