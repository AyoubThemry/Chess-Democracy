import type { Duplex } from 'stream';
import type { PeerConnection } from '../peer-connection.js';

// A packet is one JSON document. JSON.stringify never emits a raw newline, so
// a newline cleanly ends one packet and starts the next.
const DELIMITER = '\n';

// Nothing we send comes near this. A peer streaming more without a newline is
// either broken or trying to make us buffer forever.
const MAX_PACKET_BYTES = 1_000_000;

/**
 * A peer reached through hyperswarm: an end-to-end encrypted stream rather
 * than a message socket, so packets are framed with newlines here.
 */
export class HyperswarmConnection implements PeerConnection {
    private partial = '';
    private held: string[] | null = [];
    private handler?: (packet: string) => void;

    constructor(readonly socket: Duplex) {
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => this.receive(chunk));
        // Errors surface as 'close' too; without a listener they'd crash the process.
        socket.on('error', () => {});
        // The other side finished. We never use a half-open stream, and without
        // closing our half 'close' never fires, so the disconnect goes unnoticed.
        socket.on('end', () => socket.destroy());
    }

    get isOpen(): boolean {
        return !this.socket.destroyed && this.socket.writable;
    }

    send(packet: string): void {
        this.socket.write(packet + DELIMITER);
    }

    close(): void {
        this.socket.destroy();
    }

    /** Delivers packets that arrived before a handler was attached, then everything after. */
    onMessage(handler: (packet: string) => void): void {
        this.handler = handler;
        const early = this.held ?? [];
        this.held = null;
        for (const packet of early) handler(packet);
    }

    onClose(handler: () => void): void {
        this.socket.once('close', handler);
    }

    private receive(chunk: string): void {
        this.partial += chunk;
        if (this.partial.length > MAX_PACKET_BYTES) {
            this.close();
            return;
        }
        let end: number;
        while ((end = this.partial.indexOf(DELIMITER)) !== -1) {
            const packet = this.partial.slice(0, end);
            this.partial = this.partial.slice(end + 1);
            if (!packet) continue;
            if (this.handler) this.handler(packet);
            else this.held?.push(packet);
        }
    }
}
