import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';

/**
 * Bounded synchronous capture at the existing host request boundary. Each reusable graph identity is made of the
 * actual file bytes' digests; there is no stat-only identity, since a rebuilt DLL can retain both length and
 * timestamp.
 *
 * Re-reading every byte on every request cannot keep up with a real output (hundreds of megabytes of vendor and
 * native libraries), and a graph over the budget is opaque, which starts a new engine for every request. So a digest
 * is kept with the snapshot it was read under — device, file id, size, write, change and creation times — and reused
 * while that snapshot is unchanged: an ordinary write moves the change time even when the write time is put back, and
 * replacing the file changes its id. What a request's budget cannot read is digested in the background, and the graph
 * stays opaque until it has been.
 *
 * This is the one place the identity is not proof of the current bytes: a kept digest is evidence of the bytes as
 * they were read. A write through a memory-mapped view moves no snapshot field, so a capture that uses a digest whose
 * read began REVERIFY_MS ago or more has the file read again in the background; a different result changes the
 * identity at a later capture, and a failed read drops the digest. That is eventual detection of a persistent,
 * readable change while the designer is in use — not a time bound (the re-read waits for a capture, the queue and the
 * read itself), and not a binding between the identity and the bytes an engine loads: a mapped write that an engine
 * loads and that is undone before the re-read is not seen. A native image or a .NET Framework assembly an engine has
 * loaded cannot be written while it is loaded; an assembly the modern engine read into memory can.
 */
export const DEPENDENCY_GRAPH_LIMITS = Object.freeze({ maxFiles: 256, maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024, maxElapsedMs: 100 });
/** A file the background digests: a vendor's native library can be hundreds of megabytes. Larger stays opaque. */
const MAX_BACKGROUND_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_CACHED_DIGESTS = 4096;
/** A file written this shortly before its read began is not kept: a second write within one tick of the file
 * system's clock can leave every time in its snapshot as it was (the "racy" case). */
const RECENT_WRITE_MS = 2000;
/** How long after its read began a kept digest is read again in the background, by the next capture that uses it. */
const REVERIFY_MS = 30_000;

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
  /** Tests only: the wall clock the file times are compared with (default Date.now). */
  wallClock?: () => number;
  // `clock` (monotonic) also measures how old a kept digest is.
}
class OpaqueGraph extends Error {
  constructor(readonly reason: DependencyGraphOpaqueReason) { super(reason); }
}
function normalized(file: string): string {
  const absolute = path.resolve(file);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}
/** `checkedFolders`: folders this same synchronous capture already found to be no link (each is checked once). */
function validatePath(file: string, checkedFolders?: Set<string>): void {
  if (!file || !path.isAbsolute(file)) throw new OpaqueGraph('INVALID_PATH');
  if (file.split(/[\\/]/).some((part) => part.toLowerCase() === 'secrets')
    || /^\.env(?:\.|$)/i.test(path.basename(file)) || /\.(?:pfx|key|pem)$/i.test(file)) throw new OpaqueGraph('SECRET_PATH');
  if (!/\.(?:dll|exe|config|winmd|csproj|proj|projitems|props|targets)$/i.test(file)
    && !/\.(?:deps|runtimeconfig)\.json$/i.test(file)) throw new OpaqueGraph('UNSUPPORTED_FILE');
  // The resolver may authorize SDK/vendor dependencies outside the project. Their exact absolute paths are part
  // of identity, but no link at any path segment grants authority to read a different file.
  for (let candidate = path.resolve(file); ; candidate = path.dirname(candidate)) {
    const folder = candidate !== path.resolve(file);
    if (folder && checkedFolders?.has(candidate)) break; // it and every folder above it were checked
    if (fs.lstatSync(candidate).isSymbolicLink()) throw new OpaqueGraph('LINK_PATH');
    if (candidate === path.dirname(candidate)) break;
  }
  for (let folder = path.dirname(path.resolve(file)); checkedFolders && !checkedFolders.has(folder); folder = path.dirname(folder)) {
    checkedFolders.add(folder);
    if (folder === path.dirname(folder)) break;
  }
}
function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
function tightened(value: number | undefined, maximum: number): number {
  return value === undefined ? maximum : Number.isFinite(value) && value >= 0 ? Math.min(value, maximum) : 0;
}

