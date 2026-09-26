import { describe, it, expect } from 'vitest';
import { networkOptions, networkFactory } from '../network/networks.js';
import { LocalNetworkController } from '../network/localnetwork/local-network-controller.js';

describe('network registry', () => {
    it('offers both, and says which one needs a room code', () => {
        expect(networkOptions()).toEqual([
            { kind: 'local',  available: true, needsRoom: false },
            { kind: 'global', available: true, needsRoom: true  },
        ]);
    });

    it('hands out the LAN transport for local', () => {
        expect(networkFactory('local')).toBe(LocalNetworkController.create);
    });

    it('needs a room code for global', () => {
        expect(() => networkFactory('global')).toThrow(/room code/);
        expect(() => networkFactory('global', { room: '   ' })).toThrow(/room code/);
        expect(typeof networkFactory('global', { room: 'abcd-2345' })).toBe('function');
    });

    it('refuses a network that does not exist', () => {
        expect(() => networkFactory('bluetooth')).toThrow(/Unknown network/);
    });
});
