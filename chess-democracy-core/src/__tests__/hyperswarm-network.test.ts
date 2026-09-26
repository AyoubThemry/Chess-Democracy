import { describe, it, expect, vi, afterEach } from 'vitest';
import { duplexPair, type Duplex } from 'stream';
import { randomUUID } from 'crypto';
import { HyperswarmNetwork, roomTopic } from '../network/globalnetwork/hyperswarm-network.js';
import { HyperswarmConnection } from '../network/globalnetwork/hyperswarm-connection.js';
import { MessageService, type MessageCallbacks } from '../network/message-service.js';
import type { Peer } from '../network/peer.js';
import { getOrCreateIdentity } from '../protocol/generateidentity.js';
import { signMessage } from '../protocol/verifysignsignature.js';

// hyperswarm hands us an encrypted duplex stream per peer. An in-memory
// duplex pair stands in for it here, so these tests exercise our framing and
// handshake without touching a real network.

async function until(check: () => boolean, ms = 2000): Promise<void> {
    const start = Date.now();
    while (!check()) {
        if (Date.now() - start > ms) throw new Error('condition never became true');
        await new Promise(r => setTimeout(r, 5));
    }
}

function callbacks(): MessageCallbacks {
    const names = ['setTimeOffset', 'onGameStart', 'onMove', 'onGameOver', 'onSideChoice', 'onReady', 'onUnready',
        'onConfigProposal', 'onConfigAccept', 'onVote', 'onTallyResult', 'onGameSnapshot', 'onDrawOffer',
        'onDrawResponse', 'onResignVote'];
    return Object.fromEntries(names.map(n => [n, vi.fn()])) as unknown as MessageCallbacks;
}

/** A network plus the bookkeeping Node would do on its events. */
function makeNode(room = 'test-room') {
    const identity = getOrCreateIdentity();
    const peers    = new Map<string, Peer>();
    const cb       = callbacks();
    const net      = new HyperswarmNetwork({
        identity, callbacks: cb, getAllPeers: () => peers,
        getAlivePeersCount: () => peers.size, adjustAlivePeersCount: () => {}, acceptingConnection: () => true,
        summary: () => ({ open: true, players: peers.size + 1, whites: 0, blacks: 0 }),
    }, { room });
    const connected: Peer[] = [], disconnected: Peer[] = [];
    net.on('peer:connected',    (p: Peer) => { connected.push(p); peers.set(p.peerPublicNodeId, p); });
    net.on('peer:disconnected', (p: Peer) => { disconnected.push(p); if (peers.get(p.peerPublicNodeId) === p) peers.delete(p.peerPublicNodeId); });
    return { identity, peers, cb, net, connected, disconnected };
}

const key = (n: ReturnType<typeof makeNode>) => Buffer.from(n.net.swarmKey, 'hex');

function link(a: ReturnType<typeof makeNode>, b: ReturnType<typeof makeNode>, { aThinksBIs = key(b) } = {}) {
    const [sa, sb] = duplexPair();
    a.net.handleConnection(sa, aThinksBIs);
    b.net.handleConnection(sb, key(a));
    return { sa, sb };
}

describe('HyperswarmConnection framing', () => {
    function pair() {
        const [ours, theirs] = duplexPair();
        return { conn: new HyperswarmConnection(ours), theirs };
    }

    it('reassembles a packet split across chunks, and splits several in one chunk', async () => {
        const { conn, theirs } = pair();
        const got: string[] = [];
        conn.onMessage(p => got.push(p));
        theirs.write('{"a":');
        theirs.write('1}\n{"b":2}\n{"c"');
        theirs.write(':3}\n');
        await until(() => got.length === 3);
        expect(got).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    });

    it('holds packets that arrive before a handler is attached', async () => {
        const { conn, theirs } = pair();
        theirs.write('{"early":true}\n');
        await new Promise(r => setTimeout(r, 20));
        const got: string[] = [];
        conn.onMessage(p => got.push(p));
        expect(got).toEqual(['{"early":true}']);
    });

    it('drops a peer that streams a huge packet with no end', async () => {
        const { conn, theirs } = pair();
        conn.onMessage(() => {});
        theirs.write('x'.repeat(1_100_000));
        await until(() => !conn.isOpen);
    });
});

