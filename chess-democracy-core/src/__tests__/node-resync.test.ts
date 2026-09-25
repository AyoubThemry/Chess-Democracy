import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'crypto';
import { Chess } from 'chess.js';
import { Node } from '../core/node.js';
import { VotingState, type SignedVote } from '../game/voting-state.js';
import type { GameSnapshot } from '../game/snapshot.js';
import type { GameNetwork } from '../network/game-network.js';
import type { MessageCallbacks } from '../network/localnetwork/message-service.js';
import { WebSocketConnection } from '../network/peer-connection.js';
import { PeerStatus } from '../network/peer.js';
import { getOrCreateIdentity } from '../protocol/generateidentity.js';
import { signMessage } from '../protocol/verifysignsignature.js';
import { bootNode, addPeer, makePeer } from './helpers/fake-network.js';

// Real keys, because snapshot votes are checked like any other forwarded vote.
const teammate = getOrCreateIdentity();   // white
const opponent = getOrCreateIdentity();   // black

type Internals = {
    recordRoster(): void;
    addPeer(peer: ReturnType<typeof makePeer>): void;
    handlePeerDisconnect(peer: ReturnType<typeof makePeer>): void;
    masterKey(): string;
    hasQuorum(): boolean;
    acceptsConnection(key?: string): boolean;
    onTallyDue(): void;
    _voting: VotingState;
    _resyncGraceUntil: number;
};

function signedVote(by: { publicKey: string; privateKey: string }, move: string, turnIndex = 0, round = 0): SignedVote {
    const payload = { key: by.publicKey, type: 'vote' as const, turnIndex, round, move, timestamp: Date.now(), nonce: randomUUID() };
    return { payload, signature: signMessage(JSON.stringify(payload), by.privateKey) };
}

const closed = (peer: ReturnType<typeof makePeer>) =>
    (peer.connection as WebSocketConnection).socket.close as unknown as ReturnType<typeof vi.fn>;

