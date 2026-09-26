import { describe, it, expect } from 'vitest';
import { networkOptions, networkFactory } from '../network/networks.js';
import { LocalNetworkController } from '../network/localnetwork/local-network-controller.js';

describe('network registry', () => {
    it('offers local now and lists global as not available yet', () => {
        expect(networkOptions()).toEqual([
            { kind: 'local',  available: true  },
            { kind: 'global', available: false },
        ]);
    });

    it('hands out the LAN transport for local', () => {
        expect(networkFactory('local')).toBe(LocalNetworkController.create);
    });

    it('refuses a network that is not available, or does not exist', () => {
        expect(() => networkFactory('global')).toThrow(/not available yet/);
        expect(() => networkFactory('bluetooth')).toThrow(/Unknown network/);
    });
});
