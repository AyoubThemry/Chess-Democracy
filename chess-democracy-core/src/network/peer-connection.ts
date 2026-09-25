import { WebSocket } from 'ws';

/**
 * Everything game code needs from a transport: send a packet, close, and
 * know whether sending would work.
 *
 * The LAN version uses WebSockets. A different transport (hyperswarm, raw
 * UDP) only has to provide one of these per peer; nothing above the network
 * layer knows or cares which one it's talking to.
 */
export interface PeerConnection {
    readonly isOpen: boolean;
    send(packet: string): void;
    close(): void;
}

export class WebSocketConnection implements PeerConnection {
    constructor(readonly socket: WebSocket) {}

    get isOpen(): boolean { return this.socket.readyState === WebSocket.OPEN; }
    send(packet: string): void { this.socket.send(packet); }
    close(): void { this.socket.close(); }
}
