import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react-swc';

export default defineConfig({
    plugins: [react()],
    test: {
        environment: 'jsdom',
        globals: true,
        setupFiles: ['./src/__tests__/setup.ts'],
        include: ['src/**/*.{test,spec}.{ts,tsx}'],
        coverage: {
            provider: 'v8',
            reporter:  ['text', 'html'],
            include:   ['src/**/*.{ts,tsx}'],
            exclude:   ['src/**/*.d.ts', 'src/main.tsx'],
        },
    },
});
