export const NETWORK_CONFIG = {
    MAX_PEERS: 150,
    // GOSSIP_TTL: 6,
    HANDSHAKE_TIMEOUT_MS: 5000,       // 5s  – unchanged, reasonable
    GHOST_TIMEOUT_MS: 300_000,             // 30s – peers unresponsive beyond this are marked dead
    WAIT_BEFORE_READYING: 10000,       // 10s – was 60000 (60 s) – shorter settle time for LAN
    NETWORK_BACKLOG: 500,
    TIME_SKEW_TOLERANCE_MS: 30000,     // 30s – used in handshake timestamp check (was 120 s inline magic number)
    MAX_HANDSHAKES_PER_MIN: 20,        // rate-limit guard
    NONCE_TTL_MS: 300_000,             // 5 min – how long a seen nonce is remembered to block replays
} as const;

export const GAME_CONFIG = {
    READY_CHECK_INTERVAL_MS:  2_000,  // how often to poll peer ready status
    READY_TIMEOUT_MS:        30_000,  // abort if not all peers ready within this
    GAME_START_COUNTDOWN_MS: 10_000,  // countdown from all-ready to game-begin
    MOVE_TIMEOUT_MS:        120_000,  // 2 min per move before forfeit (future use)
} as const;

export const VOTE_CONFIG = {
    DEFAULT_VOTE_WINDOW_MS:    30_000,  // default time each team has to vote
    DEFAULT_MAX_REVOTES:            3,  // max re-votes before game is abandoned
    MIN_VOTE_WINDOW_MS:         5_000,
    MAX_VOTE_WINDOW_MS:       120_000,
    VOTE_GRACE_MS:                500,  // extra ms after window close before tally
    DEFAULT_RESIGN_THRESHOLD:    0.67,  // fraction of connected team needed to resign
    DEFAULT_RESIGN_WINDOW_MS:  60_000,  // 1 min — resign vote auto-expires after this
} as const;

/**
 * Call once at startup. Throws with a clear message if any value is out of
 * an acceptable range so misconfiguration is caught before the node goes live.
 */
export function validateNetworkConfig(): void {
    const errors: string[] = [];

    if (NETWORK_CONFIG.MAX_PEERS <= 0)
        errors.push(`MAX_PEERS must be > 0 (got ${NETWORK_CONFIG.MAX_PEERS})`);

    if (NETWORK_CONFIG.HANDSHAKE_TIMEOUT_MS < 1000)
        errors.push(`HANDSHAKE_TIMEOUT_MS must be >= 1000 ms (got ${NETWORK_CONFIG.HANDSHAKE_TIMEOUT_MS})`);

    if (NETWORK_CONFIG.GHOST_TIMEOUT_MS <= NETWORK_CONFIG.HANDSHAKE_TIMEOUT_MS)
        errors.push(`GHOST_TIMEOUT_MS must be > HANDSHAKE_TIMEOUT_MS (got ${NETWORK_CONFIG.GHOST_TIMEOUT_MS})`);

    if (NETWORK_CONFIG.WAIT_BEFORE_READYING < 5000)
        errors.push(`WAIT_BEFORE_READYING must be >= 5000 ms (got ${NETWORK_CONFIG.WAIT_BEFORE_READYING})`);

    if (NETWORK_CONFIG.TIME_SKEW_TOLERANCE_MS > 60000)
        errors.push(`TIME_SKEW_TOLERANCE_MS should be <= 60000 ms for security (got ${NETWORK_CONFIG.TIME_SKEW_TOLERANCE_MS})`);

    if (NETWORK_CONFIG.MAX_HANDSHAKES_PER_MIN <= 0)
        errors.push(`MAX_HANDSHAKES_PER_MIN must be > 0 (got ${NETWORK_CONFIG.MAX_HANDSHAKES_PER_MIN})`);

    if (NETWORK_CONFIG.NONCE_TTL_MS < 60_000)
        errors.push(`NONCE_TTL_MS must be >= 60000 ms (got ${NETWORK_CONFIG.NONCE_TTL_MS})`);

    if (errors.length > 0) {
        const msg = `Config validation failed:\n  • ${errors.join('\n  • ')}`;
        // Use process.stderr directly — logger may not be ready yet at startup
        process.stderr.write(`❌ ${msg}\n`);
        throw new Error(msg);
    }

    // Safe to use process.stdout here — logger may not be ready yet
    process.stdout.write(`✅ [Config] All values validated.\n`);
}
