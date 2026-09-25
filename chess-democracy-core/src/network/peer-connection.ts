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
    private held: Buffer[] | null = [];
    private handler?: (data: Buffer) => void;

    /**
     * Create this as soon as the handshake completes. Messages can arrive in
     * the same tick, before the owner has attached a handler; without holding
     * them they were silently dropped. That lost whatever a peer sends right
     * after connecting: its side choice and config in the lobby, and the
     * snapshot a reconnecting player needs to catch up.
     */
    constructor(readonly socket: WebSocket) {
        socket.on('message', (data: Buffer) => {
            if (this.handler) this.handler(data);
            else this.held?.push(data);
        });
    }

    /** Delivers anything that arrived early, then everything after. */
    onMessage(handler: (data: Buffer) => void): void {
        this.handler = handler;
        const early = this.held ?? [];
        this.held = null;
        for (const data of early) handler(data);
    }

    get isOpen(): boolean { return this.socket.readyState === WebSocket.OPEN; }
    send(packet: string): void { this.socket.send(packet); }
    close(): void { this.socket.close(); }
}
