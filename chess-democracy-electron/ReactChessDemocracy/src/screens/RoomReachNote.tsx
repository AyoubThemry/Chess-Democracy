/**
 * Over the internet, a player can be found in the room but never reached:
 * a strict router or mobile network on either side refuses the direct
 * connection. Without this the room would just look empty.
 */

import { useStore } from '../store';
import './NetworkScreen.css';

export default function RoomReachNote() {
    const reach = useStore(s => s.reach);
    if (!reach) return null;
    const missing = reach.found - reach.connected;
    if (missing <= 0) return null;
    const players = missing === 1 ? '1 player' : `${missing} players`;

    return reach.stuck
        ? <p className="room-reach room-reach--stuck" role="status">
              Found {players} but can't connect. A strict router or mobile network on either side can block direct connections.
          </p>
        : <p className="room-reach" role="status">Connecting to {players}…</p>;
}
