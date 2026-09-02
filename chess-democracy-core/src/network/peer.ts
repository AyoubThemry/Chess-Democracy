import { WebSocket } from 'ws';

export interface PeerData {
    peerPublicNodeId: string;
    ip: string;
    port: number;
    
}
// Better if the value matches the intent
export enum PeerStatus {
  Alive = 'alive',
  Dead = 'dead'
}
export class Peer {
    // We keep the raw data private but expose what we need
    private data: PeerData;
    public readonly socket: WebSocket;
    public lastSeen: number = Date.now(); // for ghost detection
    public status : PeerStatus = PeerStatus.Alive;
    public ready: boolean = false; // ready state for game coordination
    public team: string | null = null; // team assignment (white/black/null)


    constructor(data: PeerData, socket: WebSocket) {
        this.data = data;
        this.socket = socket;
        
    }

    // ✅ This allows node.ts to access peer.peerPublicNodeId
    public get peerPublicNodeId(): string {
        return this.data.peerPublicNodeId;
    }
    public get PeerIp():string{
        return this.data.ip;
    }

    // Optional: Helper to send data easily
    public send(payload: object): void {
        if (this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify(payload));
        }
    }
     public touch(): void {
        this.lastSeen = Date.now();
    }
}