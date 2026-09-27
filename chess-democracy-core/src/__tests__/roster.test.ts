import { describe, it, expect } from 'vitest';
import { Roster } from '../core/roster.js';

describe('Roster', () => {
    it('outside a game, everyone connected counts and there is always quorum', () => {
        const r = new Roster();
        expect(r.inGame).toBe(false);
        expect(r.playing(['b', 'a', 'c'])).toEqual(['b', 'a', 'c']);
        expect(r.master(['b', 'a', 'c'])).toBe('a');
        expect(r.hasQuorum([])).toBe(true);
    });

    it('records only players with a side', () => {
        const r = new Roster();
        r.record([['a', 'white'], ['b', 'black'], ['c', null]]);
        expect(r.size).toBe(2);
        expect(r.teamOf('b')).toBe('black');
        expect(r.has('c')).toBe(false);
    });

    it('in a game, outsiders are ignored and cannot become master', () => {
        const r = new Roster();
        r.record([['m', 'white'], ['n', 'black']]);
        expect(r.playing(['a', 'm', 'n'])).toEqual(['m', 'n']);
        expect(r.master(['a', 'm', 'n'])).toBe('m');
    });

    it('needs more than half the players connected to count', () => {
        const r = new Roster();
        r.record([['a', 'white'], ['b', 'black'], ['c', 'white'], ['d', 'black']]);
        expect(r.hasQuorum(['a', 'b', 'c'])).toBe(true);
        expect(r.hasQuorum(['a', 'b'])).toBe(false);         // exactly half is not enough
        expect(r.hasQuorum(['a', 'b', 'x', 'y'])).toBe(false); // outsiders don't count
    });

    it('clear ends the game', () => {
        const r = new Roster();
        r.record([['a', 'white']]);
        r.clear();
        expect(r.inGame).toBe(false);
    });
});
