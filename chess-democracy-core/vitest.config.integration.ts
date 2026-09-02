import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals:     true,
        environment: 'node',
        include:     ['src/__tests__/integration/**/*.test.ts'],
        testTimeout: 60_000,
        hookTimeout: 15_000,
        // Single thread — real WebSocket servers + timers need sequential execution
        pool:        'forks',
        poolOptions: { forks: { singleFork: true } },
        reporters:   ['verbose'],
    },
});
