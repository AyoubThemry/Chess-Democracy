import { describe, it, expect } from 'vitest';
import { signMessage, verifySignature } from '../protocol/verifysignsignature.js';
import { getOrCreateIdentity }          from '../protocol/generateidentity.js';

describe('getOrCreateIdentity', () => {
    it('generates a 64-char hex public key', () => {
        const { publicKey } = getOrCreateIdentity();
        expect(publicKey).toHaveLength(64);
        expect(publicKey).toMatch(/^[a-f0-9]{64}$/);
    });

    it('generates a PEM private key', () => {
        const { privateKey } = getOrCreateIdentity();
        expect(privateKey).toContain('BEGIN PRIVATE KEY');
        expect(privateKey).toContain('END PRIVATE KEY');
    });

    it('generates unique key pairs on every call', () => {
        const a = getOrCreateIdentity();
        const b = getOrCreateIdentity();
        expect(a.publicKey).not.toBe(b.publicKey);
        expect(a.privateKey).not.toBe(b.privateKey);
    });

    it('derives the correct public key from a provided private key', () => {
        const original = getOrCreateIdentity();
        const derived  = getOrCreateIdentity(original.privateKey);
        expect(derived.publicKey).toBe(original.publicKey);
    });

    it('throws on an invalid private key string', () => {
        expect(() => getOrCreateIdentity('not-a-pem-key')).toThrow();
    });
});

describe('signMessage + verifySignature', () => {
    const identity = getOrCreateIdentity();

    it('verifies a valid signature', () => {
        const message   = JSON.stringify({ type: 'handshake', port: 3000 });
        const signature = signMessage(message, identity.privateKey);
        expect(verifySignature(message, signature, identity.publicKey)).toBe(true);
    });

    it('rejects a tampered message', () => {
        const message   = JSON.stringify({ type: 'handshake', port: 3000 });
        const signature = signMessage(message, identity.privateKey);
        const tampered  = JSON.stringify({ type: 'handshake', port: 9999 });
        expect(verifySignature(tampered, signature, identity.publicKey)).toBe(false);
    });

    it('rejects a wrong public key', () => {
        const other     = getOrCreateIdentity();
        const message   = JSON.stringify({ type: 'ready' });
        const signature = signMessage(message, identity.privateKey);
        expect(verifySignature(message, signature, other.publicKey)).toBe(false);
    });

    it('rejects a corrupted signature', () => {
        const message   = JSON.stringify({ type: 'ready' });
        const signature = signMessage(message, identity.privateKey);
        const corrupted = signature.slice(0, -4) + 'XXXX';
        expect(verifySignature(message, corrupted, identity.publicKey)).toBe(false);
    });

    it('rejects an empty signature', () => {
        const message = JSON.stringify({ type: 'ready' });
        expect(verifySignature(message, '', identity.publicKey)).toBe(false);
    });

    it('rejects an invalid public key (wrong length)', () => {
        const message   = JSON.stringify({ type: 'ready' });
        const signature = signMessage(message, identity.privateKey);
        expect(verifySignature(message, signature, 'tooshort')).toBe(false);
    });

    it('handles an empty message correctly', () => {
        const signature = signMessage('', identity.privateKey);
        expect(verifySignature('', signature, identity.publicKey)).toBe(true);
    });

    it('produces different signatures for different messages', () => {
        const sig1 = signMessage('msg-a', identity.privateKey);
        const sig2 = signMessage('msg-b', identity.privateKey);
        expect(sig1).not.toBe(sig2);
    });
});