interface FileSnapshot { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; birthtimeMs: number; }
/** `readAt`: when the read of these bytes began, on the monotonic clock. */
interface CachedDigest extends FileSnapshot { digest: string; readAt: number; }
/** Digests of whole files, each valid only for the exact snapshot it was read under. */
const digests = new Map<string, CachedDigest>();
function snapshotOf(stats: fs.Stats): FileSnapshot {
  return { dev: stats.dev, ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs, birthtimeMs: stats.birthtimeMs };
}
function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs && left.birthtimeMs === right.birthtimeMs;
}
/** The wall clock the file times are compared with, and the monotonic clock a kept digest's age is measured on (a
 * wall clock set back would make every digest young again). */
interface Clocks { wall: () => number; monotonic: () => number; }
/** The kept digest for this exact snapshot, if any. One whose read began at least REVERIFY_MS ago is still used while
 * its bytes are read again in the background (a write through a mapped view leaves the snapshot as it was): a read
 * that completes replaces it, one that fails drops it, and the background queue serves every file it is given. */
function cachedDigest(identityPath: string, file: string, stats: fs.Stats, clocks: Clocks): string | undefined {
  const cached = digests.get(identityPath);
  if (!cached || !stats.isFile() || !sameSnapshot(cached, snapshotOf(stats))) return undefined;
  if (clocks.monotonic() - cached.readAt >= REVERIFY_MS) digestInBackground(file, clocks);
  return cached.digest;
}
/** Keep a digest read under `stats`, the read having begun at wall time `wallStart` and monotonic time `start`. Not
 * when the file had been written less than RECENT_WRITE_MS before the read: a later write in the same clock tick could
 * leave the snapshot unchanged. */
function rememberDigest(identityPath: string, stats: fs.Stats, digest: string, wallStart: number, start: number): void {
  digests.delete(identityPath);
  if (wallStart - Math.max(stats.mtimeMs, stats.ctimeMs, stats.birthtimeMs) < RECENT_WRITE_MS) return;
  digests.set(identityPath, { ...snapshotOf(stats), digest, readAt: start });
  while (digests.size > MAX_CACHED_DIGESTS) digests.delete(digests.keys().next().value as string);
}

const backgroundQueue: { file: string; clocks: Clocks }[] = [];
const backgroundPending = new Set<string>();
let backgroundRunning = false;
let backgroundDone: Promise<void> = Promise.resolve();
/** Digest a file the request's budget could not read, or read a kept one again, one at a time, off the request path. */
function digestInBackground(file: string, clocks: Clocks): void {
  const identityPath = normalized(file);
  if (backgroundPending.has(identityPath)) return;
  backgroundPending.add(identityPath);
  backgroundQueue.push({ file, clocks });
  if (!backgroundRunning) { backgroundRunning = true; backgroundDone = drainBackground(); }
}
async function drainBackground(): Promise<void> {
  try {
    for (let job = backgroundQueue.shift(); job !== undefined; job = backgroundQueue.shift()) {
      const identityPath = normalized(job.file);
      const checked = digests.get(identityPath); // the digest this read is checking, if any
      let kept = false;
      try { kept = await digestFile(job.file, job.clocks); } catch { /* not kept */ }
      finally {
        // A read that did not complete proves nothing about the bytes: the digest it was checking goes, and a later
        // capture reads the file itself (or stays opaque while it cannot). A newer one a capture kept meanwhile stays.
        if (!kept && digests.get(identityPath) === checked) digests.delete(identityPath);
        backgroundPending.delete(identityPath);
      }
    }
  } finally {
    // Cleared in the same turn the empty queue was seen: a file queued after this starts a new run.
    backgroundRunning = false;
  }
}
/** Tests only: resolves once the background digests queued so far have finished. */
export async function settleBackgroundDigests(): Promise<void> {
  while (backgroundRunning) await backgroundDone;
}
/** True when the file's whole content was read under one unchanged snapshot and its digest kept. */
async function digestFile(file: string, clocks: Clocks): Promise<boolean> {
  validatePath(file);
  const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    // As the request path does: the opened file must still be the one the checked path names before a byte is read.
    validatePath(file);
    if (!sameFile(before, fs.lstatSync(file)) || before.size > MAX_BACKGROUND_FILE_BYTES) return false;
    const wallStart = clocks.wall(); const start = clocks.monotonic();
    const content = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let byteLength = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      byteLength += bytesRead;
      if (byteLength > before.size) return false;
      content.update(buffer.subarray(0, bytesRead));
    }
    validatePath(file);
    if (byteLength !== before.size || !sameFile(before, await handle.stat()) || !sameFile(before, fs.lstatSync(file))) return false;
    const identityPath = normalized(file);
    rememberDigest(identityPath, before, content.digest('hex'), wallStart, start);
    return digests.has(identityPath);
  } finally { await handle.close(); }
}

