import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter }               from 'events';
import { NETWORK_CONFIG }             from '../utils/config.js';
import { logger }                     from '../utils/logger.js';

export class WebsocketService extends EventEmitter {
    private wss?:  WebSocketServer;
    private port:  number = 0;

    public boot(port: number): void {
        this.wss = new WebSocketServer({ port, backlog: NETWORK_CONFIG.NETWORK_BACKLOG });

        this.wss.on('listening', () => {
            const address = this.wss?.address();
            this.port = (typeof address === 'object' && address !== null) ? address.port : port;
            logger.info(`WebSocket server listening`, { port: this.port });
            this.emit('ready', this.port);
        });

        this.wss.on('connection', (ws: WebSocket, req) => {
            logger.debug(`Inbound connection`, {
                from: `${req?.socket?.remoteAddress}:${req?.socket?.remotePort}`,
            });
            this.emit('connection', ws, req);
        });

        this.wss.on('error', (error: Error) => {
            logger.error(`WebSocket server error`, { message: error.message });
        });
    }

    public stop(): void {
        this.wss?.close();
    }

    public getPort(): number {
        return this.port;
    }
}
