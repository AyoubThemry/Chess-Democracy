import { Bonjour, Service } from 'bonjour-service';
import { logger }           from '../../utils/logger.js';

export class PublisherService {
    private bonjour       = new Bonjour();
    private activeService?: Service;

    constructor(publicKey: string, port: number, type: string) {
        const shortId = publicKey.slice(0, 12);

        // Include port in name so two instances on the same machine never collide.
        this.activeService = this.bonjour.publish({
            name:     `peer-${shortId}-${port}`,
            type,
            protocol: 'tcp',
            port,
            txt:      { id: publicKey },
        });

        this.activeService.on('up', () => {
            logger.info(`mDNS published`, {
                name:    `peer-${shortId}`,
                keyHint: publicKey.slice(0, 16),
            });
        });

        this.activeService.on('error', (err: Error) => {
            logger.error(`mDNS publish failed`, { message: err.message });
        });
    }

    public stop(): void {
        this.activeService?.stop?.();
        this.bonjour.destroy();
    }
}
