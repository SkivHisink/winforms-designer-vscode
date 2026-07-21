import * as esbuild from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
};

// VS Code extension entry (vscode is provided by the host at runtime)
await esbuild.build({
  ...common,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  external: ['vscode'],
});

// Headless end-to-end client (no vscode dependency) to prove the ext side without the GUI
await esbuild.build({
  ...common,
  entryPoints: ['src/e2e.ts'],
  outfile: 'dist/e2e.cjs',
});

// Headless live-webview tests (T2.3): load the real media/*.js into jsdom and drive interactions.
// jsdom is a devDependency resolved from node_modules at runtime, so keep it external (not bundled).
await esbuild.build({
  ...common,
  entryPoints: ['src/webview-e2e.ts'],
  outfile: 'dist/webview-e2e.cjs',
  external: ['jsdom'],
});

// Real VS Code Extension Host smoke suite. @vscode/test-electron loads this module inside the tested VS Code
// version, so `vscode` must stay external and be provided by that host.
await esbuild.build({
  ...common,
  entryPoints: ['src/extension-host-suite.ts'],
  outfile: 'dist/extension-host-suite.cjs',
  external: ['vscode'],
});

// Repeatable cold-start + warm-render guardrail. Kept as a small bundled client so CI measures the same JSON-RPC
// path as the extension without involving VS Code, jsdom, or a package-manager test runner.
await esbuild.build({
  ...common,
  entryPoints: ['src/performance-baseline.ts'],
  outfile: 'dist/performance-baseline.cjs',
});

console.log('build ok');
