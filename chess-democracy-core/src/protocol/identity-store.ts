import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, sep } from 'node:path';
import { getOrCreateIdentity } from './generateidentity.js';

export interface IdentityPair {
    publicKey:  string;
    privateKey: string;
}

/**
 * Moves a pre-rename identity into place if the caller's path doesn't exist yet.
 *
 * The app stored keys under ~/.chess-hive/ before the rename to Chess Democracy.
 * Without this an upgrading user silently becomes a different player: new
 * keypair, new public key, and peers no longer recognise them.
 *
 * Safe to remove once no installs predate the rename.
 */
function migrateLegacyIdentity(filePath: string): void {
    if (existsSync(filePath)) return;
    const legacy = filePath.replace(
        `${sep}.chess-democracy${sep}`,
        `${sep}.chess-hive${sep}`,
    );
    if (legacy === filePath || !existsSync(legacy)) return;
    try {
        mkdirSync(dirname(filePath), { recursive: true });
        renameSync(legacy, filePath);
    } catch {
        // Best effort. A failed migration just means a fresh keypair.
    }
}

/**
 * Loads identity from disk if it exists, otherwise generates a new one and
 * writes it. This keeps a node's public key stable across restarts so peers
 * can recognise it.
 */
export function loadOrCreateIdentity(filePath: string): IdentityPair {
    migrateLegacyIdentity(filePath);

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
