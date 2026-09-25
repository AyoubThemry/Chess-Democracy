import { vi } from 'vitest';
import { EventEmitter } from 'events';
import type { WebSocket } from 'ws';
import { Node } from '../../core/node.js';
import { Peer } from '../../network/peer.js';
import { WebSocketConnection } from '../../network/peer-connection.js';
import type { GameNetwork } from '../../network/game-network.js';
import type { MessageCallbacks } from '../../network/localnetwork/message-service.js';

// Node builds its MessageCallbacks in boot() and hands them to its network
// factory. A fake factory captures them, so tests deliver messages exactly as
// a transport would, with no sockets and no module mocks.

export function fakeNetwork(): GameNetwork {
    return Object.assign(new EventEmitter(), {
        start: vi.fn(), stop: vi.fn(), sync: vi.fn(() => true),
        broadcastReady: vi.fn(), broadcastUnready: vi.fn(),
        broadcastSideChoice: vi.fn(), sendSideChoiceToPeer: vi.fn(),
        broadcastConfigProposal: vi.fn(), sendConfigProposalToPeer: vi.fn(),
        broadcastConfigAccept: vi.fn(), broadcastVote: vi.fn(),
        broadcastTallyResult: vi.fn(), sendGameSnapshotToPeer: vi.fn(),
        broadcastResignVoteToTeam: vi.fn(),
        broadcastDrawOffer: vi.fn(), broadcastDrawResponse: vi.fn(),
    }) as unknown as GameNetwork;
}

export async function bootNode(): Promise<{ node: Node; cb: MessageCallbacks; net: GameNetwork }> {
    let cb!: MessageCallbacks;
    const net = fakeNetwork();
    const node = new Node(undefined, async (ctx) => {
        cb = ctx.callbacks;
        return { network: net, boundPort: 9000 };
    });
    node.boot(0);
    await new Promise(r => setImmediate(r));   // let boot() attach the network
    return { node, cb, net };
}

export function fakeSocket(): WebSocket {
    return { readyState: 1, send: vi.fn(), close: vi.fn(), on: vi.fn() } as unknown as WebSocket;
}

export function makePeer(key: string, team: 'white' | 'black' | null = null): Peer {
    const peer = new Peer({ peerPublicNodeId: key, ip: '127.0.0.1', port: 9000 }, new WebSocketConnection(fakeSocket()));
    peer.team = team;
    return peer;
}

export function addPeer(node: Node, key: string, team: 'white' | 'black'): Peer {
    const peer = makePeer(key, team);
    node.allPeers.set(key, peer);
    return peer;
}
