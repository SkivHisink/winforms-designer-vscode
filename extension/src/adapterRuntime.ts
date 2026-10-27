import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TextDecoder } from 'node:util';
import {
  MAX_EXECUTION_MS, MAX_MESSAGE_BYTES, MAX_PACKAGE_BYTES, MAX_PACKAGE_FILE_BYTES, MAX_PACKAGE_FILES,
  validateAdapterPackage, validateAdapterRequest, validateAdapterResponse,
  type AdapterPackage, type AdapterRequest, type AdapterResponse,
} from '../../adapter-sdk/index.mjs';
import { assertLocalArtifactPath } from './localArtifactPath';

export interface AdapterRuntimeContext {
  readonly workspaceRoot: string;
  readonly productVersion: string;
  readonly runtime: 'modern' | 'net48';
  readonly architecture: 'x64' | 'arm64';
  readonly workspaceTrusted: boolean;
  readonly availableServices?: readonly string[];
}

export interface AdapterRuntimeDiagnostic { readonly code: string; readonly path?: string; }
export interface AdapterPackageIdentity {
  readonly manifest: AdapterPackage;
  readonly manifestPath: string;
  readonly packageRoot: string;
  /** Exact manifest bytes and every declared file, including names. Never a signature or vendor certification. */
  readonly packageSha256: string;
  readonly manifestSha256: string;
  readonly fileHashes: readonly { readonly path: string; readonly sha256: string; readonly bytes: number }[];
  readonly provenance: 'local-development';
  readonly certification: 'none';
}
export type AdapterInspection = ({ readonly ok: true; readonly diagnostics: readonly [] } & AdapterPackageIdentity)
  | { readonly ok: false; readonly diagnostics: readonly AdapterRuntimeDiagnostic[] };
export interface AdapterInvocationOptions {
  readonly enabledPackageSha256: string;
  readonly request: AdapterRequest;
  readonly signal?: AbortSignal;
  /** Must include current workspace trust and the current persisted content-hash enablement. */
  readonly isStillEnabled: () => boolean;
  readonly timeoutMs?: number;
}
export type AdapterInvocationResult = { readonly ok: true; readonly response: AdapterResponse; readonly inspection: AdapterPackageIdentity }
  | { readonly ok: false; readonly diagnostics: readonly AdapterRuntimeDiagnostic[] };

const MANIFEST_NAME = 'adapter-package.json';
const STDERR_LIMIT = 8 * 1024;
const MAX_ACTIVE_CHILDREN = 4;
const PROCESS_CLEANUP_MS = 5_000;
let activeChildren = 0;
interface PackageSnapshot { identity: AdapterPackageIdentity; modules: Record<string, string>; }
class AdapterRuntimeFailure extends Error {
  constructor(readonly code: string, readonly diagnosticPath?: string) { super(code); }
}

/** Inspection is data-only. The existing v2 declaration registry never confers executable authority. */
export async function inspectAdapterPackage(manifestPath: string, context: AdapterRuntimeContext): Promise<AdapterInspection> {
  try { return { ok: true, diagnostics: [], ...(await readPackage(manifestPath, context)).identity }; }
  catch (error) { return refused(error); }
}

/**
 * One explicitly enabled local package per fresh child. These are normal trusted-author OS privileges, not a
 * security sandbox. The linker limits the supported dependency contract; it does not contain malicious code.
 * A returned intent is data only: the caller must still recheck its document revision and mutation admission.
 */
