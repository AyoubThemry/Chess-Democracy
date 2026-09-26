import { describe, it, expect } from 'vitest';
import { newRoomCode, normalizeRoomCode } from '../roomCode';

describe('room codes', () => {
    it('look like "k7mq-x2pd" and avoid look-alike characters', () => {
        for (let i = 0; i < 200; i++) {
            const code = newRoomCode();
            expect(code).toMatch(/^[a-z2-9]{4}-[a-z2-9]{4}$/);
            expect(code).not.toMatch(/[01ilo]/);
        }
    });

    it('are different each time', () => {
        const codes = new Set(Array.from({ length: 200 }, newRoomCode));
        expect(codes.size).toBe(200);
    });

    it('accept what a player types, however they type it', () => {
        expect(normalizeRoomCode('  K7MQ-X2PD ')).toBe('k7mq-x2pd');
        expect(normalizeRoomCode('k7mq - x2pd')).toBe('k7mq-x2pd');
        expect(normalizeRoomCode('   ')).toBe('');
    });
});
