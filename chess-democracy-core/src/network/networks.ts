import type { NetworkFactory } from './game-network.js';
import { LocalNetworkController } from './localnetwork/local-network-controller.js';
import { HyperswarmNetwork } from './globalnetwork/hyperswarm-network.js';

/**
 * Every transport the app can play over. The UI lists these and the player
 * picks one before the game; Node is then created with that transport.
 */
export type NetworkKind = 'local' | 'global';

export interface NetworkOption {
    kind:      NetworkKind;
    available: boolean;
    /** Players on this network find each other by a shared room code. */
    needsRoom: boolean;
}

/** What the player chose alongside the network. */
export interface NetworkChoice {
    room?: string;
}

const NETWORKS: Record<NetworkKind, { available: boolean; needsRoom: boolean; make(choice: NetworkChoice): NetworkFactory }> = {
    local: {
        available: true,
        needsRoom: false,
        make: () => LocalNetworkController.create,
    },
    global: {
        available: true,
        needsRoom: true,
        make: ({ room }) => {
            if (!room?.trim()) throw new Error('A room code is needed to play over the internet');
            return HyperswarmNetwork.create({ room });
        },
    },
};

export function networkOptions(): NetworkOption[] {
    return (Object.keys(NETWORKS) as NetworkKind[]).map(kind => ({
        kind,
        available: NETWORKS[kind].available,
        needsRoom: NETWORKS[kind].needsRoom,
    }));
}

/** The transport for `kind`. Throws for one that doesn't exist, isn't available, or is missing its room. */
export function networkFactory(kind: string, choice: NetworkChoice = {}): NetworkFactory {
    const network = NETWORKS[kind as NetworkKind];
    if (!network)           throw new Error(`Unknown network: ${kind}`);
    if (!network.available) throw new Error(`The ${kind} network is not available yet`);
    return network.make(choice);
}
