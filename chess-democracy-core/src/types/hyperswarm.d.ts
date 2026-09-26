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

    export default class Hyperswarm extends EventEmitter {
        constructor(options?: SwarmOptions);
        readonly keyPair: KeyPair;
        join(topic: Buffer, options?: { server?: boolean; client?: boolean }): PeerDiscovery;
        flush(): Promise<void>;
        destroy(): Promise<void>;
        on(event: 'connection', listener: (socket: Duplex & { remotePublicKey: Buffer }, info: PeerInfo) => void): this;
        on(event: string, listener: (...args: any[]) => void): this;
    }
}
