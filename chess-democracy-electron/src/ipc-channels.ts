// Single source of truth for all IPC channel names and payload types.
// main.ts and preload.ts import from here — no string literals anywhere else.
// INVOKE = renderer → main → renderer (request/reply)
// PUSH   = main → renderer (one-way events)

export interface GameConfig {
    voteWindowMs:    number;
    maxRevotes:      number;
    resignThreshold: number;   // fraction (0–1) of connected team needed to resign
    resignWindowMs:  number;   // ms before an open resign vote auto-expires
}

export type Team      = 'white' | 'black';
export type GamePhase =
    | 'waiting_for_side'
    | 'waiting_for_ready'
    | 'waiting_for_peers'
    | 'starting'
    | 'in_progress'
    | 'finished';

export interface GameResult {
    winner: Team | 'draw' | null;
    reason: 'checkmate' | 'stalemate' | 'resignation' | 'disconnect' | 'draw_agreement' | 'revotes_exhausted' | 'timeout';
}

export interface RecordedMove {
    moveIndex:  number;
    move:       string;   // UCI e.g. "e2e4"
    senderKey:  string;   // full public key of sender
    fenBefore:  string;
    fenAfter:   string;
    timestamp:  number;
}


export interface PeerSummary {
    peerId:  string;   // full public key
    team:    Team | null;
    ready:   boolean;
    status:  'alive' | 'dead';
}


export interface GameSnapshot {
    phase:       GamePhase;
    gameId:      string;
    myTeam:      Team | null;
    currentTurn: Team;
    isMyTurn:    boolean;
    fen:         string;
    legalMoves:  string[];      // UCI strings for the current position
    moveHistory: RecordedMove[];
    result:      GameResult | null;
    startsAt:    number | null; // epoch ms — only set during 'starting' phase
}

// Every INVOKE channel returns one of these. ok: false carries the error string.
export type IpcResult<T = void> =
    | { ok: true;  value: T }
    | { ok: false; error: string };

// INVOKE channels — renderer → main → renderer

export const INVOKE = {

    NODE_GET_IDENTITY:  'node:get_identity',
    NODE_GET_STATE:     'node:get_state',
    PEER_GET_ALL:       'peer:get_all',
    GAME_SET_TEAM:      'game:set_team',
    GAME_READY:         'game:ready',
    GAME_SUBMIT_MOVE:   'game:submit_move',
    GAME_RESIGN:        'game:resign',
    GAME_UNREADY:       'game:unready',
    GAME_SET_CONFIG:    'game:set_config',
    GAME_ACCEPT_CONFIG: 'game:accept_config',
    GAME_CAST_VOTE:     'game:cast_vote',
    NODE_GET_CONFIG:    'node:get_config',
    GAME_RESET:         'game:reset',
    GAME_OFFER_DRAW:    'game:offer_draw',
    GAME_RESPOND_DRAW:  'game:respond_draw',
    IDENTITY_GET_PREFS: 'identity:get_prefs',
    IDENTITY_START:     'identity:start',
    IDENTITY_SAVE_PREF: 'identity:save_pref',
    IDENTITY_LOGOUT:    'identity:logout',
    IDENTITY_OPEN_FILE: 'identity:open_file',

} as const;

