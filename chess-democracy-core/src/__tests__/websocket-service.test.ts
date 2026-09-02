import { describe, it, expect } from 'vitest';
import { WebsocketService } from '../network/websocket-service.js';

describe('WebsocketService', () => {
    it('emits "ready" with the actual port after boot on port 0', async () => {
        const svc = new WebsocketService();
        const port = await new Promise<number>((resolve) => {
            svc.on('ready', resolve);
            svc.boot(0);
        });
        expect(port).toBeGreaterThan(0);
        svc.stop();
    });

    it('getPort() returns the assigned port after boot', async () => {
        const svc = new WebsocketService();
        await new Promise<void>((resolve) => {
            svc.on('ready', () => resolve());
            svc.boot(0);
        });
        expect(svc.getPort()).toBeGreaterThan(0);
        svc.stop();
    });

    it('emits "connection" when a client connects', async () => {
        const { WebSocket } = await import('ws');
        const svc  = new WebsocketService();
        const port = await new Promise<number>((resolve) => {
            svc.on('ready', resolve);
            svc.boot(0);
        });

        const connected = new Promise<void>((resolve) => {
            svc.on('connection', () => resolve());
        });

        const client = new WebSocket(`ws://127.0.0.1:${port}`);
        client.on('error', () => {}); // suppress unhandled rejection when server stops
        await connected;
        client.terminate();
        svc.stop();
    });

    it('stop() does not throw', async () => {
        const svc = new WebsocketService();
        await new Promise<void>((resolve) => { svc.on('ready', () => resolve()); svc.boot(0); });
        expect(() => svc.stop()).not.toThrow();
    });
});
