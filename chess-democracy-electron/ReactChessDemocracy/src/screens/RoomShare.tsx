/**
 * The room code, with a button to copy it, for sending to friends. Shown on
 * the side and lobby screens when playing over the internet.
 */

import { useState } from 'react';
import { useStore } from '../store';
import './NetworkScreen.css';

export default function RoomShare() {
    const room = useStore(s => s.room);
    const [copied, setCopied] = useState(false);
    if (!room) return null;

    async function copy() {
        try {
            await navigator.clipboard.writeText(room!);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch { /* clipboard unavailable: the code is on screen to read out */ }
    }

    return (
        <span className="room-share">
            Room <code>{room}</code>
            <button onClick={copy} title="Copy the room code">{copied ? 'Copied' : 'Copy'}</button>
        </span>
    );
}