export type InvokeChannel = typeof INVOKE[keyof typeof INVOKE];
export interface InvokeMap {
    [INVOKE.NODE_GET_IDENTITY]: {
        payload: void;
        result:  IpcResult<{ publicKey: string; team: Team | null; phase: GamePhase }>;
    };
    [INVOKE.NODE_GET_STATE]: {
        payload: void;
        result:  IpcResult<GameSnapshot>;
    };
    [INVOKE.PEER_GET_ALL]: {
        payload: void;
        result:  IpcResult<PeerSummary[]>;
    };
    [INVOKE.GAME_SET_TEAM]: {
        payload: { team: Team };
        result:  IpcResult<void>;
    };
    [INVOKE.GAME_READY]: {
        payload: void;
        result:  IpcResult<void>;
    };
    [INVOKE.GAME_SUBMIT_MOVE]: {
        payload: { move: string };
        result:  IpcResult<GameSnapshot>;
    };
    [INVOKE.GAME_RESIGN]: {
        payload: void;
        result:  IpcResult<void>;
    };
    [INVOKE.GAME_UNREADY]: {
        payload: void;
        result:  IpcResult<void>;
    };
    [INVOKE.GAME_SET_CONFIG]: {
        payload: { voteWindowMs: number; maxRevotes: number; resignThreshold: number; resignWindowMs: number };
        result:  IpcResult<void>;
    };
    [INVOKE.GAME_ACCEPT_CONFIG]: {
        payload: void;
        result:  IpcResult<void>;
    };
    [INVOKE.GAME_CAST_VOTE]: {
        payload: { move: string };
        result:  IpcResult<void>;
    };
    [INVOKE.NODE_GET_CONFIG]: {
        payload: void;
        result:  IpcResult<ConfigSnapshot>;
    };
    [INVOKE.GAME_RESET]: {
        payload: void;
        result:  IpcResult<void>;
    };
    [INVOKE.GAME_OFFER_DRAW]: {
        payload: void;
        result:  IpcResult<void>;
    };
    [INVOKE.GAME_RESPOND_DRAW]: {
        payload: { accept: boolean };
        result:  IpcResult<void>;
    };
    [INVOKE.IDENTITY_GET_PREFS]: {
        payload: void;
        result:  IpcResult<{ remembered: boolean; identityPath: string | null }>;
    };
    [INVOKE.IDENTITY_START]: {
        payload: { identityPath?: string; forceNew?: boolean };
        result:  IpcResult<{ publicKey: string; identityPath: string }>;
    };
    [INVOKE.IDENTITY_SAVE_PREF]: {
        payload: { identityPath: string };
        result:  IpcResult<void>;
    };
    [INVOKE.IDENTITY_LOGOUT]: {
        payload: void;
        result:  IpcResult<void>;
    };
    [INVOKE.IDENTITY_OPEN_FILE]: {
        payload: void;
        result:  IpcResult<{ filePath: string | null }>;
    };
}

export interface ConfigSnapshot {
    config:           GameConfig;
    version:          number;
    selfAccepted:     boolean;
    peerAcceptedIds:  string[];  // peer public keys that accepted current version
}

// PUSH channels — main → renderer, one-way

export const PUSH = {

    PEER_JOINED:          'peer:joined',
    PEER_LEFT:            'peer:left',
    PEER_TEAM_UPDATED:    'peer:team_updated',
    PEER_READY_CHANGED:   'peer:ready_changed',
    GAME_WAITING_SIDE:    'game:waiting_for_side',
    GAME_STARTING:        'game:starting',
    GAME_STARTED:         'game:started',
    GAME_MOVE:            'game:move',
    GAME_OVER:            'game:over',
    CONFIG_UPDATED:       'config:updated',
    CONFIG_PEER_ACCEPTED: 'config:peer_accepted',
    CONFIG_SELF_ACCEPTED: 'config:self_accepted',
    VOTE_WINDOW_OPENED:   'vote:window_opened',
    VOTE_RECEIVED:        'vote:received',
    TALLY_DONE:           'tally:done',
    REVOTE_STARTED:       'revote:started',
    GAME_RESET:           'game:reset',
    DRAW_OFFERED:         'draw:offered',
    DRAW_DECLINED:        'draw:declined',
    RESIGN_VOTE_STARTED:  'resign:vote_started',
    RESIGN_VOTE_UPDATED:  'resign:vote_updated',
    RESIGN_VOTE_EXPIRED:  'resign:vote_expired',

} as const;

export type PushChannel = typeof PUSH[keyof typeof PUSH];