/** A graph that cannot be fully proven gets a fresh opaque identity on every capture. It can still be serviced in
 * isolation, but it never authorizes worker/graph reuse across requests on an unverified dependency fingerprint.
 * A file over the request's byte or time budget is handed to the background digest; the graph is opaque (with that
 * limit as the reason) until a later capture finds every digest, each still valid for its file's snapshot. */
export function captureDependencyGraphIdentity(files: readonly string[], options: DependencyGraphIdentityOptions = {}): DependencyGraphIdentity {
  const limits = {
    maxFiles: tightened(options.maxFiles, DEPENDENCY_GRAPH_LIMITS.maxFiles),
    maxFileBytes: tightened(options.maxFileBytes, DEPENDENCY_GRAPH_LIMITS.maxFileBytes),
    maxTotalBytes: tightened(options.maxTotalBytes, DEPENDENCY_GRAPH_LIMITS.maxTotalBytes),
    maxElapsedMs: tightened(options.maxElapsedMs, DEPENDENCY_GRAPH_LIMITS.maxElapsedMs),
  };
  const clock = options.clock ?? (() => performance.now());
  const clocks: Clocks = { wall: options.wallClock ?? Date.now, monotonic: clock };
  const started = clock();
  let observedFiles = 0; let observedBytes = 0; let readBytes = 0;
  const timeIsUp = (): boolean => clock() - started >= limits.maxElapsedMs;
  const checkTime = (): void => { if (timeIsUp()) throw new OpaqueGraph('TIME_LIMIT'); };
  // The first budget a file exceeded: it goes to the background digest, and this capture ends opaque.
  let deferred: DependencyGraphOpaqueReason | undefined;
  const defer = (file: string, reason: DependencyGraphOpaqueReason): void => {
    deferred ??= reason;
    digestInBackground(file, clocks);
  };
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
    // A folder shared by many files is checked for links once per capture. A file whose path changed through a new
    // link is another file, so its snapshot no longer matches; a file that is read is checked in full again.
    const checkedFolders = new Set<string>();
    for (const [identityPath, file] of [...byPath].sort(([left], [right]) => left.localeCompare(right))) {
      validatePath(file, checkedFolders);
      const current = fs.lstatSync(file);
      const known = cachedDigest(identityPath, file, current, clocks);
      if (known !== undefined) {
        graph.update(JSON.stringify([identityPath, current.size, known]) + '\n');
        observedFiles++; observedBytes += current.size;
        continue;
      }
      if (timeIsUp()) { defer(file, 'TIME_LIMIT'); continue; }
      let descriptor: number | undefined;
      try {
        descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        const before = fs.fstatSync(descriptor);
        validatePath(file);
        if (!sameFile(before, fs.lstatSync(file))) throw new OpaqueGraph('CHANGED_DURING_READ');
        if (before.size > limits.maxFileBytes) { defer(file, 'FILE_BYTES_LIMIT'); continue; }
        if (readBytes + before.size > limits.maxTotalBytes) { defer(file, 'TOTAL_BYTES_LIMIT'); continue; }
        const wallStart = clocks.wall(); const readStart = clock();
        const content = createHash('sha256'); let byteLength = 0; let outOfTime = false;
        while (true) {
          if (timeIsUp()) { outOfTime = true; break; }
          const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
          if (!count) break;
          byteLength += count;
          if (byteLength > before.size) throw new OpaqueGraph('CHANGED_DURING_READ');
          content.update(buffer.subarray(0, count));
        }
        readBytes += byteLength;
        if (outOfTime) { defer(file, 'TIME_LIMIT'); continue; }
        validatePath(file);
        if (byteLength !== before.size || !sameFile(before, fs.fstatSync(descriptor))
          || !sameFile(before, fs.lstatSync(file))) throw new OpaqueGraph('CHANGED_DURING_READ');
        const digest = content.digest('hex');
        rememberDigest(identityPath, before, digest, wallStart, readStart);
        graph.update(JSON.stringify([identityPath, byteLength, digest]) + '\n');
        observedFiles++; observedBytes += byteLength;
      } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
    }
    if (deferred) throw new OpaqueGraph(deferred);
    checkTime();
    return { fingerprint: graph.digest('hex'), mode: 'content', files: observedFiles, bytes: observedBytes };
  } catch (error) {
    const reason = error instanceof OpaqueGraph ? error.reason : 'UNREADABLE';
    return { fingerprint: createHash('sha256').update(`opaque-dependency-graph:${randomUUID()}`).digest('hex'),
      mode: 'opaque', reason, files: observedFiles, bytes: observedBytes };
  }
}
