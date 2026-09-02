import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs   from 'fs';
import path from 'path';
import os   from 'os';
import { Logger, LogLevel } from '../utils/logger.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTmpLogger(level: LogLevel = LogLevel.DEBUG): { logger: Logger; logPath: string } {
    const dir     = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-hive-test-'));
    const logger  = new Logger('test-node', level, dir, 'test.log');
    const logPath = path.join(dir, 'test.log');
    return { logger, logPath };
}

function readLog(logPath: string): string {
    return fs.readFileSync(logPath, 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────────

describe('Logger', () => {

    it('creates the log file on construction', () => {
        const { logPath, logger } = makeTmpLogger();
        expect(fs.existsSync(logPath)).toBe(true);
        logger.close();
    });

    it('writes an INFO line to the file on close/flush', () => {
        const { logger, logPath } = makeTmpLogger();
        logger.info('hello world');
        logger.close();
        expect(readLog(logPath)).toContain('hello world');
    });

    it('writes a WARN line with correct label', () => {
        const { logger, logPath } = makeTmpLogger();
        logger.warn('something wrong');
        logger.close();
        expect(readLog(logPath)).toContain('WARN');
        expect(readLog(logPath)).toContain('something wrong');
    });

    it('writes an ERROR line with correct label', () => {
        const { logger, logPath } = makeTmpLogger();
        logger.error('fatal thing');
        logger.close();
        expect(readLog(logPath)).toContain('ERROR');
        expect(readLog(logPath)).toContain('fatal thing');
    });

    it('serialises meta objects into the file line', () => {
        const { logger, logPath } = makeTmpLogger();
        logger.info('with meta', { port: 3000, peer: 'abc' });
        logger.close();
        const content = readLog(logPath);
        expect(content).toContain('3000');
        expect(content).toContain('abc');
    });

    it('respects log level — does not write DEBUG lines at INFO level', () => {
        const { logger, logPath } = makeTmpLogger(LogLevel.INFO);
        logger.debug('should be suppressed');
        logger.close();
        expect(readLog(logPath)).not.toContain('should be suppressed');
    });

    it('respects log level — writes DEBUG lines at DEBUG level', () => {
        const { logger, logPath } = makeTmpLogger(LogLevel.DEBUG);
        logger.debug('debug visible');
        logger.close();
        expect(readLog(logPath)).toContain('debug visible');
    });

    it('withNodeId returns a new logger that uses the new id', () => {
        const { logger, logPath } = makeTmpLogger();
        const next = logger.withNodeId('newid123');
        next.info('from new id');
        next.close();
        expect(readLog(logPath)).toContain('newid123');
    });

    it('stamps every line with the nodeId', () => {
        const dir    = fs.mkdtempSync(path.join(os.tmpdir(), 'chess-hive-test-'));
        const log    = new Logger('myspecialnode', LogLevel.DEBUG, dir, 'stamp.log');
        const lpath  = path.join(dir, 'stamp.log');
        log.info('stamped');
        log.close();
        expect(readLog(lpath)).toContain('myspecialn'); // truncated to 12 chars
    });

    it('close() is idempotent — calling twice does not throw', () => {
        const { logger } = makeTmpLogger();
        expect(() => { logger.close(); logger.close(); }).not.toThrow();
    });
});
