import * as path from 'node:path';
import { findNearestCsproj, findNearestProjitems } from './csprojRef';

export interface FormProjectMembershipEdit {
  projectPath: string;
  before: string;
  after: string;
}

type ProjectItemKind = 'Compile' | 'EmbeddedResource';

interface RequiredItem {
  kind: ProjectItemKind;
  filePath: string;
  metadata: readonly string[];
}

function sameOrInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function stripXmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

function xmlAttribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(attributes);
  return match?.[2]
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function property(text: string, name: string): string | undefined {
  const match = new RegExp(`<${name}\\b[^>]*>\\s*([^<]*?)\\s*</${name}>`, 'i').exec(stripXmlComments(text));
  return match?.[1].trim();
}

function booleanProperty(text: string, name: string, fallback: boolean): boolean {
  const value = property(text, name);
  return value == null ? fallback : /^(true|1|yes)$/i.test(value);
}

function projectUsesSdk(text: string): boolean {
  const live = stripXmlComments(text);
  return /<Project\b[^>]*\bSdk\s*=\s*["'][^"']+["']/i.test(live)
    || /<Sdk\b[^>]*\bName\s*=\s*["'][^"']+["']/i.test(live);
}

function dominantEol(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf >= lf ? '\r\n' : '\n';
}

function projectCloseOffset(text: string): number {
  const offset = text.toLowerCase().lastIndexOf('</project>');
  if (offset < 0 || (stripXmlComments(text).match(/<Project(?:\s|>)/gi) ?? []).length !== 1) {
    throw new Error('project membership update refused: malformed project XML');
  }
  return offset;
}

