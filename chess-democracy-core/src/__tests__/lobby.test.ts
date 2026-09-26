import { describe, it, expect } from 'vitest';
import { signListing, readListing } from '../network/globalnetwork/lobby.js';
import { getOrCreateIdentity } from '../protocol/generateidentity.js';
import { signMessage } from '../protocol/verifysignsignature.js';

const host    = getOrCreateIdentity();
const summary = { open: true, players: 3, whites: 2, blacks: 1 };

function tamper(line: string, change: (p: Record<string, unknown>) => void, resign = true): string {
    const packet = JSON.parse(line);
    change(packet.payload);
    if (resign) packet.signature = signMessage(JSON.stringify(packet.payload), host.privateKey);
    return JSON.stringify(packet);
}

describe('public game listings', () => {
    it('round-trips a signed listing', () => {
        const game = readListing(signListing(host, 'k7mq-x2pd', summary));
        expect(game).toMatchObject({ room: 'k7mq-x2pd', hostKey: host.publicKey, players: 3, whites: 2, blacks: 1 });
    });

    it('rejects a listing edited after it was signed', () => {
        const line = tamper(signListing(host, 'k7mq-x2pd', summary), p => { p.room = 'evil-room'; }, false);
        expect(readListing(line)).toBeNull();
    });

    it('rejects a listing signed by someone other than the key it names', () => {
        const packet = JSON.parse(signListing(host, 'k7mq-x2pd', summary));
        packet.payload.key = getOrCreateIdentity().publicKey;
        expect(readListing(JSON.stringify(packet))).toBeNull();
    });

    it('rejects stale listings and implausible ones', () => {
        const line = signListing(host, 'k7mq-x2pd', summary);
        expect(readListing(line, Date.now() + 10 * 60_000)).toBeNull();                        // old
        expect(readListing(tamper(line, p => { p.players = -1; }))).toBeNull();
        expect(readListing(tamper(line, p => { p.players = 100_000; }))).toBeNull();
        expect(readListing(tamper(line, p => { p.room = '<script>'; }))).toBeNull();          // odd room code
        expect(readListing(tamper(line, p => { p.type = 'hello'; }))).toBeNull();
    });

    it('ignores garbage', () => {
        expect(readListing('not json')).toBeNull();
        expect(readListing('{}')).toBeNull();
    });
});
