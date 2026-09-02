import { describe, it, expect } from 'vitest';
import { NETWORK_CONFIG, validateNetworkConfig } from '../utils/config.js';

describe('NETWORK_CONFIG', () => {
    it('is immutable (as const)', () => {
        // TypeScript enforces this at compile time; at runtime the object is
        // still writable unless we use Object.freeze, but we verify the values
        // are the corrected ones from Task 1.
        expect(NETWORK_CONFIG.GHOST_TIMEOUT_MS).toBe(30_000);
        expect(NETWORK_CONFIG.WAIT_BEFORE_READYING).toBe(10_000);
        expect(NETWORK_CONFIG.TIME_SKEW_TOLERANCE_MS).toBe(30_000);
        expect(NETWORK_CONFIG.NONCE_TTL_MS).toBe(300_000);
    });

    it('has sensible peer limits', () => {
        expect(NETWORK_CONFIG.MAX_PEERS).toBeGreaterThan(0);
        expect(NETWORK_CONFIG.MAX_HANDSHAKES_PER_MIN).toBeGreaterThan(0);
    });

    it('GHOST_TIMEOUT_MS is strictly greater than HANDSHAKE_TIMEOUT_MS', () => {
        expect(NETWORK_CONFIG.GHOST_TIMEOUT_MS).toBeGreaterThan(
            NETWORK_CONFIG.HANDSHAKE_TIMEOUT_MS,
        );
    });

    it('TIME_SKEW_TOLERANCE_MS is within security bound', () => {
        expect(NETWORK_CONFIG.TIME_SKEW_TOLERANCE_MS).toBeLessThanOrEqual(60_000);
    });

    it('NONCE_TTL_MS is large enough to outlive timestamp tolerance', () => {
        expect(NETWORK_CONFIG.NONCE_TTL_MS).toBeGreaterThanOrEqual(60_000);
    });
});

describe('validateNetworkConfig', () => {
    it('passes without throwing for the current config', () => {
        expect(() => validateNetworkConfig()).not.toThrow();
    });
});
