import type { PeerConnection } from './peer-connection.js';
import type { Team } from '../game/game-state.js';

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
    public team:     Team | null = null;

    constructor(data: PeerData, connection: PeerConnection) {
        this.data       = data;
        this.connection = connection;
    }

    public get peerPublicNodeId(): string {
        return this.data.peerPublicNodeId;
    }

    /** Where to reach this peer again if the connection drops. */
    public get peerData(): PeerData {
        return this.data;
    }

    public touch(): void {
        this.lastSeen = Date.now();
    }
}
