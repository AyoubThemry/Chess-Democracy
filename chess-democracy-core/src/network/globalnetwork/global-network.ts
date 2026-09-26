import type { NetworkFactory } from '../game-network.js';

/**
 * Playing over the internet. Not built yet: this is where Phase 2 goes.
 *
 * To add it, write a transport that implements GameNetwork (see
 * ../game-network.ts and "Adding a transport" in the README), point `create`
 * at it, and set `available` to true. The app's network screen offers it as
 * soon as it's available; nothing else needs to change.
 */
export const GlobalNetwork: { available: boolean; create: NetworkFactory } = {
    available: false,
    create: async () => {
        throw new Error('Playing over the internet is not available yet');
    },
};
