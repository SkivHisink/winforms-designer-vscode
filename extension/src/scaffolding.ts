/**
 * Pure, fail-closed helpers for Explorer "Add" scaffolding (GitHub issue #4).
 *
 * The VS Code glue lives in extension.ts.  Keeping project discovery, namespace
 * derivation, templates, collision checks, and project-file insertion here makes
 * the part that can create several related files testable without an Extension
 * Host.  A caller must create every returned file and apply projectInsertion in
 * one WorkspaceEdit so refusal/failure never leaves a partial form behind.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type ScaffoldKind = 'form' | 'userControl' | 'component' | 'class';

/** Where `using` directives are written, following .editorconfig `csharp_using_directive_placement`. */
export type UsingPlacement = 'inside' | 'outside';

export type ScaffoldErrorCode =
  | 'invalidName'
  | 'outsideWorkspace'
  | 'noProject'
  | 'ambiguousProject'
  | 'sharedProjectUnsupported'
  | 'outsideProject'
  | 'malformedProject'
  | 'dynamicProjectProperty'
  | 'notWinFormsProject'
  | 'unsupportedProjectItems'
  | 'fileCollision';

export class ScaffoldError extends Error {
  constructor(public readonly code: ScaffoldErrorCode, public readonly detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ScaffoldError';
  }
}

export interface ScaffoldFile {
  /** File name relative to targetDir (scaffolding never creates a hidden nested directory). */
  name: string;
  content: string;
}

export interface ScaffoldProjectInsertion {
  /** UTF-16 string offset in the original project text, suitable for TextDocument.positionAt. */
  offset: number;
  text: string;
}

export interface ScaffoldPlan {
  kind: ScaffoldKind;
  typeName: string;
  namespace: string;
  targetDir: string;
  projectPath: string;
  files: ScaffoldFile[];
  mainFileName: string;
  openInDesigner: boolean;
  projectInsertion?: ScaffoldProjectInsertion;
}

export interface CreateScaffoldPlanOptions {
  kind: ScaffoldKind;
  typeName: string;
  targetDir: string;
  projectPath: string;
  projectText: string;
  /** Directory entry names captured immediately before planning, compared case-insensitively. */
  existingEntries: readonly string[];
  /** Resolved from .editorconfig by the caller; Visual Studio's own default is outside the namespace. */
  usingPlacement?: UsingPlacement;
}

const reservedWords = new Set([
  'abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char', 'checked', 'class',
  'const', 'continue', 'decimal', 'default', 'delegate', 'do', 'double', 'else', 'enum', 'event',
  'explicit', 'extern', 'false', 'finally', 'fixed', 'float', 'for', 'foreach', 'goto', 'if',
  'implicit', 'in', 'int', 'interface', 'internal', 'is', 'lock', 'long', 'namespace', 'new',
  'null', 'object', 'operator', 'out', 'override', 'params', 'private', 'protected', 'public',
  'readonly', 'ref', 'return', 'sbyte', 'sealed', 'short', 'sizeof', 'stackalloc', 'static',
  'string', 'struct', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'uint', 'ulong',
  'unchecked', 'unsafe', 'ushort', 'using', 'virtual', 'void', 'volatile', 'while',
  // Contextual keywords that are especially surprising as generated type names.
  'add', 'alias', 'and', 'ascending', 'async', 'await', 'by', 'descending', 'dynamic', 'equals',
  'file', 'from', 'get', 'global', 'group', 'init', 'into', 'join', 'let', 'managed', 'nameof',
  'not', 'notnull', 'on', 'or', 'orderby', 'partial', 'record', 'remove', 'required', 'scoped',
  'select', 'set', 'unmanaged', 'value', 'var', 'when', 'where', 'with', 'yield',
]);

const identifier = /^[\p{L}_][\p{L}\p{Nd}\p{Pc}\p{Mn}\p{Mc}\p{Cf}]*$/u;

