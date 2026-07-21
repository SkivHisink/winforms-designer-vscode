import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(scriptDir, '..');
const requireFromExtension = createRequire(path.join(repo, 'extension', 'package.json'));
const { runTests } = requireFromExtension('@vscode/test-electron');
const extensionDevelopmentPath = path.join(repo, 'extension');
const extensionTestsPath = path.join(extensionDevelopmentPath, 'dist', 'extension-host-suite.cjs');
const testTemp = path.join(extensionDevelopmentPath, '.vscode-test', 'tmp');
fs.mkdirSync(testTemp, { recursive: true });
process.env.TEMP = testTemp;
process.env.TMP = testTemp;
// Run this from VS Code's own integrated terminal (or any child of an extension host) and ELECTRON_RUN_AS_NODE=1 is
// inherited. The downloaded VS Code then boots as plain Node, treats the first launch arg as a script, and dies with
// a baffling "Cannot find module .../samples/DemoApp" that looks like a missing fixture rather than a stray env var.
// CONTRIBUTING tells contributors to run this suite, so make the documented command work wherever it is typed.
delete process.env.ELECTRON_RUN_AS_NODE;
const version = process.argv.find((arg) => arg.startsWith('--version='))?.slice('--version='.length)
  || process.env.VSCODE_TEST_VERSION
  || 'stable';

try {
  await runTests({
    version,
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [path.join(repo, 'samples', 'DemoApp'), '--disable-extensions', '--skip-welcome', '--skip-release-notes'],
  });
  console.log(`VS Code Extension Host smoke passed: ${version}`);
} catch (error) {
  console.error(`VS Code Extension Host smoke failed: ${version}`);
  console.error(error);
  process.exit(1);
}
