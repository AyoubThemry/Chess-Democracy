import type { ChessDemocracyAPI } from './ipc-types';

/** What preload.ts exposes, or null when the renderer runs in a plain browser. */
export function ipc(): ChessDemocracyAPI | null {
    if (typeof window === 'undefined') return null;
    return (window as { chessDemocracy?: ChessDemocracyAPI }).chessDemocracy ?? null;
}

/** For the calls that only make sense inside the app. */
export function bridge(): ChessDemocracyAPI {
    const api = ipc();
    if (!api) throw new Error('window.chessDemocracy is missing: not running inside Electron');
    return api;
}