// Per-channel payload types for PUSH events
export interface PushMap {
    [PUSH.PEER_JOINED]: {
        peerId: string;
        total:  number;
    };
    [PUSH.PEER_LEFT]: {
        peerId: string;
        total:  number;
    };
    [PUSH.PEER_TEAM_UPDATED]: {
        peerId: string;
        team:   Team | null;
    };
    [PUSH.PEER_READY_CHANGED]: {
        peerId: string;
        ready:  boolean;
    };
    [PUSH.GAME_WAITING_SIDE]: {
        whites:     number;
        blacks:     number;
        waitingFor: Team;
    };
    [PUSH.GAME_STARTING]: {
        startsAt:    number;   // epoch ms
        countdownMs: number;
        myTeam:      Team | null;
    };
    [PUSH.GAME_STARTED]: {
        gameId:     string;
        myTeam:     Team | null;
        fen:        string;
        legalMoves: string[];
    };
    [PUSH.GAME_MOVE]: {
        move:       string;
        moveIndex:  number;
        senderTeam: Team;
        fen:        string;
        legalMoves: string[];
        isMyTurn:   boolean;
    };
    [PUSH.GAME_OVER]: {
        gameId:    string;
        result:    GameResult;
        lastFen:   string;
        moveCount: number;
    };
    [PUSH.CONFIG_UPDATED]: {
        voteWindowMs:    number;
        maxRevotes:      number;
        resignThreshold: number;
        resignWindowMs:  number;
        version:         number;
        proposerKey:     string;
    };
    [PUSH.CONFIG_PEER_ACCEPTED]: {
        peerId:  string;
        version: number;
    };
    [PUSH.CONFIG_SELF_ACCEPTED]: {
        version: number;
    };
    [PUSH.VOTE_WINDOW_OPENED]: {
        turnIndex:    number;
        windowCloseAt: number;
        voteWindowMs: number;
        isMyTurn:     boolean;
    };
    [PUSH.VOTE_RECEIVED]: {
        peerId:    string;
        turnIndex: number;
        move:      string;
    };
    [PUSH.TALLY_DONE]: {
        turnIndex:    number;
        move:         string;
        isTiebreak:   boolean;
        voteCount:    number;
        total:        number;
        appliedByTeam: Team;
        fen:          string;
        legalMoves:   string[];
        isMyTurn:     boolean;
    };
    [PUSH.REVOTE_STARTED]: {
        turnIndex:     number;
        revoteCount:   number;
        windowCloseAt: number;
        voteWindowMs:  number;
    };
    [PUSH.GAME_RESET]: Record<string, never>;
    [PUSH.DRAW_OFFERED]: {
        from:     string;
        fromSelf: boolean;
    };
    [PUSH.DRAW_DECLINED]: {
        by: string;
    };
    [PUSH.RESIGN_VOTE_STARTED]: {
        expiresAt: number;
    };
    [PUSH.RESIGN_VOTE_UPDATED]: {
        yesVotes:          number;
        connectedTeamSize: number;
    };
    [PUSH.RESIGN_VOTE_EXPIRED]: Record<string, never>;
}

// window.chessHive — full type exposed to React by preload.ts

export interface ChessHiveAPI {
    getIdentity():      Promise<InvokeMap[typeof INVOKE.NODE_GET_IDENTITY]['result']>;
    getState():         Promise<InvokeMap[typeof INVOKE.NODE_GET_STATE]['result']>;
    getPeers():         Promise<InvokeMap[typeof INVOKE.PEER_GET_ALL]['result']>;
    setTeam(team: Team): Promise<InvokeMap[typeof INVOKE.GAME_SET_TEAM]['result']>;
    ready():            Promise<InvokeMap[typeof INVOKE.GAME_READY]['result']>;
    submitMove(move: string): Promise<InvokeMap[typeof INVOKE.GAME_SUBMIT_MOVE]['result']>;
    resign():           Promise<InvokeMap[typeof INVOKE.GAME_RESIGN]['result']>;
    unready():          Promise<InvokeMap[typeof INVOKE.GAME_UNREADY]['result']>;
    setConfig(voteWindowMs: number, maxRevotes: number, resignThreshold: number, resignWindowMs: number): Promise<InvokeMap[typeof INVOKE.GAME_SET_CONFIG]['result']>;
    acceptConfig():     Promise<InvokeMap[typeof INVOKE.GAME_ACCEPT_CONFIG]['result']>;
    castVote(move: string): Promise<InvokeMap[typeof INVOKE.GAME_CAST_VOTE]['result']>;
    getConfig():        Promise<InvokeMap[typeof INVOKE.NODE_GET_CONFIG]['result']>;
    resetGame():        Promise<InvokeMap[typeof INVOKE.GAME_RESET]['result']>;
    getIdentityPrefs(): Promise<InvokeMap[typeof INVOKE.IDENTITY_GET_PREFS]['result']>;
    startNode(identityPath?: string, forceNew?: boolean): Promise<InvokeMap[typeof INVOKE.IDENTITY_START]['result']>;
    saveIdentityPref(identityPath: string): Promise<InvokeMap[typeof INVOKE.IDENTITY_SAVE_PREF]['result']>;
    logout():           Promise<InvokeMap[typeof INVOKE.IDENTITY_LOGOUT]['result']>;
    openIdentityFile(): Promise<InvokeMap[typeof INVOKE.IDENTITY_OPEN_FILE]['result']>;
    offerDraw():        Promise<InvokeMap[typeof INVOKE.GAME_OFFER_DRAW]['result']>;
    respondToDraw(accept: boolean): Promise<InvokeMap[typeof INVOKE.GAME_RESPOND_DRAW]['result']>;

