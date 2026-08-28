import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = path.resolve(scriptDirectory, '..');

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function repositoryHead(repositoryRoot, override) {
  if (override) {
    if (!/^[0-9a-f]{40}$/i.test(override)) throw new Error(`invalid repository HEAD override: ${override}`);
    return override.toLowerCase();
  }
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  const head = result.status === 0 ? result.stdout.trim() : '';
  if (!/^[0-9a-f]{40}$/i.test(head)) {
    throw new Error(`cannot resolve repository HEAD: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return head.toLowerCase();
}

export function productFiles(repositoryRoot) {
  const roots = [
    path.join(repositoryRoot, 'engine'),
    path.join(repositoryRoot, 'engine-net48'),
    path.join(repositoryRoot, 'extension', 'media'),
    path.join(repositoryRoot, 'extension', 'src'),
  ];
  const fixed = [
    'extension/package.json',
    'extension/package-lock.json',
    'extension/tsconfig.json',
    'extension/.vscodeignore',
  ];
  const files = roots.flatMap((root) => walk(root)).filter((file) => {
    const relative = relativePath(repositoryRoot, file);
    if (relative.startsWith('extension/src/')) {
      return file.endsWith('.ts')
        && !file.endsWith('.test.ts')
        && !/(?:^|\/)(?:e2e|suite|scenarioEvidence)\.ts$/i.test(relative);
    }
    return true;
  });
  for (const relative of fixed) {
    const file = path.join(repositoryRoot, relative);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) files.push(file);
  }
  return [...new Set(files.map((file) => path.resolve(file)))]
    .sort((left, right) => relativePath(repositoryRoot, left).localeCompare(relativePath(repositoryRoot, right)));
}

export function productTree(repositoryRoot) {
  const files = productFiles(repositoryRoot);
  if (files.length === 0) throw new Error('product tree is empty');
  const digest = createHash('sha256');
  for (const file of files) {
    const relative = relativePath(repositoryRoot, file);
    const bytes = fs.readFileSync(file);
    digest.update(Buffer.from(`${relative}\0${bytes.length}\0`, 'utf8'));
    digest.update(bytes);
    digest.update(Buffer.from('\0', 'utf8'));
  }
  return { sha256: digest.digest('hex'), fileCount: files.length };
}

export function sourceArtifact(inputFile, evidenceDirectory) {
  const input = path.resolve(inputFile);
  const evidenceRoot = path.resolve(evidenceDirectory);
  const relative = path.relative(evidenceRoot, input).replace(/\\/g, '/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error(`raw test source must be inside the evidence directory: ${input}`);
  }
  const bytes = fs.readFileSync(input);
  return { path: relative, sha256: sha256(bytes), bytes: bytes.length };
}

export function buildEvidenceProvenance(repositoryRoot, options = {}) {
  const head = repositoryHead(repositoryRoot, options.repositoryHead);
  const product = productTree(repositoryRoot);
  return {
    schemaVersion: 'v2-evidence-provenance.1',
    runId: process.env.WFD_EVIDENCE_RUN_ID ?? `local-${head.slice(0, 12)}-${product.sha256.slice(0, 12)}`,
    repositoryHead: head,
    productTreeSha256: product.sha256,
    productFileCount: product.fileCount,
    producer: options.producer,
    sourceArtifact: options.sourceArtifact ?? null,
  };
}

function walk(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (['bin', 'obj', 'node_modules', 'dist', 'coverage', '.vscode-test', 'out'].includes(entry.name)) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile()) files.push(candidate);
    }
  }
  return files;
}

function relativePath(repositoryRoot, file) {
  return path.relative(repositoryRoot, file).replace(/\\/g, '/');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = (name) => {
    const prefix = `--${name}=`;
    return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  };
  const repositoryRoot = path.resolve(option('repo-root') ?? defaultRepositoryRoot);
  const provenance = buildEvidenceProvenance(repositoryRoot, {
    producer: option('producer') ?? 'unknown',
    repositoryHead: option('repository-head'),
  });
  process.stdout.write(`${JSON.stringify(provenance)}\n`);
}
