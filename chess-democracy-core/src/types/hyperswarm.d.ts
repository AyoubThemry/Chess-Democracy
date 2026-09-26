// Minimal types for the parts of hyperswarm / hyperdht this project uses.
// Neither package ships its own.

declare module 'hyperdht' {
    export interface KeyPair { publicKey: Buffer; secretKey: Buffer }
    const DHT: { keyPair(seed?: Buffer): KeyPair };
    export default DHT;
}

declare module 'hyperdht/testnet.js' {
    export interface Testnet {
        bootstrap: Array<{ host: string; port: number }>;
        destroy(): Promise<void>;
    }
    export default function createTestnet(size?: number): Promise<Testnet>;
}

declare module 'hyperswarm' {
    import type { Duplex } from 'stream';
    import type { EventEmitter } from 'events';
    import type { KeyPair } from 'hyperdht';

    export interface PeerInfo { publicKey: Buffer }

    export interface PeerDiscovery {
        flushed(): Promise<void>;
        refresh(options?: { client?: boolean; server?: boolean }): Promise<void>;
        destroy(): Promise<void>;
    }

    export interface SwarmOptions {
        keyPair?:   KeyPair;
        bootstrap?: Array<{ host: string; port: number }>;
        maxPeers?:  number;
    }

    export interface SwarmDHT {
        readonly host:       string | null;   // our address as the internet sees it
        readonly port:       number;
        readonly firewalled: boolean;
        readonly randomized: boolean;         // the router picks a new port per destination
        readonly stats: {
            punches:  { consistent: number; random: number; open: number };
            relaying: { attempts: number; successes: number; aborts: number };
        };
        fullyBootstrapped(): Promise<void>;
    }

    export default class Hyperswarm extends EventEmitter {
        constructor(options?: SwarmOptions);
        readonly keyPair:    KeyPair;
        readonly dht:        SwarmDHT;
        readonly peers:      Map<string, PeerInfo>;   // found on our topics, reached or not
        readonly connecting: number;
        readonly stats: { connects: { client: { attempted: number; opened: number; closed: number } } };
        join(topic: Buffer, options?: { server?: boolean; client?: boolean }): PeerDiscovery;
        flush(): Promise<void>;
        destroy(): Promise<void>;
        on(event: 'connection', listener: (socket: Duplex & { remotePublicKey: Buffer }, info: PeerInfo) => void): this;
        on(event: string, listener: (...args: any[]) => void): this;
    }
}
