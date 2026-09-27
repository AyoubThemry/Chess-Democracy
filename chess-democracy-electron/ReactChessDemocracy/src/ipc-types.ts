/**
 * The IPC contract, for React: the same types main.ts and preload.ts use.
 *
 * Type-only, so nothing crosses the Vite project boundary at runtime; the
 * import is erased before the dev server or the bundler ever sees it.
 */

export type {
    GameConfig,
    ConfigSnapshot,
    Team,
    GamePhase,
    GameResult,
    RecordedMove,
    PeerSummary,
    GameSnapshot,
    IpcResult,
    NetworkKind,
    NetworkOption,
    Visibility,
    RoomReach,
    PublicGame,
    PushMap,
    ChessDemocracyAPI,
} from '../../src/ipc-channels';
