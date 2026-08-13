import { defineConfig } from 'vitest/config';

// Only OUR unit tests. Without an explicit include, vitest also discovers test files inside `.vscode-test/` — the
// VS Code build that `npm run extension-host-e2e` downloads ships its own `*.test.mts` scripts — so `npm test` went
// red with "No test suite found" for a file that is not ours, on any machine that had run the host suite.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