/** Normalize an input-box value to a safe C# type/file basename. An optional final .cs is accepted. */
export function normalizeScaffoldTypeName(input: string): string {
  let value = input.trim();
  if (/\.cs$/i.test(value)) value = value.slice(0, -3).trim();
  if (!value || !identifier.test(value) || reservedWords.has(value)) {
    throw new ScaffoldError('invalidName', input);
  }
  return value;
}

function plannedFileNames(kind: ScaffoldKind, typeName: string): string[] {
  if (kind === 'form' || kind === 'userControl') {
    return [`${typeName}.cs`, `${typeName}.Designer.cs`, `${typeName}.resx`];
  }
  return [`${typeName}.cs`];
}

/** Visual-Studio-style first free default name, considering every companion file case-insensitively. */
export function suggestScaffoldTypeName(kind: ScaffoldKind, existingEntries: readonly string[]): string {
  const stem = kind === 'form' ? 'Form'
    : kind === 'userControl' ? 'UserControl'
      : kind === 'component' ? 'Component' : 'Class';
  const present = new Set(existingEntries.map((entry) => entry.toLocaleLowerCase('en-US')));
  for (let n = 1; n < 100_000; n++) {
    const candidate = `${stem}${n}`;
    if (plannedFileNames(kind, candidate).every((name) => !present.has(name.toLocaleLowerCase('en-US')))) {
      return candidate;
    }
  }
  throw new ScaffoldError('fileCollision', stem);
}

function sameOrInside(candidate: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

function realPathOrResolved(value: string): string {
  try { return fs.realpathSync.native(value); }
  catch { return path.resolve(value); }
}

/**
 * Resolve exactly one project by walking from targetDir up to workspaceRoot.
 * A directly selected .csproj is an explicit disambiguation. Shared projects are
 * refused because their compile items live in .projitems, not in an importing csproj.
 */
export function resolveScaffoldProject(
  targetDir: string,
  workspaceRoot: string,
  explicitlySelectedProject?: string,
): string {
  const target = path.resolve(targetDir);
  const root = path.resolve(workspaceRoot);
  if (!sameOrInside(target, root)
    || !sameOrInside(realPathOrResolved(target), realPathOrResolved(root))) {
    throw new ScaffoldError('outsideWorkspace', target);
  }

  if (explicitlySelectedProject) {
    const selected = path.resolve(explicitlySelectedProject);
    if (!sameOrInside(selected, root)
      || !sameOrInside(realPathOrResolved(selected), realPathOrResolved(root))
      || !/\.csproj$/i.test(selected)
      || !fs.existsSync(selected)) {
      throw new ScaffoldError('noProject', selected);
    }
    return selected;
  }

  let dir = target;
  for (let depth = 0; depth < 40; depth++) {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { throw new ScaffoldError('noProject', dir); }
    const projects = entries.filter((entry) => /\.csproj$/i.test(entry)).sort((a, b) => a.localeCompare(b));
    if (projects.length > 1) throw new ScaffoldError('ambiguousProject', dir);
    if (projects.length === 1) return path.join(dir, projects[0]);
    if (entries.some((entry) => /\.projitems$/i.test(entry))) {
      throw new ScaffoldError('sharedProjectUnsupported', dir);
    }
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir || !sameOrInside(parent, root)) break;
    dir = parent;
  }
  throw new ScaffoldError('noProject', target);
}

/** Translate one .editorconfig section glob into a regular expression over a forward-slash relative path. */
function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') { source += '.*'; i++; }
      else source += '[^/]*';
    } else if (char === '?') source += '[^/]';
    else if (char === '{') source += '(?:';
    else if (char === '}') source += ')';
    else if (char === ',') source += '|';
    else source += char.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/**
 * Read `csharp_using_directive_placement` for a .cs file in targetDir, nearest .editorconfig first, stopping at a
 * `root = true` file or at stopDir. Anything unreadable or unrecognized falls back to Visual Studio's own default.
 */