export async function invokeAdapterPackage(
  manifestPath: string, context: AdapterRuntimeContext, options: AdapterInvocationOptions,
): Promise<AdapterInvocationResult> {
  options = Object.freeze({ ...options });
  let runnerDirectory: string | undefined;
  let admitted = false;
  let childOwnsAdmission = false;
  const releaseAdmission = (): void => { if (admitted) { admitted = false; activeChildren -= 1; } };
  try {
    const requestJson = stringifyBounded(options.request);
    const parsedRequest = validateAdapterRequest(JSON.parse(requestJson));
    if (!parsedRequest.ok) return { ok: false, diagnostics: parsedRequest.diagnostics.map(({ code }) => ({ code })) };
    const request = parsedRequest.value;
    const frozenContext = { ...context };
    assertEnabled(options);
    const snapshot = await readPackage(manifestPath, frozenContext);
    if (snapshot.identity.packageSha256 !== options.enabledPackageSha256) fail('ADAPTER_ENABLEMENT_HASH_MISMATCH');
    const list = request.operation === 'invokeAction' ? snapshot.identity.manifest.contributions.actions : snapshot.identity.manifest.contributions.editors;
    const contribution = list.find((item) => item.id === request.contributionId);
    if (!contribution) fail('ADAPTER_SERVICE_UNAVAILABLE');
    if (contribution.disabledReasonCode) fail(contribution.disabledReasonCode);
    const selectedRequest = validateAdapterRequest(request, contribution);
    if (!selectedRequest.ok) return { ok: false, diagnostics: selectedRequest.diagnostics.map(({ code }) => ({ code })) };
    if (request.context.propertyName !== contribution.propertyName || request.context.propertyType !== contribution.propertyType)
      fail('ADAPTER_RESULT_TARGET_MISMATCH');
    assertEnabled(options);
    if (activeChildren >= MAX_ACTIVE_CHILDREN) fail('ADAPTER_RUNTIME_BUSY');
    activeChildren += 1; admitted = true;
    // A private loader holds the already verified bytes. A module replaced after verification is never imported.
    const temporaryRoot = path.resolve(os.tmpdir());
    if (/^w:[\\/]/i.test(temporaryRoot)) fail('ADAPTER_PATH_DENIED');
    await assertLocalArtifactPath(temporaryRoot, temporaryRoot);
    runnerDirectory = await fs.mkdtemp(path.join(temporaryRoot, 'wfd-adapter-runtime-'));
    const loader = path.join(runnerDirectory, 'loader.mjs');
    await fs.writeFile(loader, makeLoader(snapshot.modules), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    // Revalidate every physical package file immediately before launch, after the asynchronous runner write.
    const beforeLaunch = await readPackage(manifestPath, frozenContext);
    if (beforeLaunch.identity.packageSha256 !== snapshot.identity.packageSha256) fail('ADAPTER_PACKAGE_CHANGED');
    assertEnabled(options);
    const output = await runChild(snapshot.identity, loader, requestJson, options,
      () => { childOwnsAdmission = true; }, releaseAdmission);
    assertEnabled(options);
    const after = await readPackage(manifestPath, frozenContext);
    if (after.identity.packageSha256 !== snapshot.identity.packageSha256) fail('ADAPTER_PACKAGE_CHANGED');
    assertEnabled(options);
    const response = validateAdapterResponse(parseOneResponse(output), request, contribution);
    if (!response.ok) return { ok: false, diagnostics: response.diagnostics.map(({ code }) => ({ code })) };
    return { ok: true, response: response.value, inspection: after.identity };
  } catch (error) { return refused(error); }
  finally {
    if (!childOwnsAdmission) releaseAdmission();
    if (runnerDirectory) {
      // Only this invocation's freshly-created directory can be removed, never the package or a computed parent.
      const temporaryRoot = path.resolve(os.tmpdir());
      const relative = path.relative(temporaryRoot, runnerDirectory);
      if (!relative.startsWith('..') && !path.isAbsolute(relative) && /^wfd-adapter-runtime-[^\\/]+$/.test(relative)) {
        try { await assertLocalArtifactPath(temporaryRoot, runnerDirectory); await fs.rm(runnerDirectory, { recursive: true, force: true }); }
        catch { /* cleanup is best effort; it does not grant an intent authority */ }
      }
    }
  }
}

function assertEnabled(options: AdapterInvocationOptions): void {
  if (options.signal?.aborted) fail('ADAPTER_CANCELLED');
  let enabled = false;
  try { enabled = options.isStillEnabled() === true; } catch { /* fail closed */ }
  if (!enabled) fail('ADAPTER_ENABLEMENT_REVOKED');
  if (!/^[a-f0-9]{64}$/.test(options.enabledPackageSha256)) fail('ADAPTER_ENABLEMENT_HASH_MISMATCH');
}

async function readPackage(manifestPath: string, context: AdapterRuntimeContext): Promise<PackageSnapshot> {
  if (!context.workspaceTrusted) fail('ADAPTER_WORKSPACE_UNTRUSTED');
  if (!path.isAbsolute(manifestPath) || path.basename(manifestPath) !== MANIFEST_NAME) fail('ADAPTER_PATH_DENIED');
  const absoluteManifest = path.resolve(manifestPath);
  const packageRoot = path.dirname(absoluteManifest);
  await authorizePath(context.workspaceRoot, absoluteManifest);
  const manifestBytes = await boundedRead(context.workspaceRoot, absoluteManifest, MAX_PACKAGE_FILE_BYTES);
  let parsed: unknown;
  try { parsed = JSON.parse(decodeUtf8(manifestBytes, 'ADAPTER_MANIFEST_INVALID')); } catch { fail('ADAPTER_MANIFEST_INVALID'); }
  const validation = validateAdapterPackage(parsed);
  if (!validation.ok) {
    const problem = validation.diagnostics[0];
    throw new AdapterRuntimeFailure(problem?.code ?? 'ADAPTER_MANIFEST_INVALID');
  }
  const manifest = validation.value;
  if (manifest.requiredServices?.some((service) => !context.availableServices?.includes(service))) fail('ADAPTER_SERVICE_UNAVAILABLE');
  const current = versionParts(context.productVersion);
  const minimum = versionParts(manifest.cohort.minProductVersion);
  const maximum = versionParts(manifest.cohort.maxProductVersionExclusive);
  if (!current || !minimum || !maximum || compareVersion(current, minimum) < 0 || compareVersion(current, maximum) >= 0
    || !manifest.cohort.runtimes.includes(context.runtime) || !manifest.cohort.architectures.includes(context.architecture))
    fail('ADAPTER_COHORT_UNSUPPORTED');
  const allowed = new Map(manifest.integrity.files.map((file) => [file.path, file.sha256]));
  for (const name of allowed.keys()) await authorizePath(context.workspaceRoot, path.resolve(packageRoot, ...name.split('/')));
  const actual = await enumerateFiles(context.workspaceRoot, packageRoot);
  const expected = new Set([MANIFEST_NAME, ...allowed.keys()]);
  if (actual.length !== expected.size || actual.some((file) => !expected.has(file))) fail('ADAPTER_UNDECLARED_PACKAGE_FILE');
  const fileHashes: { path: string; sha256: string; bytes: number }[] = [];
  const modules: Record<string, string> = Object.create(null);
  let total = manifestBytes.length;
  const identity = createHash('sha256').update('winforms-designer.adapter-package/0.1\0').update(manifestBytes);
  for (const name of [...allowed.keys()].sort()) {
    if (!/\.(?:mjs|json|md|txt)$/i.test(name) || /(?:^|\/)package\.json$/i.test(name)) fail('ADAPTER_PACKAGE_FILE_UNSUPPORTED');
    const filePath = path.resolve(packageRoot, ...name.split('/'));
    const bytes = await boundedRead(context.workspaceRoot, filePath, MAX_PACKAGE_FILE_BYTES);
    total += bytes.length;
    if (total > MAX_PACKAGE_BYTES) fail('ADAPTER_PACKAGE_TOO_LARGE');
    const sha256 = digest(bytes);
    if (sha256 !== allowed.get(name)) fail('ADAPTER_FILE_HASH_MISMATCH', name);
    identity.update('\0').update(name).update('\0').update(sha256);
    fileHashes.push({ path: name, sha256, bytes: bytes.length });
    if (name.endsWith('.mjs')) {
      // The content hash binds bytes; it does not authorize Node's replacement decoding of malformed source.
      decodeUtf8(bytes, 'ADAPTER_MODULE_INVALID');
      modules[pathToFileURL(filePath).href] = bytes.toString('base64');
    }
  }
  return { identity: { manifest, manifestPath: absoluteManifest, packageRoot, packageSha256: identity.digest('hex'),
    manifestSha256: digest(manifestBytes), fileHashes, provenance: 'local-development', certification: 'none' }, modules };
}

async function authorizePath(root: string, target: string): Promise<void> {
  if (/^w:[\\/]/i.test(target)) fail('ADAPTER_PATH_DENIED');
  try { await assertLocalArtifactPath(root, target); } catch { fail('ADAPTER_PATH_DENIED'); }
}
async function boundedRead(root: string, file: string, limit: number): Promise<Buffer> {
  await authorizePath(root, file);
  const information = await fs.lstat(file);
  if (!information.isFile() || information.size > limit) fail('ADAPTER_PACKAGE_TOO_LARGE');
  const handle = await fs.open(file, 'r');
  try {
    const bytes = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > limit) fail('ADAPTER_PACKAGE_TOO_LARGE');
    const after = await handle.stat();
    if (!after.isFile() || after.size !== bytesRead || information.size !== bytesRead || information.mtimeMs !== after.mtimeMs)
      fail('ADAPTER_PACKAGE_CHANGED');
    return bytes.subarray(0, bytesRead);
  } finally { await handle.close(); }
}
async function enumerateFiles(root: string, directory: string): Promise<string[]> {
  const result: string[] = [];
  let directories = 0;
  const visit = async (current: string): Promise<void> => {
    if (++directories > MAX_PACKAGE_FILES + 1) fail('ADAPTER_PACKAGE_TOO_LARGE');
    await authorizePath(root, current);
    const entries = await fs.readdir(current, { withFileTypes: true });
    if (entries.length > MAX_PACKAGE_FILES + 1) fail('ADAPTER_PACKAGE_TOO_LARGE');
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      // Reject prohibited names before reading anything inside them.
      await authorizePath(root, target);
      if (entry.name.toLowerCase() === 'node_modules' || entry.isSymbolicLink()) fail('ADAPTER_PATH_DENIED');
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) {
        result.push(path.relative(directory, target).split(path.sep).join('/'));
        if (result.length > MAX_PACKAGE_FILES + 1) fail('ADAPTER_PACKAGE_TOO_LARGE');
      } else fail('ADAPTER_PATH_DENIED');
    }
  };
  await visit(directory);
  return result.sort();
}

