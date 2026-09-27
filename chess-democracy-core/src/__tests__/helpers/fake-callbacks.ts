import { vi } from 'vitest';
import type { MessageCallbacks } from '../../network/message-service.js';

const NAMES: Array<keyof MessageCallbacks> = [
    'setTimeOffset', 'onGameStart', 'onGameOver', 'onSideChoice', 'onReady', 'onUnready',
    'onConfigProposal', 'onConfigAccept', 'onVote', 'onTallyResult', 'onGameSnapshot',
    'onDrawOffer', 'onDrawResponse', 'onResignVote',
];

/** Every callback a network hands inbound messages to, as spies. */
export function fakeCallbacks(overrides: Partial<MessageCallbacks> = {}): MessageCallbacks {
    return { ...Object.fromEntries(NAMES.map(name => [name, vi.fn()])), ...overrides } as MessageCallbacks;
}