describe('Node resyncs a player who reconnects mid-game', () => {
    let node: Node;
    let cb: MessageCallbacks;
    let net: GameNetwork;
    let internals: Internals;

    const snapshot = (over: Partial<GameSnapshot> = {}): GameSnapshot => ({
        gameId: 'game-1', moves: [], round: 0, windowCloseAt: Date.now() + 30_000, votes: [], ...over,
    });

    beforeEach(async () => {
        ({ node, cb, net } = await bootNode());
        internals = node as unknown as Internals;

        node.setTeam('white');
        addPeer(node, teammate.publicKey, 'white');
        addPeer(node, opponent.publicKey, 'black');
        internals.recordRoster();                         // the game's players, fixed at countdown
        (node as unknown as { state: { acceptingConnection: boolean } }).state.acceptingConnection = false;

        node.gameState.beginCountdown('game-1', Date.now());
        node.gameState.begin();
        internals._voting = new VotingState(0, Date.now() + 30_000);
    });

    afterEach(() => node.stop());

    // ── who may connect ─────────────────────────────────────────────────

    it('lets a player from this game back in after the lobby closed', () => {
        expect(internals.acceptsConnection(teammate.publicKey)).toBe(true);
        expect(internals.acceptsConnection('someone-else')).toBe(false);
        expect(internals.acceptsConnection()).toBe(true);   // someone might be returning
    });

    it('closes a connection from an app that is not in this game', () => {
        const stranger = makePeer('0'.repeat(64), 'black');   // lowest possible key
        internals.addPeer(stranger);

        expect(closed(stranger)).toHaveBeenCalled();
        expect(node.allPeers.has(stranger.peerPublicNodeId)).toBe(false);
    });

    it('never lets a stranger become master, even with the lowest key', () => {
        node.allPeers.set('0'.repeat(64), makePeer('0'.repeat(64), 'black'));
        expect(internals.masterKey()).not.toBe('0'.repeat(64));
    });

    // ── reconnect ───────────────────────────────────────────────────────

    // A reconnect after the old connection died. (While the old one still
    // works, a second connection is just a duplicate and is ignored.)
    const dropped = (key: string) => {
        const old = node.allPeers.get(key)!;
        old.status = PeerStatus.Dead;
        return old;
    };

    it('keeps a working connection when a duplicate arrives', () => {
        const current = node.allPeers.get(teammate.publicKey)!;
        internals.addPeer(makePeer(teammate.publicKey, null));
        expect(node.allPeers.get(teammate.publicKey)).toBe(current);
        expect(closed(current)).not.toHaveBeenCalled();
    });

    it('replaces a dead connection and restores the team', () => {
        const old   = dropped(teammate.publicKey);
        const fresh = makePeer(teammate.publicKey, null);     // new connections start blank
        internals.addPeer(fresh);

        expect(closed(old)).toHaveBeenCalled();
        expect(node.allPeers.get(teammate.publicKey)).toBe(fresh);
        expect(fresh.team).toBe('white');
    });

    it('ignores the old connection closing after it was replaced', () => {
        const old   = dropped(teammate.publicKey);
        const fresh = makePeer(teammate.publicKey, null);
        internals.addPeer(fresh);
        internals.handlePeerDisconnect(old);

        expect(node.allPeers.get(teammate.publicKey)).toBe(fresh);
    });

    it('sends the returning player a snapshot and holds off counting', () => {
        internals._voting.castVote(teammate.publicKey, 'e2e4', Date.now(), signedVote(teammate, 'e2e4'));
        dropped(opponent.publicKey);
        internals.addPeer(makePeer(opponent.publicKey, null));

        const send = net.sendGameSnapshotToPeer as unknown as ReturnType<typeof vi.fn>;
        expect(send).toHaveBeenCalledOnce();
        const snap = send.mock.calls[0][0] as GameSnapshot;
        expect(snap.gameId).toBe('game-1');
        expect(snap.votes.map(v => v.payload.move)).toEqual(['e2e4']);
        expect(internals._resyncGraceUntil).toBeGreaterThan(Date.now());
    });

    // ── catching up ─────────────────────────────────────────────────────

    it('replays the moves it missed and joins the open window', () => {
        const done = vi.fn();
        node.on('tally:done', done);

        cb.onGameSnapshot(teammate.publicKey, snapshot({ moves: ['e2e4', 'e7e5'] }));

        const expected = new Chess(); expected.move('e2e4'); expected.move('e7e5');
        expect(node.gameState.moveHistory.map(m => m.move)).toEqual(['e2e4', 'e7e5']);
        expect(node.gameState.fen).toBe(expected.fen());
        expect(done).toHaveBeenCalledTimes(2);                 // the board updates for each
        expect(node.activeVoting!.turnIndex).toBe(2);
    });

    it('picks up checked votes from the open window, and skips forged ones', () => {
        const forged = signedVote(teammate, 'e2e4');
        forged.payload.move = 'd2d4';                            // edited after signing

        cb.onGameSnapshot(opponent.publicKey, snapshot({ votes: [signedVote(teammate, 'e2e4'), forged] }));

        expect([...node.activeVoting!.votes.entries()]).toEqual([[teammate.publicKey, 'e2e4']]);
    });

    it('ignores a snapshot that is behind ours', () => {
        cb.onGameSnapshot(teammate.publicKey, snapshot({ moves: ['e2e4'] }));
        cb.onGameSnapshot(opponent.publicKey, snapshot({ moves: [] }));

        expect(node.gameState.moveHistory).toHaveLength(1);
        expect(node.gameState.phase).toBe('in_progress');
    });

    it('stops the game when histories differ rather than lag', () => {
        cb.onGameSnapshot(teammate.publicKey, snapshot({ moves: ['e2e4'] }));
        cb.onGameSnapshot(opponent.publicKey, snapshot({ moves: ['d2d4', 'd7d5'] }));

        expect(node.gameState.phase).toBe('finished');
        expect(node.gameState.result?.reason).toBe('desync');
    });

    it('ignores snapshots from outside the game, or for another game', () => {
        cb.onGameSnapshot('someone-else',     snapshot({ moves: ['e2e4'] }));
        cb.onGameSnapshot(teammate.publicKey, snapshot({ moves: ['e2e4'], gameId: 'other-game' }));

        expect(node.gameState.moveHistory).toHaveLength(0);
    });

    // ── quorum ──────────────────────────────────────────────────────────

    it('does not count while fewer than half the players are connected', () => {
        vi.spyOn(internals, 'masterKey').mockReturnValue(node.identity.publicKey);
        node.allPeers.clear();                                   // both others dropped: 1 of 3
        expect(internals.hasQuorum()).toBe(false);

        internals.onTallyDue();
        expect(net.broadcastTallyResult).not.toHaveBeenCalled();
    });

    it('counts again once enough players are back', () => {
        vi.spyOn(internals, 'masterKey').mockReturnValue(node.identity.publicKey);
        node.allPeers.delete(opponent.publicKey);                // 2 of 3 still connected
        expect(internals.hasQuorum()).toBe(true);

        internals.onTallyDue();
        expect(net.broadcastTallyResult).toHaveBeenCalledOnce();
    });
});

describe('Config handshake with three or more players', () => {
    it("keeps an accept that arrives before the proposal it accepts", async () => {
        const { node, cb } = await bootNode();
        node.setTeam('white');
        addPeer(node, teammate.publicKey, 'white');
        addPeer(node, opponent.publicKey, 'black');

        // The teammate's accept overtakes the opponent's proposal.
        cb.onConfigAccept(teammate.publicKey, 1);
        cb.onConfigProposal(opponent.publicKey, { voteWindowMs: 10_000, maxRevotes: 3, resignThreshold: 0.67, resignWindowMs: 60_000 }, 1);
        node.acceptConfig();

        expect(node.peerAcceptedVersions.get(teammate.publicKey)).toBe(1);
        expect(node.ready()).toBe('ok');
        node.stop();
    });
});