function makeLoader(modules: Record<string, string>): string {
  // This module's imports initialize before its hooks run. Adapter imports go through the strict hooks below.
  return `import { Buffer } from 'node:buffer';\nconst modules = ${JSON.stringify(modules)};\n`
    + `export async function resolve(specifier, context) {\n`
    + `  if (specifier === 'node:buffer') return {url:specifier,shortCircuit:true};\n`
    + `  let url; try { url = new URL(specifier, context.parentURL).href; } catch { throw new Error('ADAPTER_IMPORT_DENIED'); }\n`
    + `  if (!Object.hasOwn(modules,url)) throw new Error('ADAPTER_IMPORT_DENIED');\n`
    + `  return {url,shortCircuit:true};\n}\n`
    + `export async function load(url, context, nextLoad) {\n`
    + `  if(url === 'node:buffer') return nextLoad(url, context);\n`
    + `  if(!Object.hasOwn(modules,url)) throw new Error('ADAPTER_IMPORT_DENIED');\n`
    + `  return {format:'module',source:Buffer.from(modules[url],'base64'),shortCircuit:true};\n}\n`;
}

async function runChild(identity: AdapterPackageIdentity, loader: string, request: string, options: AdapterInvocationOptions,
  adoptAdmission: () => void, releaseAdmission: () => void): Promise<Buffer> {
  const timeoutMs = Math.min(MAX_EXECUTION_MS, Math.max(1, Number.isFinite(options.timeoutMs) ? options.timeoutMs! : MAX_EXECUTION_MS));
  return new Promise<Buffer>((resolve, reject) => {
    // VS Code 1.84's Electron/Node 18 also requires the switch used by its own code.cmd launcher.
    const electronFlags = process.versions.electron && Number(process.versions.node.split('.')[0]) <= 18 ? ['--ms-enable-electron-run-as-node'] : [];
    const child = spawn(process.execPath, [...electronFlags, '--no-warnings', '--experimental-loader', pathToFileURL(loader).href,
      path.resolve(identity.packageRoot, identity.manifest.execution.entrypoint)], {
      shell: false, windowsHide: true, cwd: identity.packageRoot, stdio: ['pipe', 'pipe', 'pipe'],
      // Do not inherit NODE_OPTIONS/NODE_PATH or arbitrary secret-bearing host environment variables.
      env: { ELECTRON_RUN_AS_NODE: '1', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}), ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
        ...(process.env.TMP ? { TMP: process.env.TMP } : {}) },
    });
    adoptAdmission();
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: string | undefined;
    let settled = false;
    let stopRequested = false;
    let childClosed = false;
    let childCode: number | null = null;
    let treeStopComplete = true;
    let killer: ReturnType<typeof spawn> | undefined;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearInterval(revocationTimer); if (cleanupTimer) clearTimeout(cleanupTimer);
      options.signal?.removeEventListener('abort', cancelled);
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      if (failure) reject(new AdapterRuntimeFailure(failure));
      else if (code !== 0) reject(new AdapterRuntimeFailure('ADAPTER_PROCESS_FAILED'));
      else resolve(Buffer.concat(chunks));
    };
    const finishStopped = (): void => {
      if (childClosed && treeStopComplete) finish(childCode);
    };
    const stop = (code: string): void => {
      if (settled || stopRequested) return;
      failure = code; stopRequested = true;
      // Only this invocation's live child PID is a target. Never a name, engine cohort, or user process.
      if (process.platform === 'win32' && child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        const systemRoot = process.env.SystemRoot;
        const taskkill = systemRoot ? path.join(systemRoot, 'System32', 'taskkill.exe') : undefined;
        if (taskkill) {
          treeStopComplete = false;
          killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
          const treeStopped = (confirmed: boolean): void => {
            if (treeStopComplete) return;
            treeStopComplete = true;
            // A short-lived producer can close itself after triggering an output refusal, before taskkill starts.
            // Its confirmed exit is not a cleanup failure merely because /PID can no longer find that process.
            if (!confirmed && !childClosed && child.exitCode === null && child.signalCode === null)
              failure = 'ADAPTER_PROCESS_CLEANUP_FAILED';
            // Do not kill the parent before /T has enumerated its descendants: that would orphan them.
            if (child.exitCode === null && child.signalCode === null) {
              try { child.kill('SIGKILL'); } catch { /* retain admission until actual close */ }
            }
            finishStopped();
          };
          killer.once('error', () => treeStopped(false));
          killer.once('close', (exitCode) => treeStopped(exitCode === 0));
        } else {
          failure = 'ADAPTER_PROCESS_CLEANUP_FAILED';
          child.kill('SIGKILL');
        }
      } else { try { child.kill('SIGKILL'); } catch { /* close or deadline confirms */ } }
      // Execution is already cancelled. Keep its physical admission and cwd until both the direct child and the
      // Windows tree-kill helper confirm termination. A separate bounded cleanup phase is not an execution extension.
      cleanupTimer = setTimeout(() => {
        failure = 'ADAPTER_PROCESS_CLEANUP_FAILED';
        try { if (killer?.exitCode === null && killer.signalCode === null) killer.kill('SIGKILL'); } catch { /* invocation-owned helper only */ }
        try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } catch { /* retain admission until actual close */ }
        finish(null);
      }, PROCESS_CLEANUP_MS);
    };
    const cancelled = (): void => stop('ADAPTER_CANCELLED');
    const timer = setTimeout(() => stop('ADAPTER_TIMEOUT'), timeoutMs);
    const revocationTimer = setInterval(() => {
      try { if (!options.isStillEnabled()) stop('ADAPTER_ENABLEMENT_REVOKED'); }
      catch { stop('ADAPTER_ENABLEMENT_REVOKED'); }
    }, 25);
    options.signal?.addEventListener('abort', cancelled, { once: true });
    if (options.signal?.aborted) cancelled();
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_MESSAGE_BYTES) stop('ADAPTER_MESSAGE_TOO_LARGE'); else if (!stopRequested) chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > STDERR_LIMIT) stop('ADAPTER_STDERR_TOO_LARGE'); });
    child.on('error', () => {
      if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) releaseAdmission();
      if (stopRequested && child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        failure = 'ADAPTER_PROCESS_CLEANUP_FAILED'; // a failed kill is not evidence of process exit
        return; // the tree helper, actual close, or bounded cleanup deadline still owns this invocation
      }
      failure = failure ?? 'ADAPTER_PROCESS_FAILED'; finish(null);
    });
    child.on('close', (code) => {
      releaseAdmission(); childClosed = true; childCode = code;
      if (stopRequested) finishStopped(); else finish(code);
    });
    child.stdin.on('error', () => { /* early exit is reported by close, without source-bearing error text */ });
    child.stdin.end(`${request}\n`);
  });
}

