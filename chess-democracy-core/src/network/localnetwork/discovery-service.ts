import { Bonjour, Browser, Service } from 'bonjour-service';
import { EventEmitter }              from 'events';
import { PeerData }                  from '../peer.js';
import { logger }                    from '../../utils/logger.js';

export class DiscoveryService extends EventEmitter {
    private instance = new Bonjour();
    private browser?: Browser;

    public start(serviceName: string): void {
        this.browser = this.instance.find({ type: serviceName, protocol: 'tcp' });

        this.browser.on('up', (service: Service) => {
            logger.info(`mDNS peer discovered`, { name: service.name.slice(-8) });

            const peerData: PeerData = {
                peerPublicNodeId: (service.txt?.id as string) || service.name,
                ip:   service.referer?.address ?? service.addresses?.[0] ?? '0.0.0.0',
                port: service.port,
            };

            this.emit('discovered', peerData);
        });
    }

    public stop(): void {
        this.browser?.stop();
        this.instance.destroy();
    }
}
