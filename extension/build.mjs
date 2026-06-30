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

console.log('build ok');
