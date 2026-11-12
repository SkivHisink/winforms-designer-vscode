import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface OutputDependencyFiles { files: readonly string[]; complete: boolean; reason?: string; }

const SECRET_PATH = /(?:^|[\\/])secrets(?:[\\/]|$)|(?:^|[\\/])\.env(?:\.|$)|\.(?:pfx|pem|key)$/i;
const LOADABLE_FILE = /(?:\.(?:dll|exe|config)|\.deps\.json|\.runtimeconfig\.json)$/i;
const ASSEMBLY_FILE = /\.(?:dll|exe)$/i;
// A .NET culture name (de, pt-BR, zh-Hans, sr-Latn-RS). A folder of another name never holds a satellite assembly.
const CULTURE_FOLDER = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i;
const MAX_FILES = 256;
const MAX_ENTRIES = 512;
const MAX_RUNTIMES_DEPTH = 4; // runtimes/<rid>/lib/<tfm>/<file>

/**
 * Capture actual private dependencies beside the selected output without loading a control or following links.
 *
 * Only what the two engines' loaders can load from an output is read, so a log folder or a publish copy next to the
 * build cannot exhaust the budget (an incomplete scan gives the graph an opaque identity, and then no engine is ever
 * reused):
 * - the output folder's own files (.NET's deps.json assets, .NET Framework's application base);
 * - the runtimes/<rid>/{native,lib/<tfm>} tree (.NET's RID-specific assets);
 * - .NET Framework's default probing, <name>/<name>.dll or .exe;
 * - the satellites of every assembly found: <culture>/<name>.resources.dll (both runtimes) and
 *   <culture>/<name>.resources/<name>.resources.dll (.NET Framework);
 * - what the config the net48 engine gives the output adds (.NET Framework): the folders <probing privatePath="…">
 *   names, by the same rules, and the files <codeBase href="…"> names.
 */
