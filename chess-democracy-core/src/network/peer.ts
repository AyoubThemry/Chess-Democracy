import type { PeerConnection } from './peer-connection.js';

export interface PeerData {
    peerPublicNodeId: string;
    ip: string;
    port: number;
}

export enum PeerStatus {
    Alive = 'alive',
    Dead  = 'dead',
}

export class Peer {
    private data: PeerData;
    public readonly connection: PeerConnection;
    public lastSeen: number = Date.now();          // for ghost detection
    public status:   PeerStatus = PeerStatus.Alive;
    public ready:    boolean = false;              // ready state for game coordination
    public team:     string | null = null;         // 'white' | 'black' | null

    constructor(data: PeerData, connection: PeerConnection) {
        this.data       = data;
        this.connection = connection;
    }

    public get peerPublicNodeId(): string {
        return this.data.peerPublicNodeId;
    }

    public get PeerIp(): string {
        return this.data.ip;
    }

    public send(payload: object): void {
        if (this.connection.isOpen) {
            this.connection.send(JSON.stringify(payload));
        }
    }

    public touch(): void {
        this.lastSeen = Date.now();
    }
}
