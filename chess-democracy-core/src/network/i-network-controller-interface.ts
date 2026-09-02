import { EventEmitter } from 'events';

export interface INetworkController extends EventEmitter {
    // Every controller must have a start and stop
    start(): void;
    stop(): void;

    // Events that must be emitted:
    // 'peer:connected' -> (peer: Peer)
}