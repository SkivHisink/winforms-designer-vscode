import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(scriptDir, '..');
const extensionDir = path.join(repo, 'extension');
const outputDir = path.join(extensionDir, 'engine');
const supportedRids = new Set(['win-x64', 'win-arm64']);

const ridArg = process.argv.find((arg) => arg.startsWith('--rid='));
const rid = ridArg?.slice('--rid='.length) || process.env.WFD_BUNDLE_RID || 'win-x64';
if (!supportedRids.has(rid)) {
  throw new Error(`Unsupported modern engine RID: ${rid}`);
}

const assertInside = (parent, child) => {
  const relative = path.relative(parent, child);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside ${parent}: ${child}`);
  }
};

assertInside(extensionDir, outputDir);
fs.rmSync(outputDir, { recursive: true, force: true });

cp.execFileSync('dotnet', [
  'publish',
  '../engine',
  '-c',
  'Release',
  '-f',
  'net10.0-windows',
  '-r',
  rid,
  '--self-contained',
  'false',
  '-o',
  'engine',
], { cwd: extensionDir, stdio: 'inherit' });

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const requireFile = (relative) => {
  const file = path.join(outputDir, relative);
  if (!fs.existsSync(file)) {
    throw new Error(`Modern engine publish did not produce ${relative}`);
  }
  return file;
};

requireFile('WinFormsDesigner.Engine.exe');
requireFile('WinFormsDesigner.Engine.dll');
const runtimeconfig = readJson(requireFile('WinFormsDesigner.Engine.runtimeconfig.json'));
const deps = readJson(requireFile('WinFormsDesigner.Engine.deps.json'));

if (runtimeconfig.runtimeOptions?.tfm !== 'net10.0') {
  throw new Error(`Modern engine runtimeconfig has unexpected TFM: ${runtimeconfig.runtimeOptions?.tfm}`);
}

const targetNames = Object.keys(deps.targets ?? {});
if (!targetNames.some((target) => target.endsWith(`/${rid}`))) {
  throw new Error(`Modern engine deps.json does not contain target RID ${rid}`);
}

const otherRid = rid === 'win-x64' ? 'win-arm64' : 'win-x64';
if (targetNames.some((target) => target.endsWith(`/${otherRid}`))) {
  throw new Error(`Modern engine deps.json also contains sibling RID ${otherRid}`);
}

for (const forbidden of [
  'WinFormsDesigner.Engine.Net48.exe',
  'WinFormsDesigner.Engine.Net48.exe.config',
  'WinFormsDesigner.Engine.exe.config',
]) {
  if (fs.existsSync(path.join(outputDir, forbidden))) {
    throw new Error(`Modern engine output contains net48-only file ${forbidden}`);
  }
}

console.log(`Bundled modern engine: rid=${rid}, output=${path.relative(repo, outputDir)}`);
