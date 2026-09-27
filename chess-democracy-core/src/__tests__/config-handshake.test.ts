import { describe, it, expect, beforeEach } from 'vitest';
import { ConfigHandshake } from '../core/config-handshake.js';
import { DEFAULT_GAME_CONFIG } from '../game/voting-state.js';

const config = (voteWindowMs = 20_000, maxRevotes = 2) =>
    ({ ...DEFAULT_GAME_CONFIG, voteWindowMs, maxRevotes });

describe('ConfigHandshake', () => {
    let h: ConfigHandshake;
    beforeEach(() => { h = new ConfigHandshake(); });

    it('starts on the default settings, already accepted', () => {
        expect(h.config).toEqual(DEFAULT_GAME_CONFIG);
        expect(h.version).toBe(0);
        expect(h.selfAcceptedVersion).toBe(0);
    });

    it('a valid proposal of ours becomes current and accepted by us', () => {
        expect(h.propose(20_000, 2)).toBeNull();
        expect(h.version).toBe(1);
        expect(h.config).toMatchObject({ voteWindowMs: 20_000, maxRevotes: 2 });
        expect(h.selfAcceptedVersion).toBe(1);
    });

    it('keeps the resign settings when a proposal leaves them out', () => {
        h.propose(20_000, 2, 0.8, 30_000);
        h.propose(25_000, 1);
        expect(h.config).toMatchObject({ resignThreshold: 0.8, resignWindowMs: 30_000 });
    });

    it('rejects out-of-range proposals without changing anything', () => {
        expect(h.propose(1_000, 2)).toBe('error:invalid_vote_window:1000');
        expect(h.propose(20_000, 11)).toBe('error:invalid_max_revotes:11');
        expect(h.propose(20_000, 2, 0.4)).toBe('error:invalid_resign_threshold:0.4');
        expect(h.propose(20_000, 2, 0.7, 5_000)).toBe('error:invalid_resign_window:5000');
        expect(h.version).toBe(0);
    });

    it("a peer's new proposal needs our accept", () => {
        expect(h.receiveProposal('p1', config(), 1)).toEqual({ kind: 'changed', earlyAccepts: [] });
        expect(h.selfAcceptedVersion).toBeNull();
        expect(h.allAccepted(['p1'])).toBe(false);
        h.acceptCurrent();
        expect(h.allAccepted(['p1'])).toBe(true);
    });

    it('ignores stale and invalid proposals', () => {
        h.propose(20_000, 2);
        h.propose(25_000, 2);
        expect(h.receiveProposal('p1', config(), 1)).toEqual({ kind: 'stale' });
        expect(h.receiveProposal('p1', config(999), 3)).toEqual({ kind: 'invalid' });
        expect(h.version).toBe(2);
    });

    it('re-accepts a proposal matching what we already agreed to', () => {
        h.propose(20_000, 2);
        expect(h.receiveProposal('p1', config(20_000, 2), 1)).toEqual({ kind: 'matched', earlyAccepts: [] });
        expect(h.selfAcceptedVersion).toBe(1);
    });

    it('keeps an accept that overtook its proposal, and counts it once the proposal arrives', () => {
        expect(h.receiveAccept('p2', 1)).toBe('early');
        expect(h.receiveProposal('p1', config(), 1)).toEqual({ kind: 'changed', earlyAccepts: ['p2'] });
        h.acceptCurrent();
        expect(h.allAccepted(['p1', 'p2'])).toBe(true);
    });

    it('drops accepts of older versions when a newer proposal arrives', () => {
        h.receiveProposal('p1', config(), 1);
        expect(h.receiveAccept('p2', 1)).toBe('counted');
        h.receiveProposal('p1', config(25_000), 2);
        h.acceptCurrent();
        expect(h.allAccepted(['p1', 'p2'])).toBe(false);
        expect(h.receiveAccept('p2', 1)).toBe('stale');
    });

    it('alone, there is nobody to disagree', () => {
        h.receiveProposal('p1', config(), 1);
        expect(h.allAccepted([])).toBe(true);
    });

    it('reset goes back to the accepted defaults', () => {
        h.propose(20_000, 2);
        h.receiveAccept('p1', 1);
        h.reset();
        expect(h.config).toEqual(DEFAULT_GAME_CONFIG);
        expect(h.version).toBe(0);
        expect(h.selfAcceptedVersion).toBe(0);
        expect(h.peerAcceptedVersions.size).toBe(0);
    });
});