describe('HyperswarmNetwork handshake', () => {
    const nodes: ReturnType<typeof makeNode>[] = [];
    const node = (room?: string) => { const n = makeNode(room); nodes.push(n); return n; };
    afterEach(() => { nodes.splice(0).forEach(n => n.net.stop()); });

    it('turns a verified hello into a peer known by its Ed25519 key', async () => {
        const a = node(), b = node();
        link(a, b);
        await until(() => a.connected.length === 1 && b.connected.length === 1);
        expect(a.connected[0].peerPublicNodeId).toBe(b.identity.publicKey);
        expect(b.connected[0].peerPublicNodeId).toBe(a.identity.publicKey);
    });

    it('delivers signed game messages once connected', async () => {
        const a = node(), b = node();
        link(a, b);
        await until(() => a.peers.size === 1 && b.peers.size === 1);
        MessageService.broadcast({ type: 'ready', team: 'white' }, a.peers, a.identity);
        await until(() => (b.cb.onReady as ReturnType<typeof vi.fn>).mock.calls.length === 1);
        expect(b.cb.onReady).toHaveBeenCalledWith(a.identity.publicKey);
    });

    it('rejects a hello addressed to a different hyperswarm key', async () => {
        const a = node(), b = node(), stranger = node();
        // a's hello names the stranger, but it goes to b: a relayed hello looks like this
        link(a, b, { aThinksBIs: key(stranger) });
        await new Promise(r => setTimeout(r, 100));
        expect(b.connected).toHaveLength(0);
    });

    it('rejects a hello with a forged signature', async () => {
        const b = node();
        const [attacker, sb] = duplexPair();
        b.net.handleConnection(sb, Buffer.alloc(32));
        const victim  = getOrCreateIdentity();
        const payload = { key: victim.publicKey, type: 'hello', to: b.net.swarmKey, timestamp: Date.now(), nonce: randomUUID() };
        const wrongKey = getOrCreateIdentity().privateKey;          // not the victim's
        attacker.write(JSON.stringify({ payload, signature: signMessage(JSON.stringify(payload), wrongKey) }) + '\n');
        await new Promise(r => setTimeout(r, 100));
        expect(b.connected).toHaveLength(0);
        expect(sb.destroyed).toBe(true);
    });

    it('closes a connection whose first packet is not valid JSON', async () => {
        const b = node();
        const [attacker, sb] = duplexPair();
        b.net.handleConnection(sb, Buffer.alloc(32));
        attacker.write('not json\n');
        await until(() => (sb as Duplex).destroyed);
        expect(b.connected).toHaveLength(0);
    });

    it('a new connection from the same peer retires the old one', async () => {
        const a = node(), b = node();
        link(a, b);
        await until(() => b.connected.length === 1);
        const first = b.connected[0];
        link(a, b);                                                   // reconnect
        await until(() => b.connected.length === 2);
        expect(b.disconnected).toContain(first);
        expect(b.peers.get(a.identity.publicKey)).toBe(b.connected[1]);
    });

    it('reports a closed connection as a disconnect', async () => {
        const a = node(), b = node();
        const { sa } = link(a, b);
        await until(() => b.connected.length === 1);
        sa.end();                                                     // a hangs up
        await until(() => b.disconnected.length === 1);
    });
});

describe('roomTopic', () => {
    it('gives the same topic for the same code however it is typed', () => {
        expect(roomTopic(' ABcd-2345 ').equals(roomTopic('abcd-2345'))).toBe(true);
        expect(roomTopic('abcd-2345').equals(roomTopic('abcd-2346'))).toBe(false);
        expect(roomTopic('x')).toHaveLength(32);
    });
});
