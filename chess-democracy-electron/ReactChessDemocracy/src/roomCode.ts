// Room codes for playing over the internet. Whoever has the code can join,
// so it's random, and it's written without look-alike characters (0/o, 1/l/i)
// so it survives being read out over the phone.

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** A fresh code like "k7mq-x2pd". */
export function newRoomCode(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    const chars = Array.from(bytes, b => ALPHABET[b % ALPHABET.length]).join('');
    return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/** What the player typed, the way the core compares it. Empty if it isn't a usable code. */
export function normalizeRoomCode(input: string): string {
    return input.trim().toLowerCase().replace(/\s+/g, '');
}