export function detectUsingPlacement(targetDir: string, stopDir?: string): UsingPlacement {
  const stop = stopDir ? path.resolve(stopDir) : undefined;
  let dir = path.resolve(targetDir);
  for (let depth = 0; depth < 40; depth++) {
    let text: string | undefined;
    try { text = fs.readFileSync(path.join(dir, '.editorconfig'), 'utf8'); } catch { text = undefined; }
    if (text != null) {
      const relative = path.relative(dir, path.join(path.resolve(targetDir), 'File.cs')).replace(/\\/g, '/');
      let section: string | undefined;
      let isRoot = false;
      let found: UsingPlacement | undefined;
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/^﻿/, '').trim();
        if (!line || line.startsWith('#') || line.startsWith(';')) continue;
        const header = /^\[(.*)\]$/.exec(line);
        if (header) { section = header[1]; continue; }
        const pair = /^([^=]+?)\s*[=:]\s*(.*)$/.exec(line);
        if (!pair) continue;
        const key = pair[1].trim().toLocaleLowerCase('en-US');
        const value = pair[2].trim().split(':')[0].trim().toLocaleLowerCase('en-US');
        if (section === undefined) { if (key === 'root' && value === 'true') isRoot = true; continue; }
        if (key !== 'csharp_using_directive_placement') continue;
        // A section without a slash applies to the file name at any depth; one with a slash is anchored at the
        // .editorconfig's own directory.
        const glob = section.startsWith('/') ? section.slice(1) : section;
        const subject = glob.includes('/') ? relative : relative.slice(relative.lastIndexOf('/') + 1);
        let matches: boolean;
        try { matches = globToRegExp(glob).test(subject); }
        catch { matches = false; }
        if (!matches) continue;
        if (value.startsWith('inside_namespace')) found = 'inside';
        else if (value.startsWith('outside_namespace')) found = 'outside';
      }
      if (found) return found;
      if (isRoot) break;
    }
    if (stop && dir === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'outside';
}

function stripXmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

function dominantEol(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const bareLf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf >= bareLf && crlf > 0 ? '\r\n' : '\n';
}

function rootProjectCloseOffset(text: string): number {
  for (let from = text.length; ;) {
    const at = text.lastIndexOf('</Project>', from);
    if (at < 0) return -1;
    const open = text.lastIndexOf('<!--', at);
    const close = open >= 0 ? text.indexOf('-->', open) : -1;
    if (open < 0 || (close >= 0 && close < at)) return at;
    from = at - 1;
  }
}

