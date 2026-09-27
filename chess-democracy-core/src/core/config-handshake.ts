import { GameConfig, DEFAULT_GAME_CONFIG } from "../game/voting-state.js";
import { VOTE_CONFIG } from "../utils/config.js";

/** What a peer's proposal did to ours. */
export type ProposalOutcome =
    | { kind: 'stale' }                              // older than what we have
    | { kind: 'invalid' }                            // out of range, ignored
    | { kind: 'matched'; earlyAccepts: string[] }    // the config we'd already accepted: accept it again
    | { kind: 'changed'; earlyAccepts: string[] };   // a new config for the player to accept
// earlyAccepts: peers whose accept of this version arrived before the proposal did.

/** What a peer's accept did: too old, ahead of its proposal (kept for later), or counted. */
export type AcceptOutcome = 'stale' | 'early' | 'counted';

/**
 * The game settings, and who has agreed to them.
 *
 * Anyone in the lobby can propose settings; each proposal gets a higher
 * version, and nobody can press Ready until every player has accepted the
 * current one. This class holds the rules and the state. Node does the
 * sending and tells the UI.
 */
export class ConfigHandshake {
    private _config:       GameConfig    = { ...DEFAULT_GAME_CONFIG };
    private _version                     = 0;
    private _selfAccepted: number | null = 0;   // 0: the default, accepted automatically
    private readonly _peerAccepted       = new Map<string, number>();

    get config():               GameConfig          { return { ...this._config }; }
    get version():              number              { return this._version; }
    get selfAcceptedVersion():  number | null       { return this._selfAccepted; }
    get peerAcceptedVersions(): Map<string, number> { return new Map(this._peerAccepted); }

    /** Our own proposal. Returns an error, or null once it's the current config. */
    propose(voteWindowMs: number, maxRevotes: number, resignThreshold?: number, resignWindowMs?: number): string | null {
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

        this._version++;
        this._config = {
            voteWindowMs,
            maxRevotes,
            resignThreshold: resignThreshold ?? this._config.resignThreshold,
            resignWindowMs:  resignWindowMs  ?? this._config.resignWindowMs,
        };
        this._selfAccepted = this._version;
        this._peerAccepted.clear();
        return null;
    }

    /** We accept the current config. Returns its version. */
    acceptCurrent(): number {
        this._selfAccepted = this._version;
        return this._version;
    }

    receiveProposal(senderKey: string, config: GameConfig, version: number): ProposalOutcome {
        if (version < this._version) return { kind: 'stale' };

        if (
            typeof config?.voteWindowMs !== 'number' ||
            typeof config?.maxRevotes   !== 'number' ||
            config.voteWindowMs < VOTE_CONFIG.MIN_VOTE_WINDOW_MS ||
            config.voteWindowMs > VOTE_CONFIG.MAX_VOTE_WINDOW_MS ||
            config.maxRevotes < 0 || config.maxRevotes > 10
        ) {
            return { kind: 'invalid' };
        }

        const sameConfig =
            version === this._version &&
            config.voteWindowMs === this._config.voteWindowMs &&
            config.maxRevotes   === this._config.maxRevotes   &&
            this._selfAccepted  === this._version;

        this._version = version;
        this._config  = config;
        // Drop acceptances of older proposals, but keep any for this one that
        // arrived before the proposal itself did.
        const earlyAccepts = [...this._peerAccepted]
            .filter(([key, v]) => v === version && key !== senderKey)
            .map(([key]) => key);
        for (const [key, v] of this._peerAccepted) {
            if (v < version) this._peerAccepted.delete(key);
        }
        this._peerAccepted.set(senderKey, version);

        if (sameConfig) {
            this._selfAccepted = version;
            return { kind: 'matched', earlyAccepts };
        }
        this._selfAccepted = null;
        return { kind: 'changed', earlyAccepts };
    }

    receiveAccept(senderKey: string, version: number): AcceptOutcome {
        if (version < this._version) return 'stale';
        this._peerAccepted.set(senderKey, version);
        // With 3+ players, someone's accept can overtake the proposal it
        // accepts. Keep it; it counts once the proposal gets here.
        return version > this._version ? 'early' : 'counted';
    }

    /** Have we and every one of these peers accepted the current config? */
    allAccepted(peerKeys: Iterable<string>): boolean {
        const peers = [...peerKeys];
        if (peers.length === 0) return true;   // solo: nobody to disagree
        if (this._selfAccepted !== this._version) return false;
        return peers.every(key => (this._peerAccepted.get(key) ?? -1) === this._version);
    }

    reset(): void {
        this._config       = { ...DEFAULT_GAME_CONFIG };
        this._version      = 0;
        this._selfAccepted = 0;
        this._peerAccepted.clear();
    }
}