    on: {
        peerJoined(      cb: (data: PushMap[typeof PUSH.PEER_JOINED])       => void): () => void;
        peerLeft(        cb: (data: PushMap[typeof PUSH.PEER_LEFT])         => void): () => void;
        peerTeamUpdated(  cb: (data: PushMap[typeof PUSH.PEER_TEAM_UPDATED])   => void): () => void;
        peerReadyChanged( cb: (data: PushMap[typeof PUSH.PEER_READY_CHANGED]) => void): () => void;
        waitingForSide(  cb: (data: PushMap[typeof PUSH.GAME_WAITING_SIDE]) => void): () => void;
        gameStarting(    cb: (data: PushMap[typeof PUSH.GAME_STARTING])     => void): () => void;
        gameStarted(     cb: (data: PushMap[typeof PUSH.GAME_STARTED])      => void): () => void;
        gameMove(        cb: (data: PushMap[typeof PUSH.GAME_MOVE])         => void): () => void;
        gameOver(           cb: (data: PushMap[typeof PUSH.GAME_OVER])             => void): () => void;
        configUpdated(      cb: (data: PushMap[typeof PUSH.CONFIG_UPDATED])        => void): () => void;
        configPeerAccepted( cb: (data: PushMap[typeof PUSH.CONFIG_PEER_ACCEPTED])  => void): () => void;
        configSelfAccepted( cb: (data: PushMap[typeof PUSH.CONFIG_SELF_ACCEPTED])  => void): () => void;
        voteWindowOpened(   cb: (data: PushMap[typeof PUSH.VOTE_WINDOW_OPENED])    => void): () => void;
        voteReceived(       cb: (data: PushMap[typeof PUSH.VOTE_RECEIVED])         => void): () => void;
        tallyDone(          cb: (data: PushMap[typeof PUSH.TALLY_DONE])            => void): () => void;
        revoteStarted(      cb: (data: PushMap[typeof PUSH.REVOTE_STARTED])        => void): () => void;
        gameReset(          cb: (data: PushMap[typeof PUSH.GAME_RESET])             => void): () => void;
        drawOffered(        cb: (data: PushMap[typeof PUSH.DRAW_OFFERED])           => void): () => void;
        drawDeclined(       cb: (data: PushMap[typeof PUSH.DRAW_DECLINED])          => void): () => void;
        resignVoteStarted(  cb: (data: PushMap[typeof PUSH.RESIGN_VOTE_STARTED])    => void): () => void;
        resignVoteUpdated(  cb: (data: PushMap[typeof PUSH.RESIGN_VOTE_UPDATED])    => void): () => void;
        resignVoteExpired(  cb: (data: PushMap[typeof PUSH.RESIGN_VOTE_EXPIRED])    => void): () => void;
    };
}

// Augment the global Window interface so TypeScript knows about window.chessHive
// in the renderer process without any imports needed in React components.
declare global {
    interface Window {
        chessHive: ChessHiveAPI;
    }
}
