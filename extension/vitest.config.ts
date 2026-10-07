import { defineConfig } from 'vitest/config';

// Only OUR unit tests. Without an explicit include, vitest also discovers test files inside `.vscode-test/` — the
// VS Code build that `npm run extension-host-e2e` downloads ships its own `*.test.mts` scripts — so `npm test` went
// red with "No test suite found" for a file that is not ours, on any machine that had run the host suite.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Many tests write and fsync real journals, backups and workspaces. They take tens to hundreds of milliseconds
    // locally, but a slow shared CI runner has stretched one past vitest's 5 s default; a hang still fails at 20 s.
    testTimeout: 20_000,
  },
});
