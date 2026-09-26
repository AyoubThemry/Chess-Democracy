import type { NetworkFactory } from './game-network.js';
import { LocalNetworkController } from './localnetwork/local-network-controller.js';
import { GlobalNetwork } from './globalnetwork/global-network.js';

/**
 * Every transport the app can play over. The UI lists these and the player
 * picks one before the game; Node is then created with that transport.
 */
export type NetworkKind = 'local' | 'global';

export interface NetworkOption {
    kind:      NetworkKind;
    available: boolean;
}

const NETWORKS: Record<NetworkKind, { available: boolean; create: NetworkFactory }> = {
    local:  { available: true, create: LocalNetworkController.create },
    global: GlobalNetwork,
};

export function networkOptions(): NetworkOption[] {
    return (Object.keys(NETWORKS) as NetworkKind[]).map(kind => ({ kind, available: NETWORKS[kind].available }));
}

/** The transport for `kind`. Throws for one that doesn't exist or isn't available yet. */
export function networkFactory(kind: string): NetworkFactory {
    const network = NETWORKS[kind as NetworkKind];
    if (!network)           throw new Error(`Unknown network: ${kind}`);
    if (!network.available) throw new Error(`The ${kind} network is not available yet`);
    return network.create;
}