function decodeXmlAttribute(value: string): string {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function simpleProperty(text: string, name: string): string | undefined {
  const live = stripXmlComments(text);
  const re = new RegExp(`<${name}([^>]*)>([\\s\\S]*?)<\\/${name}>`, 'gi');
  const values: string[] = [];
  for (let match = re.exec(live); match !== null; match = re.exec(live)) {
    const groupOpen = live.lastIndexOf('<PropertyGroup', match.index);
    const groupClose = live.lastIndexOf('</PropertyGroup>', match.index);
    if (groupOpen > groupClose) {
      const groupEnd = live.indexOf('>', groupOpen);
      if (groupEnd < 0 || /\bCondition\s*=/i.test(live.slice(groupOpen, groupEnd + 1))) {
        throw new ScaffoldError('dynamicProjectProperty', name);
      }
    }
    if (match[1].trim() || /[<>]/.test(match[2])) {
      throw new ScaffoldError('dynamicProjectProperty', name);
    }
    const value = decodeXmlAttribute(match[2].trim());
    if (/\$\(|@\(|%\(/.test(value)) throw new ScaffoldError('dynamicProjectProperty', name);
    values.push(value);
  }
  if (values.length === 0) return undefined;
  if (values.some((value) => value !== values[0])) throw new ScaffoldError('dynamicProjectProperty', name);
  return values[0];
}

function booleanProperty(text: string, name: string, fallback: boolean): boolean {
  const value = simpleProperty(text, name);
  if (value == null) return fallback;
  if (/^true$/i.test(value)) return true;
  if (/^false$/i.test(value)) return false;
  throw new ScaffoldError('dynamicProjectProperty', name);
}

function sanitizeNamespaceSegment(value: string): string {
  let result = '';
  for (const char of value.normalize('NFC')) {
    if (/^[\p{L}\p{Nd}\p{Pc}\p{Mn}\p{Mc}\p{Cf}_]$/u.test(char)) result += char;
    else result += '_';
  }
  if (!result || !/^[\p{L}_]/u.test(result)) result = '_' + result;
  if (reservedWords.has(result)) result = '_' + result;
  return result;
}

function projectNamespace(projectText: string, projectPath: string, targetDir: string): string {
  const projectDir = path.dirname(projectPath);
  const relative = path.relative(projectDir, targetDir);
  if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
    throw new ScaffoldError('outsideProject', targetDir);
  }

  const explicit = simpleProperty(projectText, 'RootNamespace');
  const projectStem = path.basename(projectPath).replace(/\.csproj$/i, '');
  const rootParts = explicit == null || explicit === ''
    ? projectStem.split('.').map(sanitizeNamespaceSegment)
    : explicit.split('.');
  if (rootParts.some((part) => !identifier.test(part) || reservedWords.has(part))) {
    throw new ScaffoldError('dynamicProjectProperty', 'RootNamespace');
  }
  const folderParts = relative === '' ? [] : relative.split(path.sep).filter(Boolean).map(sanitizeNamespaceSegment);
  return [...rootParts, ...folderParts].join('.');
}

function indentNamespace(
  namespace: string,
  bodyLines: readonly string[],
  eol: string,
  usings: readonly string[] = [],
  placement: UsingPlacement = 'outside',
): string {
  const directives = usings.map((name) => `using ${name};`);
  if (!namespace) return [...directives, ...(directives.length ? [''] : []), ...bodyLines].join(eol) + eol;
  const inside = placement === 'inside' && directives.length > 0;
  return [
    ...(directives.length && !inside ? [...directives, ''] : []),
    `namespace ${namespace}`,
    '{',
    ...(inside ? [...directives, ''].map((line) => line ? '    ' + line : '') : []),
    ...bodyLines.map((line) => line ? '    ' + line : ''),
    '}',
    '',
  ].join(eol);
}

/**
 * The using block Visual Studio's Windows Form / User Control item templates write. Skipped entirely when the
 * project enables implicit usings, exactly as the modern template does.
 */
const visualStudioFormUsings = [
  'System',
  'System.Collections.Generic',
  'System.ComponentModel',
  'System.Data',
  'System.Drawing',
  'System.Linq',
  'System.Text',
  'System.Threading.Tasks',
  'System.Windows.Forms',
];

function codeBehind(
  kind: 'form' | 'userControl',
  typeName: string,
  namespace: string,
  eol: string,
  usings: readonly string[],
  placement: UsingPlacement,
): string {
  // The short base name matches Visual Studio; it binds through the using block above (or the project's implicit
  // usings, which UseWindowsForms always includes). The engine resolves unqualified names the same way.
  const base = kind === 'form' ? 'Form' : 'UserControl';
  return indentNamespace(namespace, [
    `public partial class ${typeName} : ${base}`,
    '{',
    `    public ${typeName}()`,
    '    {',
    '        InitializeComponent();',
    '    }',
    '}',
  ], eol, usings, placement);
}

/**
 * Byte-for-byte the Visual Studio designer template: the documented members, the generated-code region, and only
 * the property assignments the template itself writes. Notably absent, because Visual Studio does not write them
 * either and the designer adds them on the first real edit: SuspendLayout/ResumeLayout, `Name`, and
 * `AutoScaleDimensions` — the last of which must never be a constant, since the correct pair depends on the
 * target's default font (7,15 on modern .NET, 6,13 on .NET Framework) and a wrong one rescales the whole form.
 */
function designerCode(kind: 'form' | 'userControl', typeName: string, namespace: string, eol: string): string {
  const region = kind === 'form' ? 'Windows Form Designer generated code' : 'Component Designer generated code';
  const assignments = kind === 'form'
    ? [
      '        this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;',
      '        this.ClientSize = new System.Drawing.Size(800, 450);',
      `        this.Text = "${typeName}";`,
    ]
    : ['        this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;'];
  return indentNamespace(namespace, [
    `partial class ${typeName}`,
    '{',
    '    /// <summary>',
    '    /// Required designer variable.',
    '    /// </summary>',
    '    private System.ComponentModel.IContainer components = null;',
    '',
    '    /// <summary>',
    '    /// Clean up any resources being used.',
    '    /// </summary>',
    '    /// <param name="disposing">true if managed resources should be disposed; otherwise, false.</param>',
    '    protected override void Dispose(bool disposing)',
    '    {',
    '        if (disposing && (components != null))',
    '        {',
    '            components.Dispose();',
    '        }',
    '        base.Dispose(disposing);',
    '    }',
    '',
    `    #region ${region}`,
    '',
    '    /// <summary>',
    '    /// Required method for Designer support - do not modify',
    '    /// the contents of this method with the code editor.',
    '    /// </summary>',
    '    private void InitializeComponent()',
    '    {',
    '        this.components = new System.ComponentModel.Container();',
    ...assignments,
    '    }',
    '',
    '    #endregion',
    '}',
  ], eol);
}

function componentCode(typeName: string, namespace: string, eol: string): string {
  // One complete code component is intentional: this extension supports visual
  // Form/UserControl roots, not Visual Studio's non-visual ComponentDesigner surface.
  return indentNamespace(namespace, [
    `public class ${typeName} : System.ComponentModel.Component`,
    '{',
    `    public ${typeName}()`,
    '    {',
    '    }',
    '',
    `    public ${typeName}(System.ComponentModel.IContainer container)`,
    '    {',
    '        container.Add(this);',
    '    }',
    '}',
  ], eol);
}

function classCode(typeName: string, namespace: string, eol: string): string {
  return indentNamespace(namespace, [
    `public class ${typeName}`,
    '{',
    '}',
  ], eol);
}

function emptyResx(eol: string): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<root>',
    '  <resheader name="resmimetype">',
    '    <value>text/microsoft-resx</value>',
    '  </resheader>',
    '  <resheader name="version">',
    '    <value>2.0</value>',
    '  </resheader>',
    '  <resheader name="reader">',
    '    <value>System.Resources.ResXResourceReader, System.Windows.Forms</value>',
    '  </resheader>',
    '  <resheader name="writer">',
    '    <value>System.Resources.ResXResourceWriter, System.Windows.Forms</value>',
    '  </resheader>',
    '</root>',
    '',
  ].join(eol);
}

interface RequiredProjectItem {
  element: 'Compile' | 'EmbeddedResource';
  include: string;
  metadata?: readonly string[];
}

function attribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(attributes);
  return match ? decodeXmlAttribute(match[2].trim()) : undefined;
}

