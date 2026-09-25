import { Peer, PeerStatus }        from "../peer.js";
import { signMessage, verifySignature } from "../../protocol/verifysignsignature.js";
import { randomUUID }              from "crypto";
import { NETWORK_CONFIG }          from "../../utils/config.js";
import { logger }                  from "../../utils/logger.js";
import type { Team, GameResult }   from "../../game/game-state.js";
import type { GameConfig, SignedVote } from "../../game/voting-state.js";
import type { TallyClaim }         from "../../game/verify-tally.js";
import WebSocket                   from "ws";
// Node is intentionally NOT imported here.
// The time-offset callback is injected at call time to avoid a circular
// dependency: Node → LocalNetworkController → MessageService → Node.

// ---------------------------------------------------------------------------
// Nonce replay protection
// ---------------------------------------------------------------------------
// Key: `${senderPublicKey}:${nonce}` — scoped per sender so different peers
// can legitimately reuse the same UUID without colliding.
const seenNonces = new Map<string, NodeJS.Timeout>();

function isReplay(senderPublicKey: string, nonce: string | undefined): boolean {
    if (!nonce) return false;
    return seenNonces.has(`${senderPublicKey}:${nonce}`);
}

function recordNonce(senderPublicKey: string, nonce: string | undefined): void {
    if (!nonce) return;
    const key    = `${senderPublicKey}:${nonce}`;
    const handle = setTimeout(() => seenNonces.delete(key), NETWORK_CONFIG.NONCE_TTL_MS);
    handle.unref();
    seenNonces.set(key, handle);
}

// ---------------------------------------------------------------------------
// Typed inbound message (replaces message: any)
// ---------------------------------------------------------------------------
interface InboundMessage {
    type:          string;
    key?:          string;
    // existing fields
    team?:         string;
    request_id?:   string;
    client_time?:  number;
    server_time?:  number;
    timestamp?:    number;
    nonce?:        string;
    // game fields
    gameId?:       string;
    resolvedTeam?: Team;
    startsAt?:     number;
    totalPlayers?: number;
    moveIndex?:    number;
    move?:         string;
    fenBefore?:    string;
    fenAfter?:     string;
    result?:       GameResult;
    lastFen?:      string;
    moveCount?:    number;
    [key: string]: unknown;
}

// Callbacks injected by Node so MessageService never imports Node directly
export interface MessageCallbacks {
    setTimeOffset:    (offset: number) => void;
    onGameStart:      (payload: InboundMessage, senderKey: string) => void;
    onMove:           (payload: InboundMessage, senderKey: string) => void;
    onGameOver:       (payload: InboundMessage, senderKey: string) => void;
    onSideChoice:     (senderKey: string, team: Team) => void;
    onReady:          (senderKey: string) => void;
    onUnready:        (senderKey: string) => void;
    onConfigProposal: (senderKey: string, config: GameConfig, version: number) => void;
    onConfigAccept:   (senderKey: string, version: number) => void;
    onVote:           (senderKey: string, turnIndex: number, round: number, move: string, timestamp: number, signed: SignedVote) => void;
    onTallyResult:    (senderKey: string, claim: TallyClaim) => void;
    onDrawOffer:      (senderKey: string) => void;
    onDrawResponse:   (senderKey: string, accepted: boolean) => void;
    onResignVote:     (senderKey: string) => void;
}

type OutboundMessage =
  | { type: 'ready';           team: string }
  | { type: 'unready' }
  | { type: 'side_choice';     team: Team; request_id: string; client_time: number }
  | { type: 'config_proposal'; config: GameConfig; version: number }
  | { type: 'config_accept';   version: number }
  | { type: 'vote';            turnIndex: number; round: number; move: string; timestamp: number }
  | ({ type: 'tally_result' } & TallyClaim)
  | { type: 'draw_offer' }
  | { type: 'draw_response';   accepted: boolean }
  | { type: 'resign_vote' }
  | { type: 'ping' };

/** A packet as it went out: the payload and its signature. */
export interface SignedPacket {
    payload:   Record<string, unknown>;
    signature: string;
}

// ---------------------------------------------------------------------------
// MessageService
// ---------------------------------------------------------------------------
export class MessageService {

