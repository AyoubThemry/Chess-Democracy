import { WebSocket }               from "ws";
import { Peer, PeerData }          from "../peer.js";
import { WebSocketConnection }     from "../peer-connection.js";
import { signMessage, verifySignature } from "../../protocol/verifysignsignature.js";
import { randomUUID }              from "crypto";
import { toError }                 from "../../utils/errors.js";
import { logger }                  from "../../utils/logger.js";

/**
 * A peer address as it has to appear in a ws:// URL.
 *
 * A peer that connected to us is known by what its socket reported, and
 * Node reports IPv4 as '::ffff:192.168.1.5'. Pasted into a URL that's
 * invalid, so reconnecting to such a peer always failed. Real IPv6 needs
 * brackets.
 */
export function hostForUrl(ip: string): string {
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
    if (mapped) return mapped[1];
    return ip.includes(':') ? `[${ip}]` : ip;
}

export class ConnectorService {
    public async connect(
        peerData:   PeerData,
        myPubKey:   string,
        myPrivKey:  string,
        port:       number,
    ): Promise<Peer> {
        return new Promise((resolve, reject) => {
            const socket = new WebSocket(`ws://${hostForUrl(peerData.ip)}:${peerData.port}`);
            let handshakeTimeout: NodeJS.Timeout;

            const cleanup = (action: () => void) => {
                clearTimeout(handshakeTimeout);
                action();
            };

            socket.on("open", () => {
                const payload   = { key: myPubKey, type: "handshake", timestamp: Date.now(), port };
                const message   = JSON.stringify(payload);
                const signature = signMessage(message, myPrivKey);
                socket.send(JSON.stringify({ payload, signature }));
            });

            socket.once("message", (data: Buffer) => {
                try {
                    const info    = JSON.parse(data.toString("utf8"));
                    const msgStr  = JSON.stringify(info.payload);
                    const isAck   = info.payload?.type === "connectionack";
                    const isValid = verifySignature(msgStr, info.signature, peerData.peerPublicNodeId);

                    if (isAck && isValid) {
                        cleanup(() => resolve(new Peer(peerData, new WebSocketConnection(socket))));
                    } else {
                        cleanup(() => { socket.close(); reject(new Error("Invalid handshake ACK")); });
                    }
                } catch (err: unknown) {
                    cleanup(() => { socket.close(); reject(toError(err)); });
                }
            });

            socket.on("error", (err: Error) => {
                cleanup(() => reject(err));
            });

            handshakeTimeout = setTimeout(() => {
                logger.error(`Handshake timeout`, { peer: peerData.peerPublicNodeId.slice(0, 8) });
                socket.close();
                reject(new Error("Handshake timeout"));
            }, 5000);
        });
    }

    public async sendConnectionAck(
        socket:        WebSocket,
        myPrivateKey:  string,
        port:          number,
        myPublicKey:   string,
        peerPublicKey: string,
    ): Promise<boolean> {
        try {
            const payload = {
                key:           myPublicKey,
                type:          "connectionack",
                yourpublickey: peerPublicKey,
                timestamp:     Date.now(),
                nonce:         randomUUID(),
                port,
            };
            const message   = JSON.stringify(payload);
            const signature = signMessage(message, myPrivateKey);
            const packet    = JSON.stringify({ payload, signature });

            return await new Promise<boolean>((resolve) => {
                socket.send(packet, (err?: Error) => {
                    if (err) {
                        logger.error(`ACK send failed`, { message: err.message });
                        resolve(false);
                    } else {
                        resolve(true);
                    }
                });
            });
        } catch (err: unknown) {
            logger.error(`ACK serialisation error`, { message: toError(err).message });
            return false;
        }
    }
}
