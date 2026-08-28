import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(scriptDir, '..');
const extensionDir = path.join(repo, 'extension');
const outputDir = path.join(extensionDir, 'engine-net48');
const supportedPackageRids = new Set(['win-x64', 'win-arm64']);
const packageRid = process.env.WFD_BUNDLE_RID || 'win-x64';

if (!supportedPackageRids.has(packageRid)) {
  throw new Error(`Unsupported package RID for net48 compatibility bundle: ${packageRid}`);
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
  '../engine-net48',
  '-c',
  'Release',
  '-p:PlatformTarget=x64',
  '-o',
  'engine-net48',
], { cwd: extensionDir, stdio: 'inherit' });

const requireFile = (relative) => {
  const file = path.join(outputDir, relative);
  if (!fs.existsSync(file)) {
    throw new Error(`net48 compatibility publish did not produce ${relative}`);
  }
  return file;
};

requireFile('WinFormsDesigner.Engine.Net48.exe');
const config = fs.readFileSync(requireFile('WinFormsDesigner.Engine.Net48.exe.config'), 'utf8');
if (!config.includes('.NETFramework,Version=v4.8')) {
  throw new Error('net48 compatibility engine config does not declare .NET Framework 4.8');
}

for (const forbidden of [
  'WinFormsDesigner.Engine.exe',
  'WinFormsDesigner.Engine.dll',
  'WinFormsDesigner.Engine.deps.json',
  'WinFormsDesigner.Engine.runtimeconfig.json',
]) {
  if (fs.existsSync(path.join(outputDir, forbidden))) {
    throw new Error(`net48 compatibility output contains modern-engine file ${forbidden}`);
  }
}

console.log(`Bundled net48 compatibility engine: platform=x64, packageRid=${packageRid}, output=${path.relative(repo, outputDir)}`);