    /**
     * Builds a signed packet for `msg` and sends it to every alive peer.
     *
     * The helper owns only the envelope fields (`key`, `timestamp`, `nonce`);
     * everything else comes from `msg`, so it never branches on message type.
     * `filter` narrows an already-live set — it can never widen it.
     *
     * Returns what was signed, so a vote can later be forwarded as-is.
     */
    public static broadcast(
        msg:     OutboundMessage,
        peers:   Map<string, Peer>,
        keys:    { publicKey: string; privateKey: string },
        filter?: (peer: Peer) => boolean,
    ): SignedPacket {
        const payload = {
            key:       keys.publicKey,
            ...msg,
            // `vote` carries the sender's synchronized clock; everything else
            // stamps wall time here.
            timestamp: 'timestamp' in msg ? msg.timestamp : Date.now(),
            nonce:     randomUUID(),
        };
        const signature = signMessage(JSON.stringify(payload), keys.privateKey);
        const packet    = JSON.stringify({ payload, signature });

        for (const [peerId, peer] of peers) {
            if (peer.status !== PeerStatus.Alive) continue;
            if (filter && !filter(peer))          continue;
            try {
                peer.socket.send(packet);
            } catch (err) {
                logger.error(`Failed to send ${msg.type}`, {
                    peer:    peerId.slice(0, 8),
                    message: err instanceof Error ? err.message : String(err),
                });
            }
        }

        return { payload, signature };
    }

    public static SendTimeSyncRequest(
        targetPeer:   Peer,
        myPublicKey:  string,
        myPrivateKey: string,
    ): string {
        const requestId = randomUUID();
        const payload   = {
            key:         myPublicKey,
            type:        "time_sync_request",
            request_id:  requestId,
            client_time: Date.now(),
            timestamp:   Date.now(),
            nonce:       randomUUID(),
        };
        const message   = JSON.stringify(payload);
        const signature = signMessage(message, myPrivateKey);

        if (targetPeer.socket.readyState === WebSocket.OPEN) {
            targetPeer.socket.send(JSON.stringify({ payload, signature }));
            return requestId;
        }

        logger.error(`Cannot send time-sync — socket not ready`, {
            peer: targetPeer.peerPublicNodeId.slice(0, 8),
        });
        return "";
    }

    public static SendTimeSyncResponse(
        targetPeer:   Peer,
        requestId:    string,
        clientTime:   number,
        myPublicKey:  string,
        myPrivateKey: string,
    ): void {
        const payload = {
            key:         myPublicKey,
            type:        "time_sync_response",
            request_id:  requestId,
            client_time: clientTime,
            server_time: Date.now(),
            timestamp:   Date.now(),
            nonce:       randomUUID(),
        };
        const message   = JSON.stringify(payload);
        const signature = signMessage(message, myPrivateKey);

        if (targetPeer.socket.readyState === WebSocket.OPEN) {
            targetPeer.socket.send(JSON.stringify({ payload, signature }));
        } else {
            logger.error(`Cannot send time-sync response — socket not ready`, {
                peer: targetPeer.peerPublicNodeId.slice(0, 8),
            });
        }
    }

