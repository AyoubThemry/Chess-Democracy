import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getOrCreateIdentity } from './generateidentity.js';

export interface IdentityPair {
    publicKey:  string;
    privateKey: string;
}

/**
 * Loads identity from disk if it exists, otherwise generates a new one and
 * writes it. This keeps a node's public key stable across restarts so peers
 * can recognise it.
 */
export function loadOrCreateIdentity(filePath: string): IdentityPair {
    if (existsSync(filePath)) {
        try {
            const pem = readFileSync(filePath, 'utf8');
            return getOrCreateIdentity(pem);
        } catch {
            // Corrupt or unreadable — fall through to regenerate
        }
    }

    const identity = getOrCreateIdentity();
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, identity.privateKey, { mode: 0o600 });
    return identity;
}
