import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals:     true,
        environment: 'node',
        include:     ['src/__tests__/**/*.test.ts'],
        exclude:     ['src/__tests__/integration/**'],
        coverage: {
            provider:   'v8',
            reporter:   ['text', 'lcov'],
            include:    ['src/**/*.ts'],
            exclude:    ['src/__tests__/**', 'src/index.ts'],
            thresholds: { lines: 70, functions: 70, branches: 60, statements: 70 },
        },
    },
});