function parseOneResponse(bytes: Buffer): unknown {
  const output = decodeUtf8(bytes, 'ADAPTER_RESPONSE_INVALID');
  const newline = output.indexOf('\n');
  if (newline < 0 || output.slice(newline + 1).trim() !== '' || output.slice(0, newline).trim() === '') fail('ADAPTER_RESPONSE_FRAMING');
  try { return JSON.parse(output.slice(0, newline)); } catch { fail('ADAPTER_RESPONSE_INVALID'); }
}
function decodeUtf8(bytes: Uint8Array, code: string): string {
  try {
    // Preserve a leading BOM instead of silently stripping it: JSON's existing BOM refusal must remain intact.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch { fail(code); }
}
function stringifyBounded(value: unknown): string {
  let json: string;
  try { json = JSON.stringify(value); } catch { fail('ADAPTER_REQUEST_INVALID'); }
  if (typeof json !== 'string' || Buffer.byteLength(json) + 1 > MAX_MESSAGE_BYTES) fail('ADAPTER_MESSAGE_TOO_LARGE');
  return json;
}
function versionParts(version: string): number[] | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  const parts = match?.slice(1).map(Number);
  return parts?.every(Number.isSafeInteger) ? parts : undefined;
}
function compareVersion(left: number[], right: number[]): number {
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
}
function digest(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function fail(code: string, diagnosticPath?: string): never { throw new AdapterRuntimeFailure(code, diagnosticPath); }
function refused(error: unknown): { ok: false; diagnostics: AdapterRuntimeDiagnostic[] } {
  return { ok: false, diagnostics: [{ code: error instanceof AdapterRuntimeFailure ? error.code : 'ADAPTER_PACKAGE_READ_FAILED',
    ...(error instanceof AdapterRuntimeFailure && error.diagnosticPath ? { path: error.diagnosticPath } : {}) }] };
}