    public static HandleMessage(
        message:        InboundMessage,
        signature:      string,
        senderPublicKey: string,
        peers:          Map<string, Peer>,
        myPublicKey:    string,
        myPrivateKey:   string,
        callbacks:      MessageCallbacks,
    ): string | null {
        try {
            // 1. Verify signature
            
            if (!verifySignature(JSON.stringify(message), signature, senderPublicKey)) {
                logger.warn(`Invalid message signature`, { sender: senderPublicKey.slice(0, 8) });
                return null;
            }

            // 2. Replay check — only after signature is verified so the nonce
            //    store cannot be poisoned with unsigned garbage.
            if (isReplay(senderPublicKey, message.nonce)) {
                logger.warn(`Replay attempt detected`, {
                    sender: senderPublicKey.slice(0, 8),
                    type:   message.type,
                });
                return null;
            }
            recordNonce(senderPublicKey, message.nonce);

            // 3. Locate sender
            const peer = peers.get(senderPublicKey);
            if (!peer) {
                logger.warn(`Message from unknown peer`, { sender: senderPublicKey.slice(0, 8) });
                return null;
            }

            // 4. Update ghost-detection heartbeat
            peer.touch();

            // 5. Dispatch — network messages

            // A ping carries nothing. Its only job is the touch() above, which
            // keeps an idle peer from being swept as a ghost.
            if (message.type === "ping") {
                return "ping";
            }

            if (message.type === "ready") {
                peer.ready = true;
                peer.team  = message.team ?? null;
                logger.info(`Peer ready`, { peer: senderPublicKey.slice(0, 8), team: peer.team });
                callbacks.onReady(senderPublicKey);
                return "ready";
            }

            if (message.type === "unready") {
                peer.ready = false;
                logger.info(`Peer unreadied`, { peer: senderPublicKey.slice(0, 8) });
                callbacks.onUnready(senderPublicKey);
                return "unready";
            }

            if (message.type === "side_choice") {
                peer.team = message.team ?? null;
                logger.info(`Peer has picked a team`, { peer: senderPublicKey.slice(0, 8), team: peer.team });
                if (peer.team) callbacks.onSideChoice(senderPublicKey, peer.team as Team);
                return "side_choice";
            }
            
            if (message.type === "time_sync_request") {
                MessageService.SendTimeSyncResponse(
                    peer,
                    message.request_id ?? "",
                    message.client_time ?? Date.now(),
                    myPublicKey,
                    myPrivateKey,
                );
                return "time_sync_request";
            }

            if (message.type === "time_sync_response") {
                // The reply took time to travel, so the master's clock reading
                // isn't "now". Assume it was taken halfway through the round
                // trip, the same assumption NTP makes. Treating the whole trip
                // as clock difference was harmless on a LAN (~1 ms) but puts
                // every vote window 50-200 ms off over the internet.
                const sentAt     = message.client_time;
                const serverTime = message.server_time;
                const receivedAt = Date.now();
                if (typeof sentAt !== 'number' || typeof serverTime !== 'number' || sentAt > receivedAt) {
                    logger.warn(`Unusable time-sync response`, { sender: senderPublicKey.slice(0, 8) });
                    return null;
                }
                const roundTrip = receivedAt - sentAt;
                const offset    = Math.round(serverTime - (sentAt + roundTrip / 2));
                callbacks.setTimeOffset(offset);
                logger.info(`Time-sync offset received`, { offsetMs: offset, roundTripMs: roundTrip });
                return "time_sync_response";
            }

            // 6. Dispatch — config / voting messages
            if (message.type === "config_proposal") {
                const config  = message.config as GameConfig | undefined;
                const version = message.version as number | undefined;
                if (config && version !== undefined) {
                    callbacks.onConfigProposal(senderPublicKey, config, version);
                }
                return "config_proposal";
            }

            if (message.type === "config_accept") {
                const version = message.version as number | undefined;
                if (version !== undefined) {
                    callbacks.onConfigAccept(senderPublicKey, version);
                }
                return "config_accept";
            }

            if (message.type === "vote") {
                const turnIndex = message.turnIndex as number | undefined;
                const round     = message.round     as number | undefined;
                const move      = message.move      as string | undefined;

                // The master forwards votes, and everyone checks them against
                // the key written inside. A vote signed by one peer but claiming
                // another's key would pass here yet fail for everyone after
                // forwarding, stopping the game. Drop it now.
                if (message.key !== senderPublicKey) {
                    logger.warn(`Vote claims someone else's key`, { sender: senderPublicKey.slice(0, 8) });
                    return null;
                }

                if (turnIndex !== undefined && round !== undefined && move) {
                    callbacks.onVote(
                        senderPublicKey, turnIndex, round, move, message.timestamp ?? Date.now(),
                        { payload: message, signature } as unknown as SignedVote,
                    );
                }
                return "vote";
            }

            if (message.type === "tally_result") {
                callbacks.onTallyResult(senderPublicKey, message as unknown as TallyClaim);
                return "tally_result";
            }

            if (message.type === "resign_vote") {
                callbacks.onResignVote(senderPublicKey);
                return "resign_vote";
            }

            if (message.type === "draw_offer") {
                callbacks.onDrawOffer(senderPublicKey);
                return "draw_offer";
            }

            if (message.type === "draw_response") {
                const accepted = message.accepted as boolean | undefined;
                if (accepted !== undefined) {
                    callbacks.onDrawResponse(senderPublicKey, accepted);
                }
                return "draw_response";
            }

            // 7. Dispatch — game messages (delegated to Node via callbacks)
            if (message.type === "game_start") {
                logger.info(`Received game_start`, {
                    from:    senderPublicKey.slice(0, 8),
                    gameId:  message.gameId?.slice(0, 8),
                    team:    message.resolvedTeam,
                    startsAt: message.startsAt,
                });
                callbacks.onGameStart(message, senderPublicKey);
                return "game_start";
            }

            if (message.type === "move") {
                logger.info(`Received move`, {
                    from:  senderPublicKey.slice(0, 8),
                    index: message.moveIndex,
                    move:  message.move,
                });
                callbacks.onMove(message, senderPublicKey);
                return "move";
            }

            if (message.type === "game_over") {
                logger.info(`Received game_over`, {
                    from:   senderPublicKey.slice(0, 8),
                    gameId: message.gameId?.slice(0, 8),
                    result: message.result,
                });
                callbacks.onGameOver(message, senderPublicKey);
                return "game_over";
            }

            logger.warn(`Unhandled message type`, {
                type:   message.type,
                sender: senderPublicKey.slice(0, 8),
            });
            return null;

        } catch (err: unknown) {
            logger.error(`Error handling message`, {
                message: err instanceof Error ? err.message : String(err),
            });
            return null;
        }
    }
}
