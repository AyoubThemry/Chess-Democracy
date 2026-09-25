import { LocalNetworkController }  from "../network/localnetwork/local-network-controller.js";
import type { GameNetwork, NetworkFactory } from "../network/game-network.js";
import { Peer, PeerStatus }         from "../network/peer.js";
import { loadOrCreateIdentity }    from "../protocol/identity-store.js";
import { getOrCreateIdentity }     from "../protocol/generateidentity.js";
import { GAME_CONFIG, VOTE_CONFIG } from "../utils/config.js";
import { logger }                  from "../utils/logger.js";
import { GameState, checkTeamBalance, Team, GameResult } from "../game/game-state.js";
import { VotingState, GameConfig, DEFAULT_GAME_CONFIG, TallyResult, tallyMoves } from "../game/voting-state.js";
import { verifyTally, checkVote, TallyClaim } from "../game/verify-tally.js";
import type { GameSnapshot } from "../game/snapshot.js";
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
    return join(homedir(), '.chess-democracy', 'identity.pem');
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
    private _moveTimeoutStartedAt = 0;

    // Which side has a draw offer out, if any.
    private _drawOfferedBy: Team | null = null;

    // Who's in the current game, and their teams. Empty outside a game.
    private readonly roster = new Map<string, Team>();
    // After a player reconnects, don't count votes until states are exchanged.
    private _resyncGraceUntil = 0;
    private _gameMode:        'direct' | 'voting' = 'voting';

    // Resign vote state
    private _resignVote: {
        yesVoters: Set<string>;
        expiresAt: number;
        timer:     NodeJS.Timeout;
    } | null = null;

    // Network controller
    private net?:    GameNetwork;
    private stopped = false;

    /** The port the WebSocket server is actually bound to (0 until boot completes). */
    public boundPort: number = 0;

    /** Exposed for integration tests — do not use in production code. */
    get network(): GameNetwork | undefined { return this.net; }

    /**
     * @param createNetwork the transport. Defaults to the LAN one (WebSockets +
     *   mDNS); pass a different factory to play over another network.
     */
    constructor(
        identityPath?: string,
        private readonly createNetwork: NetworkFactory = LocalNetworkController.create,
    ) {
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
            this.net?.broadcastSideChoice(team);
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

        this.net?.broadcastConfigProposal(this._gameConfig, this._configVersion);

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
        this.net?.broadcastConfigAccept(this._configVersion);

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

        // Keep the signed copy: if we end up as master, it goes in the tally.
        const signed = this.net?.broadcastVote(this._voting.turnIndex, this._voting.round, uciMove, now);
        if (signed) this._voting.attachSigned(this.identity.publicKey, signed);
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
        this._drawOfferedBy = this.game.myTeam;
        this.net?.broadcastDrawOffer();
        this.emit('draw:offered', { from: this.identity.publicKey, fromSelf: true, byOpponent: false });
        logger.info(`Draw offered by self`);
        return 'ok';
    }

    public respondToDraw(accept: boolean): string {
        if (this.game.phase !== 'in_progress') return `error:not_in_progress`;
        // Only the side that was offered the draw can take it. Otherwise one
        // player could offer and a teammate accept, settling the game for the
        // whole team without the other side agreeing.
        if (!this._drawOfferedBy || this._drawOfferedBy === this.game.myTeam) {
            return 'error:no_draw_offer_from_opponent';
        }
        this._drawOfferedBy = null;
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
            this.net?.broadcastDrawResponse(false);
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
        this.state.lastConnectionMs = Date.now();

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
                // Drop acceptances of older proposals, but keep any for this
                // one that arrived before the proposal itself did.
                const earlyAccepts = [...this._peerAcceptedVersions]
                    .filter(([key, v]) => v === version && key !== senderKey)
                    .map(([key]) => key);
                for (const [key, v] of this._peerAcceptedVersions) {
                    if (v < version) this._peerAcceptedVersions.delete(key);
                }
                this._peerAcceptedVersions.set(senderKey, version);

                if (sameConfig) {
                    // Already on this exact config — auto-accept and reply
                    this._selfAcceptedConfigVersion = version;
                    this.net?.broadcastConfigAccept(version);
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
                // config:updated resets the UI's list to just the proposer.
                for (const peerId of earlyAccepts) {
                    this.emit('config:peer_accepted', { peerId, version });
                }
            },

            onConfigAccept: (senderKey, version) => {
                if (version < this._configVersion) return;
                this._peerAcceptedVersions.set(senderKey, version);
                // With 3+ players, someone's accept can overtake the proposal it
                // accepts. Keep it; it counts once the proposal gets here.
                if (version > this._configVersion) return;
                logger.info(`Peer accepted config`, { peer: senderKey.slice(0, 8), version });
                this.emit('config:peer_accepted', { peerId: senderKey, version });
            },

            onDrawOffer: (senderKey) => {
                if (this.game.phase !== 'in_progress') return;
                const team = this.teamOf(senderKey);
                if (!team) return;
                this._drawOfferedBy = team;
                // Teammates see the offer too, but only the other side may answer it.
                this.emit('draw:offered', { from: senderKey, fromSelf: false, byOpponent: team !== this.game.myTeam });
            },

            onDrawResponse: (senderKey, accepted) => {
                // accepted=true path: accepter already broadcast game_over; handleGameOver handles it.
                // declined path: let offeror know via the draw:declined event.
                if (!accepted) {
                    this._drawOfferedBy = null;
                    this.emit('draw:declined', { by: senderKey });
                }
            },

            onTallyResult:  (senderKey, claim)    => this.handleTallyResult(senderKey, claim),
            onGameSnapshot: (senderKey, snapshot) => this.handleGameSnapshot(senderKey, snapshot),

            onVote: (senderKey, turnIndex, round, move, _timestamp, signed) => {
                if (!this._voting || this._voting.turnIndex !== turnIndex || this._voting.round !== round) {
                    logger.warn(`Vote for wrong/inactive window`, {
                        turnIndex,
                        round,
                        activeTurn:  this._voting?.turnIndex,
                        activeRound: this._voting?.round,
                    });
                    return;
                }

                // castVote() checks both of these for our own votes. A peer's
                // vote arrives here without either, so check them again.
                const senderTeam = this.allPeers.get(senderKey)?.team ?? null;
                if (senderTeam !== this.game.currentTurn) {
                    logger.warn(`Vote from a player not on the side to move`, {
                        peer: senderKey.slice(0, 8),
                        senderTeam,
                        turn: this.game.currentTurn,
                    });
                    return;
                }
                if (!this.game.legalMoves.includes(move)) {
                    logger.warn(`Illegal move in peer vote`, { peer: senderKey.slice(0, 8), move });
                    return;
                }

                const result = this._voting.castVote(senderKey, move, this.getSynchronizedTime(), signed);
                if (result === 'ok') {
                    logger.info(`Peer vote recorded`, { peer: senderKey.slice(0, 8), move, turnIndex });
                    this.emit('vote:received', { peerId: senderKey, turnIndex, move });
                } else {
                    logger.warn(`Peer vote rejected`, { peer: senderKey.slice(0, 8), reason: result });
                }
            },

            onResignVote: (senderKey) => {
                if (this.game.phase !== 'in_progress') return;

                // Resigning is a team decision. SendResignVote only targets
                // teammates, but that's the sender being polite, not a check.
                const senderTeam = this.allPeers.get(senderKey)?.team ?? null;
                if (!this.game.myTeam || senderTeam !== this.game.myTeam) {
                    logger.warn(`Resign vote from a non-teammate ignored`, {
                        peer: senderKey.slice(0, 8),
                        senderTeam,
                    });
                    return;
                }

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

        this.createNetwork({
            identity:              this.identity,
            callbacks,
            getAllPeers:           () => this.allPeers,
            getAlivePeersCount:    () => this.totalAlivePeersCount,
            adjustAlivePeersCount: (sign, amount) => this.adjustAlivePeersCount(sign, amount),
            acceptingConnection:   (peerKey) => this.acceptsConnection(peerKey),
        }, port).then(({ network, boundPort }) => {
            if (this.stopped) {   // stop() ran while the transport was starting
                network.stop();
                return;
            }
            this.net       = network;
            this.boundPort = boundPort;
            logger.info(`Node online`, { port: boundPort });

            network.on('peer:connected',    (p: Peer) => this.addPeer(p));
            network.on('peer:disconnected', (p: Peer) => this.handlePeerDisconnect(p));
            network.start();
        }).catch((err: unknown) => {
            logger.error(`Network failed to start`, { message: err instanceof Error ? err.message : String(err) });
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
        if (!this.net) {
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
        this.net?.broadcastReady(myTeam);
        this.net?.sync();
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
        const isMaster = this.masterKey() === this.identity.publicKey;
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

        this.recordRoster();
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

    private openVotingWindow(turnIndex: number, windowStartTime: number, round = 0): void {
        const windowCloseAt = windowStartTime + this._gameConfig.voteWindowMs;
        this._voting = new VotingState(turnIndex, windowCloseAt, round);

        const tallyTime = windowCloseAt + VOTE_CONFIG.VOTE_GRACE_MS;
        const delay     = Math.max(0, tallyTime - this.getSynchronizedTime());
        this._voteTimer = setTimeout(() => this.onTallyDue(), delay);

        // Per-turn timeout: if no move is committed within MOVE_TIMEOUT_MS, end the game.
        clearTimeout(this._moveTimeoutTimer);
        this._moveTimeoutStartedAt = this.getSynchronizedTime();
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

    // Counting
    //
    // Every node used to count whatever votes it happened to receive. Two
    // nodes with different vote sets played different moves and the game
    // silently stopped (#24). Now only the master counts. It publishes the
    // result together with every signed vote it counted, and every other node
    // checks the signatures and recounts before applying it.

    /**
     * The window has closed. The master counts; everyone else waits for its
     * result. If the master has gone quiet, whoever is master by the next
     * check takes over, since every node already holds every vote.
     */
    private onTallyDue(): void {
        if (!this._voting) return;

        // Hold off while a returning player's state is still being exchanged,
        // and whenever too few players are connected to count safely.
        const settling = Date.now() < this._resyncGraceUntil;
        if (!settling && this.hasQuorum() && this.masterKey() === this.identity.publicKey) {
            this.countAndPublish();
            return;
        }
        if (!this.hasQuorum()) {
            logger.warn(`Too few players connected to count votes, waiting`, {
                connected: this.connectedPlayers().length,
                players:   this.roster.size,
            });
        }
        this._voteTimer = setTimeout(() => this.onTallyDue(), VOTE_CONFIG.TALLY_WAIT_MS);
    }

    private countAndPublish(): void {
        const voting = this._voting!;
        const votes  = voting.signedVotes();
        // Count exactly the list we publish, so everyone recounts the same thing.
        const result = tallyMoves(votes.map(v => v.payload.move));

        this.net?.broadcastTallyResult({
            turnIndex: voting.turnIndex,
            round:     voting.round,
            fenBefore: this.game.fen,
            outcome:   result.outcome,
            move:      result.outcome === 'winner' ? result.move : null,
            votes,
        });
        logger.info(`Tally published`, {
            turnIndex: voting.turnIndex,
            round:     voting.round,
            outcome:   result.outcome,
            votes:     votes.length,
        });

        this.applyTally(result);
    }

    private handleTallyResult(senderKey: string, claim: TallyClaim): void {
        if (this.game.phase !== 'in_progress' || !this._voting) return;

        if (senderKey !== this.masterKey()) {
            logger.warn(`tally_result from a peer that isn't the master ignored`, { sender: senderKey.slice(0, 8) });
            return;
        }
        if (claim.turnIndex !== this._voting.turnIndex || claim.round !== this._voting.round) {
            logger.debug(`Stale tally_result ignored`, { turnIndex: claim.turnIndex, round: claim.round });
            return;
        }

        const verdict = verifyTally(claim, {
            turnIndex:  this._voting.turnIndex,
            round:      this._voting.round,
            fen:        this.game.fen,
            sideToMove: this.game.currentTurn,
            legalMoves: this.game.legalMoves,
            teamOf:     key => this.teamOf(key),
        });
        if (!verdict.ok) {
            this.stopOutOfSync(verdict.reason, senderKey);
            return;
        }

        clearTimeout(this._voteTimer);
        this._voteTimer = undefined;
        this.applyTally(verdict.result);
    }

    // Resync
    //
    // When a player reconnects mid-game, both sides send each other a
    // snapshot. Whoever is behind replays the moves they missed and joins the
    // open vote window, including the votes already cast in it.

    private sendSnapshotTo(peer: Peer): void {
        if (!this._voting) return;
        this.net?.sendGameSnapshotToPeer({
            gameId:        this.game.gameId,
            moves:         this.game.moveHistory.map(m => m.move),
            round:         this._voting.round,
            windowCloseAt: this._voting.windowCloseAt,
            votes:         this._voting.signedVotes(),
        }, peer);
    }

    /**
     * The moves in a snapshot are trusted as far as each one being legal in
     * turn; they aren't re-proven with the votes that chose them. That's fine
     * between friends, and a snapshot can only extend our history, never
     * rewrite it: a history that differs stops the game as out of sync.
     */
    private handleGameSnapshot(senderKey: string, snap: GameSnapshot): void {
        if (this.game.phase !== 'in_progress' || !this.roster.has(senderKey)) return;
        if (snap.gameId !== this.game.gameId || !Array.isArray(snap.moves))  return;

        const mine = this.game.moveHistory.map(m => m.move);
        for (let i = 0; i < Math.min(mine.length, snap.moves.length); i++) {
            if (mine[i] !== snap.moves[i]) {
                this.stopOutOfSync('histories_differ', senderKey);
                return;
            }
        }
        if (snap.moves.length < mine.length) return;   // they're behind; ours catches them up

        const behind      = snap.moves.length > mine.length;
        const missedRound = !behind && !!this._voting && snap.round > this._voting.round;

        if (behind) {
            logger.info(`Catching up from a snapshot`, {
                from:   senderKey.slice(0, 8),
                missed: snap.moves.length - mine.length,
            });
            for (const move of snap.moves.slice(mine.length)) {
                if (!this.replayMove(move, senderKey)) return;
            }
        }

        if (behind || missedRound) {
            clearTimeout(this._voteTimer);
            this._voteTimer = undefined;
            this.openVotingWindow(
                snap.moves.length,
                snap.windowCloseAt - this._gameConfig.voteWindowMs,
                snap.round,
            );
        }

        // Pick up votes cast in this window that never reached us. Each one
        // gets the same check the master's votes do.
        const voting = this._voting;
        if (!voting || voting.turnIndex !== snap.moves.length || voting.round !== snap.round) return;
        const ctx = {
            turnIndex:  voting.turnIndex,
            round:      voting.round,
            sideToMove: this.game.currentTurn,
            legalMoves: this.game.legalMoves,
            teamOf:     (key: string) => this.teamOf(key),
        };
        for (const vote of Array.isArray(snap.votes) ? snap.votes : []) {
            if (checkVote(vote, ctx)) continue;
            if (voting.addVerifiedVote(vote) === 'ok') {
                this.emit('vote:received', {
                    peerId:    vote.payload.key,
                    turnIndex: voting.turnIndex,
                    move:      vote.payload.move,
                });
            }
        }
    }

    /** Plays one move from a snapshot as a tally would. False once the game has stopped. */
    private replayMove(move: string, senderKey: string): boolean {
        const turnIndex = this.game.moveHistory.length;
        const team      = this.game.currentTurn;
        const applied   = this.game.applyMove({
            moveIndex: turnIndex,
            move,
            senderKey: '',
            fenBefore: this.game.fen,
            timestamp: this.getSynchronizedTime(),
        }, team);

        if (applied !== 'ok') {
            this.stopOutOfSync('snapshot_move_illegal', senderKey);
            return false;
        }

        this.emit('tally:done', {
            turnIndex,
            move,
            isTiebreak:    false,
            voteCount:     0,
            total:         0,
            appliedByTeam: team,
            fen:           this.game.fen,
            legalMoves:    this.game.legalMoves,
            isMyTurn:      this.game.isMyTurn,
        });

        if (this.game.phase === 'finished' && this.game.result) {
            clearTimeout(this._voteTimer);
            clearTimeout(this._moveTimeoutTimer);
            this._voteTimer        = undefined;
            this._moveTimeoutTimer = undefined;
            this._voting           = null;
            this.emit('game:over', {
                gameId:    this.game.gameId,
                result:    this.game.result,
                lastFen:   this.game.fen,
                moveCount: this.game.moveHistory.length,
            });
            return false;
        }
        return true;
    }

    private teamOf(publicKey: string): Team | null {
        if (this.roster.has(publicKey))        return this.roster.get(publicKey)!;
        if (publicKey === this.identity.publicKey) return this.game.myTeam;
        return (this.allPeers.get(publicKey)?.team ?? null) as Team | null;
    }

    /**
     * The master's result didn't check out, or our position no longer matches
     * its. Carrying on would mean playing a different game from everyone else,
     * so end it and say why instead of freezing.
     */
    private stopOutOfSync(reason: string, peerKey: string): void {
        logger.error(`Out of sync with a peer, stopping the game`, { peer: peerKey.slice(0, 8), reason });

        this.game.finish({ winner: null, reason: 'desync' });
        if (this._resignVote) {
            clearTimeout(this._resignVote.timer);
            this._resignVote = null;
        }
        clearTimeout(this._voteTimer);
        clearTimeout(this._moveTimeoutTimer);
        this._voteTimer        = undefined;
        this._moveTimeoutTimer = undefined;
        this._voting           = null;

        this.emit('game:over', {
            gameId:    this.game.gameId,
            result:    this.game.result!,
            lastFen:   this.game.fen,
            moveCount: this.game.moveHistory.length,
        });
    }

    private applyTally(result: TallyResult): void {
        if (!this._voting) return;

        const voting = this._voting;

        logger.info(`Applying tally`, {
            turnIndex: voting.turnIndex,
            round:     voting.round,
            outcome:   result.outcome,
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
        this._voteTimer = setTimeout(() => this.onTallyDue(), delay);

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

        // Only the master's game_start counts. Accepting any lower key let a
        // middle-ranked node in a 3+ player game adopt the wrong one.
        if (senderKey !== this.masterKey()) {
            logger.warn(`game_start from a peer that isn't the master ignored`, { sender: senderKey.slice(0, 8) });
            return;
        }

        // The master only sends this after seeing everyone ready, us included,
        // so it's valid even if our own 2s ready check hasn't fired yet.
        // Dropping it in that case left us on gameId '' with our own start
        // time, up to 2s off from everyone else.
        if (this.game.phase !== 'waiting_for_peers' && this.game.phase !== 'starting') return;

        logger.info(`Adopting game_start from master`, {
            master:   senderKey.slice(0, 8),
            gameId:   theirGameId.slice(0, 8),
            startsAt: new Date(theirStart).toISOString(),
        });

        clearInterval(this.readyCheckInterval);
        this.readyCheckInterval = undefined;
        if (this.gameStartTimeout) clearTimeout(this.gameStartTimeout);
        this.recordRoster();
        this.game.beginCountdown(theirGameId, theirStart);
        this.scheduleGameBegin(theirStart);
    }

    /** Lowest public key among us and our peers. It picks the gameId and start time. */
    private masterKey(): string {
        return this.connectedPlayers().sort()[0];
    }

    // Roster
    //
    // Who is in this game, fixed when the countdown starts. Before, "the game"
    // meant "whoever is connected right now", so a new app appearing on the
    // LAN mid-game joined the peer list and could even become master.

    /** Everyone in the game (us included) who is currently connected. Outside a game, everyone connected. */
    private connectedPlayers(): string[] {
        const connected = [this.identity.publicKey, ...this.allPeers.keys()];
        return this.roster.size ? connected.filter(k => this.roster.has(k)) : connected;
    }

    /**
     * Votes are only counted while more than half the players are connected.
     * Without this a player who drops out is alone, counts as master, and
     * keeps playing a game of their own that can't be merged back.
     */
    private hasQuorum(): boolean {
        return this.roster.size === 0 || this.connectedPlayers().length * 2 > this.roster.size;
    }

    private recordRoster(): void {
        this.roster.clear();
        this.roster.set(this.identity.publicKey, this.game.myTeam!);
        for (const [key, peer] of this.allPeers) {
            if (peer.team === 'white' || peer.team === 'black') this.roster.set(key, peer.team);
        }
    }

    /** No key: could anyone connect now? With a key: may this peer connect? */
    private acceptsConnection(peerKey?: string): boolean {
        if (this.state.acceptingConnection) return true;          // lobby open
        return peerKey === undefined ? this.roster.size > 0      // a player might be coming back
                                     : this.roster.has(peerKey);
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

    /**
     * Returns why a peer's game_over should be ignored, or null to accept it.
     *
     * Peers only ever send three kinds: a draw they accepted, a move timeout,
     * and their own side's resignation. Checkmate, stalemate and running out
     * of revotes are never sent. Every node reaches those itself when it
     * applies the move, so a peer claiming one is either lying or out of sync.
     */
    private rejectGameOver(msg: Record<string, unknown>, senderKey: string): string | null {
        if (this.game.phase !== 'in_progress') return 'not_in_progress';
        if (msg.gameId !== this.game.gameId)   return 'wrong_game';

        const result     = msg.result as { winner?: unknown; reason?: unknown } | undefined;
        const senderTeam = this.allPeers.get(senderKey)?.team ?? null;

        switch (result?.reason) {
            case 'draw_agreement':
                if (result.winner !== 'draw')          return 'draw_with_a_winner';
                if (!this._drawOfferedBy)              return 'no_draw_was_offered';
                // Accepted by the side that offered it: nobody on the other side agreed.
                if (senderTeam === this._drawOfferedBy) return 'draw_accepted_by_offering_side';
                return null;

            case 'timeout': {
                if (result.winner !== null) return 'timeout_with_a_winner';
                // Every node runs the same per-turn timer, so ours should be
                // about to fire too. Otherwise the claim is early.
                const elapsed = this.getSynchronizedTime() - this._moveTimeoutStartedAt;
                return elapsed >= GAME_CONFIG.MOVE_TIMEOUT_MS - GAME_CONFIG.MOVE_TIMEOUT_SLACK_MS
                    ? null
                    : 'timeout_too_early';
            }

            case 'resignation': {
                // You can only resign for your own side.
                if (senderTeam !== 'white' && senderTeam !== 'black') return 'unknown_sender';
                const opponent = senderTeam === 'white' ? 'black' : 'white';
                return result.winner === opponent ? null : 'resigned_for_the_other_side';
            }

            default:
                return 'reason_peers_never_send';
        }
    }

    private handleGameOver(msg: Record<string, unknown>, senderKey: string): void {
        const rejected = this.rejectGameOver(msg, senderKey);
        if (rejected) {
            logger.warn(`game_over from peer ignored`, { sender: senderKey.slice(0, 8), reason: rejected });
            return;
        }

        const result = msg.result as GameResult;
        this.game.finish({ winner: result.winner, reason: result.reason });

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
        this.net?.broadcastResignVoteToTeam(myTeam);

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

        this.net?.broadcastUnready();
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
        this.roster.clear();
        this._drawOfferedBy = null;
        this._resyncGraceUntil = 0;
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
        this.stopped = true;
        this.net?.stop();
        this.state.peers.clear();
    }

    private addPeer(peer: Peer): void {
        const key      = peer.peerPublicNodeId;
        const existing = this.state.peers.get(key);
        if (existing === peer) return;

        // Mid-game, only players from this game may join. Discovery still
        // dials any app it finds on the network; those connections end here.
        const inGame = this.roster.size > 0;
        if (inGame && !this.roster.has(key)) {
            logger.info(`Connection from outside this game closed`, { peer: key.slice(0, 8) });
            peer.connection.close();
            return;
        }

        // Two connections to the same peer are normal (discovery and a direct
        // connect can both happen). Keep the one we have while it works; only
        // a reconnect after the old one died replaces it. Replacing live
        // connections makes both sides close the one the other is using.
        if (existing && existing.status === PeerStatus.Alive && existing.connection.isOpen) return;

        if (existing) {
            logger.info(`Peer reconnected, replacing its old connection`, { peer: key.slice(0, 8) });
            existing.connection.close();
            this.state.peers.set(key, peer);
        } else {
            this.state.peers.set(key, peer);
            this.state.alivePeersCount++;
        }
        this.state.lastConnectionMs = Date.now();

        if (inGame) {
            // A new connection starts blank. The roster remembers who they are.
            peer.team  = this.roster.get(key)!;
            peer.ready = true;
        }

        logger.info(`Peer added`, {
            peer:   peer.peerPublicNodeId.slice(0, 8),
            total:  this.state.alivePeersCount,
        });

        this.emit('peer:joined', {
            peerId: peer.peerPublicNodeId,
            total:  this.state.alivePeersCount,
        });

        if (inGame) {
            // Tell them where the game stands, and hold off counting until
            // they've told us the same. Whoever is behind catches up.
            if (this.game.phase === 'in_progress') {
                this._resyncGraceUntil = Date.now() + GAME_CONFIG.RESYNC_GRACE_MS;
                this.sendSnapshotTo(peer);
            }
            return;
        }

        // Lobby: tell the new peer our side and the current config.
        if (this.game.myTeam && this.net) {
            this.net.sendSideChoiceToPeer(this.game.myTeam, peer);
        }
        if (this.net) {
            this.net.sendConfigProposalToPeer(this._gameConfig, this._configVersion, peer);
        }
    }

    private handlePeerDisconnect(peer: Peer): void {
        const peerId = peer.peerPublicNodeId;
        // Only if it's still the connection we're using. When a player
        // reconnects, the old connection closes after it was replaced.
        if (this.state.peers.get(peerId) !== peer) return;

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
