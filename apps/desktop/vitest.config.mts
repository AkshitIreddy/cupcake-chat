import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      include: ['src/main/protocol.ts', 'src/main/ids.ts', 'src/main/url-policy.ts'],
    },
  },
});
