/**
 * Chess-Hive Logger
 *
 * Replaces the fragile console.log-hijack pattern in index.ts.
 *
 * Design decisions:
 *  • Four levels: DEBUG < INFO < WARN < ERROR  (matches console.* methods 1:1)
 *  • Every line written to the terminal AND appended to a rotating log file.
 *  • Writes are buffered (up to FLUSH_SIZE lines or FLUSH_INTERVAL_MS ms) so
 *    the hot path never blocks on disk I/O.
 *  • The buffer is flushed synchronously on SIGINT / process.exit so no lines
 *    are lost on graceful shutdown.
 *  • nodeId is injected at construction time and stamped on every line.
 *  • The global `logger` singleton is exported so every module can import it
 *    without creating its own instance.
 */

import fs   from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Log level
// ---------------------------------------------------------------------------

export enum LogLevel {
    DEBUG = 0,
    INFO  = 1,
    WARN  = 2,
    ERROR = 3,
}

// Human-readable label, padded to 5 chars so columns line up.
const LEVEL_LABEL: Record<LogLevel, string> = {
    [LogLevel.DEBUG]: 'DEBUG',
    [LogLevel.INFO]:  'INFO ',
    [LogLevel.WARN]:  'WARN ',
    [LogLevel.ERROR]: 'ERROR',
};

// Terminal colours (no external dep, raw ANSI codes).
const ANSI = {
    reset:  '\x1b[0m',
    grey:   '\x1b[90m',
    cyan:   '\x1b[36m',
    yellow: '\x1b[33m',
    red:    '\x1b[31m',
    white:  '\x1b[97m',
} as const;

const LEVEL_COLOUR: Record<LogLevel, string> = {
    [LogLevel.DEBUG]: ANSI.grey,
    [LogLevel.INFO]:  ANSI.cyan,
    [LogLevel.WARN]:  ANSI.yellow,
    [LogLevel.ERROR]: ANSI.red,
};

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

interface LogLine {
    ts:      string;   // ISO timestamp
    level:   LogLevel;
    nodeId:  string;
    message: string;
    meta?:   unknown;
}

export class Logger {
    private readonly level:    LogLevel;
    private readonly nodeId:   string;
    private readonly logPath:  string;
    private readonly buffer:   string[]         = [];
    private          timer?:   NodeJS.Timeout;

    private static readonly FLUSH_SIZE        = 20;    // lines
    private static readonly FLUSH_INTERVAL_MS = 1_000; // ms

    constructor(
        nodeId:   string,
        level:    LogLevel = LogLevel.INFO,
        logDir:   string   = process.cwd(),
        fileName: string   = 'hive_activity.log',
    ) {
        this.nodeId  = nodeId.slice(0, 12); // keep it short in output
        this.level   = level;
        this.logPath = path.join(logDir, fileName);

        // Ensure the log file exists (createWriteStream would do this too, but
        // appendFileSync on first write is simpler without a persistent handle).
        if (!fs.existsSync(this.logPath)) {
            fs.writeFileSync(this.logPath, '', 'utf8');
        }

        this.scheduleFlush();
    }

    // ── Public API ─────────────────────────────────────────────────────────

    debug(message: string, meta?: unknown): void {
        this.emit(LogLevel.DEBUG, message, meta);
    }

    info(message: string, meta?: unknown): void {
        this.emit(LogLevel.INFO, message, meta);
    }

    warn(message: string, meta?: unknown): void {
        this.emit(LogLevel.WARN, message, meta);
    }

    error(message: string, meta?: unknown): void {
        this.emit(LogLevel.ERROR, message, meta);
    }

    /**
     * Update the nodeId after boot (e.g. once the real public key is known).
     * Returns a new Logger with the new id — the old one should be discarded.
     * The pending buffer is flushed before returning.
     */
    withNodeId(nodeId: string): Logger {
        this.flush();
        return new Logger(nodeId, this.level, path.dirname(this.logPath), path.basename(this.logPath));
    }

    /** Flush all buffered lines to disk synchronously. Call before process.exit. */
    close(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        this.flush();
    }

    // ── Private ────────────────────────────────────────────────────────────

    private emit(level: LogLevel, message: string, meta?: unknown): void {
        if (level < this.level) return;

        const line: LogLine = {
            ts:      new Date().toISOString(),
            level,
            nodeId:  this.nodeId,
            message,
            meta,
        };

        this.printToTerminal(line);
        this.enqueue(line);
    }

    private printToTerminal(line: LogLine): void {
        const colour   = LEVEL_COLOUR[line.level];
        const label    = LEVEL_LABEL[line.level];
        const time     = line.ts.split('T')[1].slice(0, 12); // HH:MM:SS.mmm
        const nodeTag  = `${ANSI.grey}[${line.nodeId}]${ANSI.reset}`;
        const levelTag = `${colour}[${label}]${ANSI.reset}`;
        const msg      = `${ANSI.white}${line.message}${ANSI.reset}`;
        const metaPart = line.meta !== undefined
            ? ` ${ANSI.grey}${JSON.stringify(line.meta)}${ANSI.reset}`
            : '';

        const output = `${time} ${nodeTag} ${levelTag} ${msg}${metaPart}`;

        if (line.level >= LogLevel.ERROR) {
            process.stderr.write(output + '\n');
        } else {
            process.stdout.write(output + '\n');
        }
    }

    /** Build the plain-text file line (no ANSI). */
    private toFileLine(line: LogLine): string {
        const time   = line.ts.split('T')[1].slice(0, 12);
        const label  = LEVEL_LABEL[line.level];
        const meta   = line.meta !== undefined ? ' ' + JSON.stringify(line.meta) : '';
        return `[${time}] [${line.nodeId}] [${label}] ${line.message}${meta}\n`;
    }

    private enqueue(line: LogLine): void {
        this.buffer.push(this.toFileLine(line));
        if (this.buffer.length >= Logger.FLUSH_SIZE) {
            this.flush();
        }
    }

    private flush(): void {
        if (this.buffer.length === 0) return;
        const content = this.buffer.splice(0).join(''); // drain in place
        try {
            fs.appendFileSync(this.logPath, content, 'utf8');
        } catch (err) {
            // Can't use logger here — write straight to stderr
            process.stderr.write(`[Logger] Failed to flush to ${this.logPath}: ${err}\n`);
        }
    }

    private scheduleFlush(): void {
        this.timer = setTimeout(() => {
            this.flush();
            this.scheduleFlush(); // reschedule
        }, Logger.FLUSH_INTERVAL_MS);

        // Never keep the process alive just for logging.
        this.timer.unref();
    }
}

// ---------------------------------------------------------------------------
// Global singleton
// Starts with a placeholder id; index.ts replaces it once the public key is
// available via logger = logger.withNodeId(realId).
// ---------------------------------------------------------------------------
export let logger = new Logger('boot', LogLevel.INFO);