export function selectedOutputDependencyFiles(assemblyPath: string | undefined): OutputDependencyFiles {
  if (!assemblyPath) return { files: [], complete: true };
  if (SECRET_PATH.test(assemblyPath)) {
    return { files: [], complete: false, reason: 'OUTPUT_DEPENDENCY_SECRET_PATH' };
  }
  const assembly = path.resolve(assemblyPath);
  const directory = path.dirname(assembly);
  const files: string[] = [];
  const kept = new Set<string>();
  let entriesSeen = 0;
  const deadline = Date.now() + 100;
  const checkTime = (): void => { if (Date.now() > deadline) throw new Error('OUTPUT_DEPENDENCY_SCAN_BUDGET'); };
  const keep = (file: string): void => {
    const key = file.toLowerCase();
    if (kept.has(key)) return;
    kept.add(key); files.push(file);
    if (files.length > MAX_FILES) throw new Error('OUTPUT_DEPENDENCY_FILE_BUDGET');
  };
  /** The entries of a real (not linked) folder. A `counted` folder spends the entry budget; a culture folder is only
   * matched by name, so a large log folder with a culture-like name ("Log") cannot exhaust it. */
  const entriesOf = (folder: string, counted: boolean): fs.Dirent[] => {
    checkTime();
    const stat = fs.lstatSync(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('OUTPUT_DEPENDENCY_LINK');
    const entries = fs.readdirSync(folder, { withFileTypes: true });
    for (const entry of entries) {
      if (counted && ++entriesSeen > MAX_ENTRIES) throw new Error('OUTPUT_DEPENDENCY_SCAN_BUDGET');
      if (entry.name.toLowerCase() === 'secrets') throw new Error('OUTPUT_DEPENDENCY_SECRET_PATH');
      if (entry.isSymbolicLink()) throw new Error('OUTPUT_DEPENDENCY_LINK');
    }
    checkTime();
    return entries;
  };
  /** The file a loader would take at exactly this path, when one is there. */
  const probe = (file: string): void => {
    checkTime();
    let stat: fs.Stats;
    try { stat = fs.lstatSync(file); } catch { return; }
    if (stat.isSymbolicLink()) throw new Error('OUTPUT_DEPENDENCY_LINK');
    if (stat.isFile()) keep(file);
  };
  const walkRuntimes = (folder: string, depth: number): void => {
    if (depth > MAX_RUNTIMES_DEPTH) throw new Error('OUTPUT_DEPENDENCY_SCAN_BUDGET');
    for (const entry of entriesOf(folder, true)) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walkRuntimes(file, depth + 1);
      else if (entry.isFile() && LOADABLE_FILE.test(entry.name)) keep(file);
    }
  };
  try {
    for (let candidate = directory; ; candidate = path.dirname(candidate)) {
      checkTime();
      if (fs.lstatSync(candidate).isSymbolicLink()) throw new Error('OUTPUT_DEPENDENCY_LINK');
      if (candidate === path.dirname(candidate)) break;
    }
    // A probing base is the output or one of its privatePath folders. Every base's own files come first, because a
    // satellite of any assembly found in any base may sit in any base's culture folder.
    const config = domainConfig(directory, assembly);
    const bases = [{ folder: directory, subfolders: [] as string[], runtimes: true }];
    for (const folder of config.privatePaths) {
      if (!fs.existsSync(folder)) continue; // a named folder that is not there loads nothing
      for (let segment = folder; segment.length > directory.length; segment = path.dirname(segment)) {
        checkTime();
        if (fs.lstatSync(segment).isSymbolicLink()) throw new Error('OUTPUT_DEPENDENCY_LINK');
      }
      if (!fs.lstatSync(folder).isDirectory()) continue;
      if (!bases.some((base) => base.folder.toLowerCase() === folder.toLowerCase())) bases.push({ folder, subfolders: [], runtimes: false });
    }
    // Names of the assemblies found anywhere, whose satellites any culture folder may hold. An identity the config
    // binds (a code base may give it a file of another name) owns them too.
    const assemblies = new Set<string>(config.identities);
    const own = (file: string): void => {
      const name = path.basename(file);
      if (ASSEMBLY_FILE.test(name)) assemblies.add(name.replace(ASSEMBLY_FILE, '').toLowerCase());
    };
    const probeAssembly = (file: string): void => {
      const before = files.length;
      probe(file);
      if (files.length > before) own(file);
    };
    for (const base of bases) {
      for (const entry of entriesOf(base.folder, true)) {
        if (entry.isDirectory()) { base.subfolders.push(entry.name); continue; }
        if (!entry.isFile() || !LOADABLE_FILE.test(entry.name)) continue;
        keep(path.join(base.folder, entry.name));
        own(entry.name);
      }
    }
    // A <codeBase href> names one assembly's file directly.
    for (const file of config.codeBases) probeAssembly(file);
    // .NET Framework's <name>/<name>.dll and the RID tree, before any culture folder is read.
    for (const base of bases) {
      for (const name of base.subfolders) {
        const folder = path.join(base.folder, name);
        if (base.runtimes && name.toLowerCase() === 'runtimes') { walkRuntimes(folder, 1); continue; }
        probeAssembly(path.join(folder, name + '.dll'));
        probeAssembly(path.join(folder, name + '.exe'));
      }
    }
    // Satellites: <culture>/<name>.resources.dll, and .NET Framework's <culture>/<name>.resources/<name>.resources.dll.
    for (const base of bases) {
      for (const name of base.subfolders) {
        if (!CULTURE_FOLDER.test(name) || (base.runtimes && name.toLowerCase() === 'runtimes')) continue;
        const folder = path.join(base.folder, name);
        for (const entry of entriesOf(folder, false)) {
          const satellite = /^(.+)\.resources(\.dll)?$/i.exec(entry.name);
          if (!satellite || !assemblies.has(satellite[1].toLowerCase())) continue;
          if (entry.isFile() && satellite[2]) keep(path.join(folder, entry.name));
          else if (entry.isDirectory() && !satellite[2]) probe(path.join(folder, entry.name, entry.name + '.dll'));
        }
      }
    }
    keep(assembly);
    return { files: files.sort((a, b) => a.localeCompare(b)), complete: true };
  } catch (error) {
    return { files: files.sort((a, b) => a.localeCompare(b)), complete: false,
      reason: error instanceof Error && /^OUTPUT_DEPENDENCY_/.test(error.message) ? error.message : 'OUTPUT_DEPENDENCY_UNAVAILABLE' };
  }
}

interface DomainConfig { privatePaths: string[]; codeBases: string[]; identities: string[]; }

/**
 * What the config the net48 engine gives the output's domain adds to .NET Framework's probing: the folders of
 * <probing privatePath="a;b\c"/>, the files of <codeBase href="…"/> and the assembly names of <assemblyIdentity>. The
 * config is the assembly's own .config, else the one *.exe.config of the folder (the engine's ChildDomainConfig makes
 * the same choice). A privatePath that is not below the application base is ignored by .NET Framework, so it names
 * nothing to read here either; a code base that is not a file, or a config this scan cannot decode, cannot be vouched
 * for, so the graph is then incomplete.
 */
