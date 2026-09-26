// Copies the built core into staging/ with production dependencies only.
//
// electron-builder used to copy chess-democracy-core/node_modules wholesale,
// which shipped TypeScript, vitest, esbuild and friends (~78 MB) inside the
// app. Core only needs bonjour-service, chess.js and ws at runtime.

import { cpSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const core = join(here, '..', '..', 'chess-democracy-core');
const out  = join(here, '..', 'staging', 'chess-democracy-core');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

cpSync(join(core, 'dist'), join(out, 'dist'), { recursive: true });
cpSync(join(core, 'package.json'),      join(out, 'package.json'));
cpSync(join(core, 'package-lock.json'), join(out, 'package-lock.json'));

execSync('npm ci --omit=dev --no-audit --no-fund', { cwd: out, stdio: 'inherit' });

// Native modules (hyperswarm's sodium-native, udx-native, ...) ship prebuilt
// binaries for every platform: Linux, macOS, Android, ARM. The app only
// needs the one it's being packaged for, which is the machine building it.
const target = `${process.platform}-${process.arch}`;
let dropped = 0;
function prune(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const full = join(dir, entry.name);
        if (entry.name === 'prebuilds') {
            for (const platform of readdirSync(full)) {
                if (platform !== target) { rmSync(join(full, platform), { recursive: true, force: true }); dropped++; }
            }
        } else {
            prune(full);
        }
    }
}
prune(join(out, 'node_modules'));
console.log(`Kept ${target} native builds, dropped ${dropped} for other platforms`);