function normalizedItemPath(value: string): string {
  return value.replace(/\//g, '\\').replace(/^\.\\/, '').toLocaleLowerCase('en-US');
}

function xmlEscapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function projectInsertion(
  projectText: string,
  closeOffset: number,
  required: readonly RequiredProjectItem[],
  compileImplicit: boolean,
  resourcesImplicit: boolean,
  eol: string,
): ScaffoldProjectInsertion | undefined {
  const live = stripXmlComments(projectText);
  const itemTags = /<(Compile|EmbeddedResource)\b([^>]*)>/gi;
  const seen = new Map<string, number>();
  const wildcardOrDynamic = new Set<'Compile' | 'EmbeddedResource'>();
  const removed = new Set<string>();
  for (let match = itemTags.exec(live); match !== null; match = itemTags.exec(live)) {
    const element = match[1] as 'Compile' | 'EmbeddedResource';
    const include = attribute(match[2], 'Include');
    const remove = attribute(match[2], 'Remove');
    if (include != null) {
      if (/[*?]|\$\(|@\(|%\(/.test(include)) wildcardOrDynamic.add(element);
      else {
        const key = `${element}:${normalizedItemPath(include)}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
    }
    if (remove != null) {
      if (/[*?]|\$\(|@\(|%\(/.test(remove)) wildcardOrDynamic.add(element);
      else removed.add(`${element}:${normalizedItemPath(remove)}`);
    }
  }

  const additions: RequiredProjectItem[] = [];
  for (const item of required) {
    if (/[*?]|\$\(|@\(|%\(/.test(item.include)) {
      throw new ScaffoldError('unsupportedProjectItems', item.include);
    }
    const implicit = item.element === 'Compile' ? compileImplicit : resourcesImplicit;
    const key = `${item.element}:${normalizedItemPath(item.include)}`;
    if ((seen.get(key) ?? 0) > 1 || removed.has(key)) {
      throw new ScaffoldError('unsupportedProjectItems', item.include);
    }
    if (implicit) {
      if (wildcardOrDynamic.has(item.element)) throw new ScaffoldError('unsupportedProjectItems', item.element);
      continue;
    }
    if (seen.has(key)) continue; // an existing explicit item pointed at the previously missing file
    if (wildcardOrDynamic.has(item.element)) throw new ScaffoldError('unsupportedProjectItems', item.element);
    additions.push(item);
  }
  if (additions.length === 0) return undefined;

  const lines = ['  <ItemGroup>'];
  for (const item of additions) {
    if (!item.metadata?.length) {
      lines.push(`    <${item.element} Include="${xmlEscapeAttribute(item.include)}" />`);
      continue;
    }
    lines.push(`    <${item.element} Include="${xmlEscapeAttribute(item.include)}">`);
    lines.push(...item.metadata.map((line) => `      ${line}`));
    lines.push(`    </${item.element}>`);
  }
  lines.push('  </ItemGroup>');
  const snippet = lines.join(eol);

  const lineStart = Math.max(projectText.lastIndexOf('\n', closeOffset - 1) + 1, 0);
  const beforeCloseOnLine = projectText.slice(lineStart, closeOffset);
  if (/^[ \t]*$/.test(beforeCloseOnLine)) {
    return { offset: lineStart, text: snippet + eol };
  }
  return { offset: closeOffset, text: eol + snippet + eol };
}

/** Build a complete, collision-checked scaffold plan without writing anything. */
export function createScaffoldPlan(options: CreateScaffoldPlanOptions): ScaffoldPlan {
  const typeName = normalizeScaffoldTypeName(options.typeName);
  const targetDir = path.resolve(options.targetDir);
  const projectPath = path.resolve(options.projectPath);
  const projectDir = path.dirname(projectPath);
  if (!sameOrInside(targetDir, projectDir)
    || !sameOrInside(realPathOrResolved(targetDir), realPathOrResolved(projectDir))) {
    throw new ScaffoldError('outsideProject', targetDir);
  }

  const live = stripXmlComments(options.projectText);
  const openCount = (live.match(/<Project(?:\s|>)/gi) ?? []).length;
  const closeCount = (live.match(/<\/Project>/gi) ?? []).length;
  const closeOffset = rootProjectCloseOffset(options.projectText);
  if (openCount !== 1 || closeCount !== 1 || closeOffset < 0) {
    throw new ScaffoldError('malformedProject', projectPath);
  }
  const projectTag = /<Project\b([^>]*)>/i.exec(live);
  const projectSdk = projectTag ? attribute(projectTag[1], 'Sdk') : undefined;
  const nestedSdkTag = /<Sdk\b([^>]*)>/i.exec(live);
  const nestedSdk = nestedSdkTag ? attribute(nestedSdkTag[1], 'Name') : undefined;
  if ((projectSdk && /\$\(|@\(|%\(/.test(projectSdk))
    || (nestedSdk && /\$\(|@\(|%\(/.test(nestedSdk))) {
    throw new ScaffoldError('dynamicProjectProperty', 'Sdk');
  }

  const fileNames = plannedFileNames(options.kind, typeName);
  const present = new Set(options.existingEntries.map((entry) => entry.toLocaleLowerCase('en-US')));
  const collision = fileNames.find((name) => present.has(name.toLocaleLowerCase('en-US')));
  if (collision) throw new ScaffoldError('fileCollision', collision);

  if (options.kind === 'form' || options.kind === 'userControl') {
    const legacyReference = /<Reference\b[^>]*\bInclude\s*=\s*["']System\.Windows\.Forms(?:\s*,|["'])/i.test(live);
    const useWinForms = legacyReference || booleanProperty(options.projectText, 'UseWindowsForms', false);
    if (!useWinForms) throw new ScaffoldError('notWinFormsProject', projectPath);
  }

  const sdkStyle = projectSdk != null || nestedSdk != null;
  const defaultItems = sdkStyle ? booleanProperty(options.projectText, 'EnableDefaultItems', true) : false;
  const compileImplicit = sdkStyle && defaultItems
    && booleanProperty(options.projectText, 'EnableDefaultCompileItems', true);
  const resourcesImplicit = sdkStyle && defaultItems
    && booleanProperty(options.projectText, 'EnableDefaultEmbeddedResourceItems', true);
  const namespace = projectNamespace(options.projectText, projectPath, targetDir);
  const eol = dominantEol(options.projectText);
  // Implicit usings make the template's using block redundant, and Visual Studio's modern template omits it too.
  const implicitUsings = sdkStyle && /^(enable|true)$/i.test(simpleProperty(options.projectText, 'ImplicitUsings') ?? '');
  const usings = implicitUsings ? [] : visualStudioFormUsings;
  const placement = options.usingPlacement ?? 'outside';
  // Visual Studio only seeds a .resx for classic projects; on SDK projects a form starts without one and the
  // engine writes a skeleton the moment a resource (image, localized string) actually needs it.
  const withResx = !sdkStyle;

  const files: ScaffoldFile[] = [];
  if (options.kind === 'form' || options.kind === 'userControl') {
    files.push(
      { name: `${typeName}.cs`, content: codeBehind(options.kind, typeName, namespace, eol, usings, placement) },
      { name: `${typeName}.Designer.cs`, content: designerCode(options.kind, typeName, namespace, eol) },
    );
    if (withResx) files.push({ name: `${typeName}.resx`, content: emptyResx(eol) });
  } else if (options.kind === 'component') {
    files.push({ name: `${typeName}.cs`, content: componentCode(typeName, namespace, eol) });
  } else {
    files.push({ name: `${typeName}.cs`, content: classCode(typeName, namespace, eol) });
  }

  const rel = (name: string): string => path.relative(projectDir, path.join(targetDir, name)).replace(/\//g, '\\');
  const required: RequiredProjectItem[] = [];
  if (options.kind === 'form' || options.kind === 'userControl') {
    const main = `${typeName}.cs`;
    required.push(
      {
        element: 'Compile', include: rel(main),
        metadata: [`<SubType>${options.kind === 'form' ? 'Form' : 'UserControl'}</SubType>`],
      },
      {
        element: 'Compile', include: rel(`${typeName}.Designer.cs`),
        metadata: [`<DependentUpon>${main}</DependentUpon>`],
      },
    );
    if (withResx) {
      required.push({
        element: 'EmbeddedResource', include: rel(`${typeName}.resx`),
        metadata: [`<DependentUpon>${main}</DependentUpon>`],
      });
    }
  } else {
    required.push({
      element: 'Compile', include: rel(`${typeName}.cs`),
      metadata: options.kind === 'component' ? ['<SubType>Component</SubType>'] : undefined,
    });
  }

  return {
    kind: options.kind,
    typeName,
    namespace,
    targetDir,
    projectPath,
    files,
    mainFileName: `${typeName}.cs`,
    openInDesigner: options.kind === 'form' || options.kind === 'userControl',
    projectInsertion: projectInsertion(
      options.projectText, closeOffset, required, compileImplicit, resourcesImplicit, eol,
    ),
  };
}
