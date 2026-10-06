import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';

/** Bounded synchronous capture at the existing host request boundary. There is deliberately no stat-only cache:
 * a rebuilt DLL can retain both length and timestamp. Each reusable graph identity hashes the actual file bytes. */
export const DEPENDENCY_GRAPH_LIMITS = Object.freeze({ maxFiles: 256, maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024, maxElapsedMs: 100 });

export type DependencyGraphOpaqueReason = 'EMPTY_GRAPH' | 'INVALID_PATH' | 'SECRET_PATH' | 'UNSUPPORTED_FILE'
  | 'LINK_PATH' | 'FILE_LIMIT' | 'FILE_BYTES_LIMIT' | 'TOTAL_BYTES_LIMIT' | 'TIME_LIMIT' | 'UNREADABLE' | 'CHANGED_DURING_READ';
export interface DependencyGraphIdentity {
  fingerprint: string;
  mode: 'content' | 'opaque';
  files: number;
  bytes: number;
  reason?: DependencyGraphOpaqueReason;
}
export interface DependencyGraphIdentityOptions {
  /** Tests can tighten limits; callers cannot raise the product's bounds. */
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxElapsedMs?: number;
  clock?: () => number;
}
class OpaqueGraph extends Error {
  constructor(readonly reason: DependencyGraphOpaqueReason) { super(reason); }
}
function normalized(file: string): string {
  const absolute = path.resolve(file);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}
function validatePath(file: string): void {
  if (!file || !path.isAbsolute(file)) throw new OpaqueGraph('INVALID_PATH');
  if (file.split(/[\\/]/).some((part) => part.toLowerCase() === 'secrets')
    || /^\.env(?:\.|$)/i.test(path.basename(file)) || /\.(?:pfx|key|pem)$/i.test(file)) throw new OpaqueGraph('SECRET_PATH');
  if (!/\.(?:dll|exe|config|winmd|csproj|proj|projitems|props|targets)$/i.test(file)
    && !/\.(?:deps|runtimeconfig)\.json$/i.test(file)) throw new OpaqueGraph('UNSUPPORTED_FILE');
  // The resolver may authorize SDK/vendor dependencies outside the project. Their exact absolute paths are part
  // of identity, but no link at any path segment grants authority to read a different file.
  for (let candidate = path.resolve(file); ; candidate = path.dirname(candidate)) {
    if (fs.lstatSync(candidate).isSymbolicLink()) throw new OpaqueGraph('LINK_PATH');
    if (candidate === path.dirname(candidate)) break;
  }
}
function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
function tightened(value: number | undefined, maximum: number): number {
  return value === undefined ? maximum : Number.isFinite(value) && value >= 0 ? Math.min(value, maximum) : 0;
}

/** A graph that cannot be fully proven gets a fresh opaque identity on every capture. It can still be serviced in
 * isolation, but it never authorizes worker/graph reuse across requests on an unverified dependency fingerprint. */
export function captureDependencyGraphIdentity(files: readonly string[], options: DependencyGraphIdentityOptions = {}): DependencyGraphIdentity {
  const limits = {
    maxFiles: tightened(options.maxFiles, DEPENDENCY_GRAPH_LIMITS.maxFiles),
    maxFileBytes: tightened(options.maxFileBytes, DEPENDENCY_GRAPH_LIMITS.maxFileBytes),
    maxTotalBytes: tightened(options.maxTotalBytes, DEPENDENCY_GRAPH_LIMITS.maxTotalBytes),
    maxElapsedMs: tightened(options.maxElapsedMs, DEPENDENCY_GRAPH_LIMITS.maxElapsedMs),
  };
  const clock = options.clock ?? (() => performance.now());
  const started = clock();
  let observedFiles = 0; let observedBytes = 0;
  const checkTime = (): void => { if (clock() - started >= limits.maxElapsedMs) throw new OpaqueGraph('TIME_LIMIT'); };
  try {
    if (!files.length) throw new OpaqueGraph('EMPTY_GRAPH');
    // Check the input count before canonicalization; an oversized resolver graph cannot consume unbounded work.
    if (files.length > limits.maxFiles) throw new OpaqueGraph('FILE_LIMIT');
    const byPath = new Map<string, string>();
    for (const file of files) {
      checkTime();
      if (!path.isAbsolute(file)) throw new OpaqueGraph('INVALID_PATH');
      byPath.set(normalized(file), file);
    }
    const graph = createHash('sha256'); graph.update('dependency-graph-content-v1\n');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (const [identityPath, file] of [...byPath].sort(([left], [right]) => left.localeCompare(right))) {
      checkTime(); validatePath(file);
      let descriptor: number | undefined;
      try {
        descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        const before = fs.fstatSync(descriptor);
        validatePath(file);
        if (!sameFile(before, fs.lstatSync(file))) throw new OpaqueGraph('CHANGED_DURING_READ');
        if (before.size > limits.maxFileBytes) throw new OpaqueGraph('FILE_BYTES_LIMIT');
        if (observedBytes + before.size > limits.maxTotalBytes) throw new OpaqueGraph('TOTAL_BYTES_LIMIT');
        const content = createHash('sha256'); let byteLength = 0;
        while (true) {
          checkTime();
          const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
          if (!count) break;
          byteLength += count;
          if (byteLength > before.size) throw new OpaqueGraph('CHANGED_DURING_READ');
          content.update(buffer.subarray(0, count));
        }
        validatePath(file);
        if (byteLength !== before.size || !sameFile(before, fs.fstatSync(descriptor))
          || !sameFile(before, fs.lstatSync(file))) throw new OpaqueGraph('CHANGED_DURING_READ');
        graph.update(JSON.stringify([identityPath, byteLength, content.digest('hex')]) + '\n');
        observedFiles++; observedBytes += byteLength;
      } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
    }
    checkTime();
    return { fingerprint: graph.digest('hex'), mode: 'content', files: observedFiles, bytes: observedBytes };
  } catch (error) {
    const reason = error instanceof OpaqueGraph ? error.reason : 'UNREADABLE';
    return { fingerprint: createHash('sha256').update(`opaque-dependency-graph:${randomUUID()}`).digest('hex'),
      mode: 'opaque', reason, files: observedFiles, bytes: observedBytes };
  }
}