function domainConfig(directory: string, assembly: string): DomainConfig {
  const result: DomainConfig = { privatePaths: [], codeBases: [], identities: [] };
  let config = assembly + '.config';
  if (!fs.existsSync(config)) {
    const hosts = fs.readdirSync(directory).filter((name) => /\.exe\.config$/i.test(name));
    if (hosts.length !== 1) return result;
    config = path.join(directory, hosts[0]);
  }
  const stat = fs.lstatSync(config);
  if (stat.isSymbolicLink()) throw new Error('OUTPUT_DEPENDENCY_LINK');
  if (!stat.isFile()) return result;
  if (stat.size > 4 * 1024 * 1024) throw new Error('OUTPUT_DEPENDENCY_SCAN_BUDGET');
  const text = decodeXmlDocument(fs.readFileSync(config)).replace(/<!--[\s\S]*?-->/g, '');
  for (const value of attributeValues(text, 'assemblyIdentity', 'name')) {
    if (value.trim()) result.identities.push(value.trim().toLowerCase());
  }
  for (const value of attributeValues(text, 'probing', 'privatePath')) {
    for (const part of value.split(';')) {
      const relative = part.trim();
      if (!relative || path.isAbsolute(relative)) continue;
      const folder = path.resolve(directory, relative);
      const inside = path.relative(directory, folder);
      if (!inside || inside === '..' || inside.startsWith('..' + path.sep) || path.isAbsolute(inside)) continue;
      result.privatePaths.push(folder);
    }
  }
  for (const value of attributeValues(text, 'codeBase', 'href')) {
    const href = value.trim();
    if (!href) continue;
    const files: string[] = [];
    if (/^file:/i.test(href)) {
      try { files.push(fileURLToPath(new URL(href))); } catch { throw new Error('OUTPUT_DEPENDENCY_CODEBASE'); }
    } else if (/^[a-z][a-z0-9+.-]+:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) {
      throw new Error('OUTPUT_DEPENDENCY_CODEBASE'); // http:, https:, … — not a file this scan can read
    } else {
      // A relative code base may reach the loader escaped or as written (a file may be named "A%20B.dll"): both.
      files.push(path.resolve(directory, href));
      try { files.push(path.resolve(directory, decodeURI(href))); } catch { /* a lone % has one reading */ }
    }
    for (const file of files) {
      if (SECRET_PATH.test(file)) throw new Error('OUTPUT_DEPENDENCY_SECRET_PATH');
      result.codeBases.push(file);
    }
  }
  return result;
}

/** The text of an XML file as an XML reader decodes it: by its byte order mark, else by the encoding its declaration
 * names, else UTF-8. An encoding this scan cannot decode makes the graph incomplete. */
function decodeXmlDocument(bytes: Buffer): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString('utf8');
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  // Without a mark, UTF-16 still shows in the first character's zero byte; other encodings keep ASCII readable.
  if (bytes.length >= 2 && bytes[0] === 0x3c && bytes[1] === 0x00) return bytes.toString('utf16le');
  if (bytes.length >= 2 && bytes[0] === 0x00 && bytes[1] === 0x3c) {
    const swapped = Buffer.from(bytes.subarray(0, bytes.length - (bytes.length % 2)));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  // The whole declaration, however much whitespace it holds: one byte per character keeps its ASCII exact.
  const declaration = /^\s*<\?xml\b([\s\S]*?)\?>/.exec(bytes.toString('latin1'))?.[1] ?? '';
  const declared = /\bencoding\s*=\s*["']([^"']+)["']/i.exec(declaration)?.[1];
  if (!declared || /^utf-?8$/i.test(declared)) return bytes.toString('utf8');
  try { return new TextDecoder(declared, { fatal: true }).decode(bytes); }
  catch { throw new Error('OUTPUT_DEPENDENCY_CONFIG_ENCODING'); }
}

/** The values of `attribute` on every `element` (any namespace prefix), decoded as XML attribute text. */
function attributeValues(text: string, element: string, attribute: string): string[] {
  const values: string[] = [];
  const tag = new RegExp(`<(?:[\\w.-]+:)?${element}\\b([^>]*)>`, 'gi');
  const attr = new RegExp(`(?:^|\\s)${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  for (const match of text.matchAll(tag)) {
    const found = attr.exec(match[1]);
    if (found) values.push(decodeXmlText(found[1] ?? found[2] ?? ''));
  }
  return values;
}

function decodeXmlText(value: string): string {
  return value.replace(/&(?:#x([0-9a-f]+)|#([0-9]+)|(amp|lt|gt|quot|apos));/gi, (whole, hex: string, dec: string, name: string) => {
    if (hex || dec) {
      const code = parseInt(hex ?? dec, hex ? 16 : 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[name.toLowerCase()] ?? whole;
  });
}
