import os from 'node:os';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

function run(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return result.error || result.status !== 0 ? undefined : result.stdout;
}

/**
 * The machine and source a release 2.1 run executed on. A dirty tree is recorded as such, not hidden: the built
 * artifacts are bound by their SHA-256 elsewhere in the report, and this names the commit they were built over.
 */
export function release21Environment(repo) {
  const head = run('git', ['rev-parse', 'HEAD'], repo)?.trim();
  const status = run('git', ['status', '--porcelain', '--untracked-files=normal'], repo);
  const changed = status === undefined ? undefined : status.split('\n').filter(Boolean).length;
  const runtimes = (run('dotnet.exe', ['--list-runtimes'], repo) ?? '').split('\n')
    .map(line => /^Microsoft\.WindowsDesktop\.App (\S+)/.exec(line.trim())?.[1])
    .filter(Boolean);
  const modernRuntime = runtimes.filter(version => version.startsWith('10.'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
  const frameworkRelease = /Release\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(run('reg.exe',
    ['query', 'HKLM\\SOFTWARE\\Microsoft\\NET Framework Setup\\NDP\\v4\\Full', '/v', 'Release'], repo) ?? '')?.[1];
  return {
    commit: head ?? 'unknown',
    workingTree: changed === undefined ? 'unknown' : changed === 0 ? 'clean' : `dirty (${changed} changed or untracked paths)`,
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    nodeArch: process.arch,
    windowsDesktopRuntime: modernRuntime ?? 'not found',
    netFrameworkRelease: frameworkRelease ? Number.parseInt(frameworkRelease, 16) : 'not found',
  };
}
