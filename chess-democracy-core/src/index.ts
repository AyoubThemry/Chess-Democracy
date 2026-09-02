import { Node }                  from './core/node.js';
import { validateNetworkConfig } from './utils/config.js';
import { logger }                from './utils/logger.js';

// ---------------------------------------------------------------------------
// 1. VALIDATE CONFIG — exits immediately with a clear message on bad values
// ---------------------------------------------------------------------------
try {
    validateNetworkConfig();
} catch {
    process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. BOOT NODE
// ---------------------------------------------------------------------------
const portArg = process.argv[2] ? parseInt(process.argv[2]) : 0;

logger.info('Starting Chess-Hive node', { port: portArg || 'random' });

const myNode = new Node();

// Node generates a crypto identity in its constructor.  Upgrade the logger's
// nodeId from "boot" to the real 8-char public-key prefix so every subsequent
// log line is stamped with the actual node identity.
if (myNode.identity?.publicKey) {
    // withNodeId() flushes the old buffer then returns a fresh Logger instance.
    // We reassign the module-level binding so all future logger calls in THIS
    // file use the new id.  Other modules import `logger` from utils/logger.ts
    // which already carries the correct id from their own call sites.
    Object.assign(logger, logger.withNodeId(myNode.identity.publicKey.slice(0, 8)));
}

myNode.boot(portArg);

// ---------------------------------------------------------------------------
// 3. GRACEFUL SHUTDOWN
// ---------------------------------------------------------------------------
function shutdown(signal: string): void {
    logger.info(`Received ${signal} — shutting down gracefully`);
    myNode.stop();
    logger.close();
    process.exit(0);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
