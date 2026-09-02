// contextBridge — exposes window.chessHive to the React renderer.
// Implements ChessHiveAPI from ipc-channels.ts exactly; nothing else is exposed.

import { contextBridge, ipcRenderer } from 'electron';

import {
    INVOKE,
    PUSH,
    ChessHiveAPI,
    Team,
} from './ipc-channels';

function listen<T>(channel: string, cb: (data: T) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, data: T) => cb(data);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
}

const api: ChessHiveAPI = {


    getIdentity: () =>
        ipcRenderer.invoke(INVOKE.NODE_GET_IDENTITY),

    getState: () =>
        ipcRenderer.invoke(INVOKE.NODE_GET_STATE),

    getPeers: () =>
        ipcRenderer.invoke(INVOKE.PEER_GET_ALL),

    setTeam: (team: Team) =>
        ipcRenderer.invoke(INVOKE.GAME_SET_TEAM, { team }),

    ready: () =>
        ipcRenderer.invoke(INVOKE.GAME_READY),

    submitMove: (move: string) =>
        ipcRenderer.invoke(INVOKE.GAME_SUBMIT_MOVE, { move }),

    resign: () =>
        ipcRenderer.invoke(INVOKE.GAME_RESIGN),

    unready: () =>
        ipcRenderer.invoke(INVOKE.GAME_UNREADY),

    setConfig: (voteWindowMs: number, maxRevotes: number, resignThreshold: number, resignWindowMs: number) =>
        ipcRenderer.invoke(INVOKE.GAME_SET_CONFIG, { voteWindowMs, maxRevotes, resignThreshold, resignWindowMs }),

    acceptConfig: () =>
        ipcRenderer.invoke(INVOKE.GAME_ACCEPT_CONFIG),

    castVote: (move: string) =>
        ipcRenderer.invoke(INVOKE.GAME_CAST_VOTE, { move }),

    getConfig: () =>
        ipcRenderer.invoke(INVOKE.NODE_GET_CONFIG),

    resetGame: () =>
        ipcRenderer.invoke(INVOKE.GAME_RESET),

    offerDraw: () =>
        ipcRenderer.invoke(INVOKE.GAME_OFFER_DRAW),

    respondToDraw: (accept: boolean) =>
        ipcRenderer.invoke(INVOKE.GAME_RESPOND_DRAW, { accept }),

    getIdentityPrefs: () =>
        ipcRenderer.invoke(INVOKE.IDENTITY_GET_PREFS),

    startNode: (identityPath?: string, forceNew?: boolean) =>
        ipcRenderer.invoke(INVOKE.IDENTITY_START, { identityPath, forceNew }),

    saveIdentityPref: (identityPath: string) =>
        ipcRenderer.invoke(INVOKE.IDENTITY_SAVE_PREF, { identityPath }),

    logout: () =>
        ipcRenderer.invoke(INVOKE.IDENTITY_LOGOUT),

    openIdentityFile: () =>
        ipcRenderer.invoke(INVOKE.IDENTITY_OPEN_FILE),

    on: {
    peerJoined:         (cb: (data: any) => void) => listen(PUSH.PEER_JOINED,          cb),
    peerLeft:           (cb: (data: any) => void) => listen(PUSH.PEER_LEFT,            cb),
    peerTeamUpdated:    (cb: (data: any) => void) => listen(PUSH.PEER_TEAM_UPDATED,    cb),
    peerReadyChanged:   (cb: (data: any) => void) => listen(PUSH.PEER_READY_CHANGED,   cb),
    waitingForSide:     (cb: (data: any) => void) => listen(PUSH.GAME_WAITING_SIDE,    cb),
    gameStarting:       (cb: (data: any) => void) => listen(PUSH.GAME_STARTING,        cb),
    gameStarted:        (cb: (data: any) => void) => listen(PUSH.GAME_STARTED,         cb),
    gameMove:           (cb: (data: any) => void) => listen(PUSH.GAME_MOVE,            cb),
    gameOver:           (cb: (data: any) => void) => listen(PUSH.GAME_OVER,            cb),
    configUpdated:      (cb: (data: any) => void) => listen(PUSH.CONFIG_UPDATED,       cb),
    configPeerAccepted: (cb: (data: any) => void) => listen(PUSH.CONFIG_PEER_ACCEPTED, cb),
    configSelfAccepted: (cb: (data: any) => void) => listen(PUSH.CONFIG_SELF_ACCEPTED, cb),
    voteWindowOpened:   (cb: (data: any) => void) => listen(PUSH.VOTE_WINDOW_OPENED,   cb),
    voteReceived:       (cb: (data: any) => void) => listen(PUSH.VOTE_RECEIVED,        cb),
    tallyDone:          (cb: (data: any) => void) => listen(PUSH.TALLY_DONE,           cb),
    revoteStarted:      (cb: (data: any) => void) => listen(PUSH.REVOTE_STARTED,       cb),
    gameReset:          (cb: (data: any) => void) => listen(PUSH.GAME_RESET,           cb),
    drawOffered:        (cb: (data: any) => void) => listen(PUSH.DRAW_OFFERED,          cb),
    drawDeclined:       (cb: (data: any) => void) => listen(PUSH.DRAW_DECLINED,         cb),
    resignVoteStarted:  (cb: (data: any) => void) => listen(PUSH.RESIGN_VOTE_STARTED,   cb),
    resignVoteUpdated:  (cb: (data: any) => void) => listen(PUSH.RESIGN_VOTE_UPDATED,   cb),
    resignVoteExpired:  (cb: (data: any) => void) => listen(PUSH.RESIGN_VOTE_EXPIRED,   cb),
},
};

// Expose as window.chessHive — the only thing the renderer can see
contextBridge.exposeInMainWorld('chessHive', api);