function normalizedPath(value: string): string {
  return value.replace(/\//g, '\\').replace(/^\.\\/, '').toLocaleLowerCase('en-US');
}

function includeFor(projectPath: string, filePath: string): string {
  const relative = path.relative(path.dirname(projectPath), filePath).replace(/\//g, '\\');
  if (!relative || relative.startsWith('..\\') || path.isAbsolute(relative)) {
    throw new Error(`form artifact is outside its project: ${filePath}`);
  }
  return /\.projitems$/i.test(projectPath) ? `$(MSBuildThisFileDirectory)${relative}` : relative;
}

function normalizedIncludeForComparison(projectPath: string, include: string): string | null {
  let value = include.trim();
  if (/\.projitems$/i.test(projectPath)) {
    const prefix = /^\$\(MSBuildThisFileDirectory\)/i.exec(value);
    if (prefix) value = value.slice(prefix[0].length);
  }
  if (/[*?]|\$\(|@\(|%\(/.test(value)) return null;
  return normalizedPath(value);
}

function requiredItems(mainFile: string, allFiles: readonly string[]): RequiredItem[] {
  const mainName = path.basename(mainFile);
  const items: RequiredItem[] = [];
  for (const filePath of allFiles) {
    const name = path.basename(filePath);
    if (/\.Designer\.cs$/i.test(name)) {
      items.push({ kind: 'Compile', filePath, metadata: [`<DependentUpon>${mainName}</DependentUpon>`] });
    } else if (/\.cs$/i.test(name)) {
      items.push({ kind: 'Compile', filePath, metadata: ['<SubType>Form</SubType>'] });
    } else if (/\.resx$/i.test(name)) {
      items.push({ kind: 'EmbeddedResource', filePath, metadata: [`<DependentUpon>${mainName}</DependentUpon>`] });
    }
  }
  return items;
}

/** Pick the item file Visual Studio would edit: a nearest shared .projitems, otherwise the nearest csproj. */
export function resolveFormMembershipProject(formFile: string, workspaceRoot: string): string | null {
  const directory = path.dirname(path.resolve(formFile));
  const root = path.resolve(workspaceRoot);
  if (!sameOrInside(directory, root)) return null;
  const projitems = findNearestProjitems(directory, root);
  const csproj = findNearestCsproj(directory, root);
  if (!projitems) return csproj;
  if (!csproj) return projitems;
  const sharedDepth = path.relative(root, path.dirname(projitems)).split(path.sep).filter(Boolean).length;
  const projectDepth = path.relative(root, path.dirname(csproj)).split(path.sep).filter(Boolean).length;
  return sharedDepth >= projectDepth ? projitems : csproj;
}

/** Add exact form artifacts to classic/shared projects; SDK default items need no project-file mutation. */
export function planAddFormMembership(
  projectPath: string,
  projectText: string,
  mainFile: string,
  allFiles: readonly string[],
): FormProjectMembershipEdit | null {
  projectCloseOffset(projectText); // validate even when all items are implicit
  const shared = /\.projitems$/i.test(projectPath);
  const sdk = !shared && projectUsesSdk(projectText);
  const defaultItems = sdk && booleanProperty(projectText, 'EnableDefaultItems', true);
  const compileImplicit = defaultItems && booleanProperty(projectText, 'EnableDefaultCompileItems', true);
  const resourceImplicit = defaultItems && booleanProperty(projectText, 'EnableDefaultEmbeddedResourceItems', true);
  const items = requiredItems(mainFile, allFiles);
  const live = stripXmlComments(projectText);
  const seen = new Set<string>();
  const dynamicKinds = new Set<ProjectItemKind>();
  for (const match of live.matchAll(/<(Compile|EmbeddedResource)\b([^>]*)>/gi)) {
    const kind = match[1] as ProjectItemKind;
    const raw = xmlAttribute(match[2], 'Include');
    if (raw == null) continue;
    const normalized = normalizedIncludeForComparison(projectPath, raw);
    if (normalized === null) dynamicKinds.add(kind);
    else seen.add(`${kind}:${normalized}`);
  }

  const additions = items.filter((item) => {
    const implicit = item.kind === 'Compile' ? compileImplicit : resourceImplicit;
    if (implicit) return false;
    const include = includeFor(projectPath, item.filePath);
    const key = `${item.kind}:${normalizedIncludeForComparison(projectPath, include)}`;
    if (seen.has(key)) return false;
    if (dynamicKinds.has(item.kind)) {
      throw new Error(`project membership update refused: dynamic ${item.kind} items are ambiguous`);
    }
    return true;
  });
  if (additions.length === 0) return null;

  const eol = dominantEol(projectText);
  const lines = ['  <ItemGroup>'];
  for (const item of additions) {
    lines.push(`    <${item.kind} Include="${xmlEscape(includeFor(projectPath, item.filePath))}">`);
    lines.push(...item.metadata.map((metadata) => `      ${metadata}`));
    lines.push(`    </${item.kind}>`);
  }
  lines.push('  </ItemGroup>');
  const snippet = lines.join(eol);
  const closeOffset = projectCloseOffset(projectText);
  const lineStart = Math.max(projectText.lastIndexOf('\n', closeOffset - 1) + 1, 0);
  const insertionOffset = /^[ \t]*$/.test(projectText.slice(lineStart, closeOffset)) ? lineStart : closeOffset;
  const insertion = insertionOffset === lineStart ? `${snippet}${eol}` : `${eol}${snippet}${eol}`;
  return {
    projectPath,
    before: projectText,
    after: projectText.slice(0, insertionOffset) + insertion + projectText.slice(insertionOffset),
  };
}

function expandElementRange(text: string, start: number, end: number): { start: number; end: number } {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const nextLf = text.indexOf('\n', end);
  const lineEnd = nextLf < 0 ? text.length : nextLf + 1;
  if (/^[ \t]*$/.test(text.slice(lineStart, start)) && /^[ \t]*(?:\r?\n)?$/.test(text.slice(end, lineEnd))) {
    return { start: lineStart, end: lineEnd };
  }
  return { start, end };
}

/** Remove only exact explicit Compile/EmbeddedResource entries for a form; wildcard/default membership is untouched. */
export function planRemoveFormMembership(
  projectPath: string,
  projectText: string,
  files: readonly string[],
): FormProjectMembershipEdit | null {
  projectCloseOffset(projectText);
  const wanted = new Set(files.map((file) => normalizedPath(path.relative(path.dirname(projectPath), file))));
  const ranges: Array<{ start: number; end: number }> = [];
  const element = /<(Compile|EmbeddedResource)\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/\1\s*>)/gi;
  for (const match of projectText.matchAll(element)) {
    if (match.index == null) continue;
    const include = xmlAttribute(match[2], 'Include');
    if (include == null) continue;
    let comparable = include;
    if (/\.projitems$/i.test(projectPath)) comparable = comparable.replace(/^\$\(MSBuildThisFileDirectory\)/i, '');
    if (/[*?]|\$\(|@\(|%\(/.test(comparable) || !wanted.has(normalizedPath(comparable))) continue;
    ranges.push(expandElementRange(projectText, match.index, match.index + match[0].length));
  }
  if (ranges.length === 0) return null;
  let after = projectText;
  for (const range of ranges.sort((left, right) => right.start - left.start)) {
    after = after.slice(0, range.start) + after.slice(range.end);
  }
  return { projectPath, before: projectText, after };
}
