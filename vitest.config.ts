import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/test/**/*.test.ts'],
    alias: {
      'vscode': './src/test/mocks/vscode.ts',
    },
  },
});
