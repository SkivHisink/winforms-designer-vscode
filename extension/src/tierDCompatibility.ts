import * as fs from 'node:fs';

export interface ActiveXControlReference {
  control: string;
  type: string;
}

/** An Ax-generated identifier: "Ax" followed by an upper-case letter, digit or underscore. This IS the
 * false-positive guard the detector is built around — a user type called Axle, AxleControl or Axis can never
 * match it, so no widening below can brand one. */
const AX_NAME = /^Ax[A-Z0-9_]/;

/** Blank code inside a literal-false preprocessor branch while preserving offsets and line endings. Unknown symbolic
 * conditions deliberately keep every branch visible: without the project's exact DefineConstants, refusing a route
 * that may compile is safer than silently dropping an ActiveX control. */
function withoutLiteralFalseRegions(source: string): string {
  const frames: Array<{ parentActive: boolean; known: boolean; branchTaken: boolean }> = [];
  let active = true;
  return (source.match(/[^\n]*\n?|$/g) ?? []).map((line) => {
    const directive = /^\s*#\s*(if|elif|else|endif)\b(.*?)(?:\r?\n)?$/i.exec(line);
    if (directive) {
      const command = directive[1].toLowerCase();
      const expression = directive[2].trim();
      if (command === 'if') {
        const known = /^(?:true|false)$/i.test(expression);
        const branch = !/^false$/i.test(expression);
        frames.push({ parentActive: active, known, branchTaken: known && branch });
        active = active && (known ? branch : true);
      } else if (command === 'elif' && frames.length > 0) {
        const frame = frames[frames.length - 1];
        const known = frame.known && /^(?:true|false)$/i.test(expression);
        if (!known) {
          frame.known = false;
          active = frame.parentActive;
        } else {
          const branch = !frame.branchTaken && /^true$/i.test(expression);
          frame.branchTaken ||= branch;
          active = frame.parentActive && branch;
        }
      } else if (command === 'else' && frames.length > 0) {
        const frame = frames[frames.length - 1];
        active = frame.parentActive && (frame.known ? !frame.branchTaken : true);
        frame.branchTaken = true;
      } else if (command === 'endif' && frames.length > 0) {
        active = frames.pop()!.parentActive;
      }
      return line;
    }
    return active ? line : line.replace(/[^\r\n]/g, ' ');
  }).join('');
}

/** Blank out comment bodies so a commented-out declaration cannot brand a form as ActiveX. A false positive here
 * is a permanent, unrecoverable refusal, and widening the declaration shapes below makes commented-out code
 * reachable from far more spellings than the old `private`-only regex was. Bodies are replaced with spaces rather
 * than removed so every offset and line break is preserved; string and char literals (including verbatim `@"…"`)
  * are skipped, so a `//` inside a Label.Text value is not mistaken for a comment. */
function withoutComments(source: string): string {
  const out = source.split('');
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') { out[i] = ' '; i++; }
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < source.length) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
      continue;
    }
    if (ch === '@' && source[i + 1] === '"') {
      i += 2;
      while (i < source.length) {
        if (source[i] === '"' && source[i + 1] === '"') { i += 2; continue; }
        if (source[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '"' || ch === '\'') {
      const quote = ch;
      i++;
      while (i < source.length && source[i] !== quote) { if (source[i] === '\\') i++; i++; }
      i++;
      continue;
    }
    i++;
  }
  return out.join('');
}

/** The `using` directives that let a designer file spell an Ax wrapper WITHOUT its namespace: a plain
 * `using AxWMPLib;` import, or an alias `using Player = AxWMPLib.AxWindowsMediaPlayer;`. Only Ax-shaped
 * namespaces/targets are recorded, so an ordinary `using System.Windows.Forms;` contributes nothing and an
 * unqualified user type stays unbranded. */
function axImports(source: string): { imported: boolean; aliases: Map<string, string> } {
  const aliases = new Map<string, string>();
  let imported = false;
  const using = /\busing\s+(?:static\s+)?(?:([A-Za-z_]\w*)\s*=\s*)?(?:global::)?([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*;/g;
  for (let m = using.exec(source); m; m = using.exec(source)) {
    const parts = m[2].split('.').map((part) => part.trim());
    if (!parts.some((part) => AX_NAME.test(part))) continue;
    if (m[1]) aliases.set(m[1], parts.join('.'));
    else imported = true;
  }
  return { imported, aliases };
}

/** Resolve one written type spelling to an AxInterop wrapper name, or null. Both halves of the original
 * fingerprint survive: the TYPE NAME must be Ax-shaped, and a QUALIFIED spelling must also carry an Ax-shaped
 * namespace segment. An UNQUALIFIED spelling substitutes the file's own `using` evidence for that segment, which
 * is the only thing the qualified form was ever standing in for. */
function axWrapperType(raw: string, imports: { imported: boolean; aliases: Map<string, string> }): string | null {
  const spelled = raw.replace(/\s+/g, '').replace(/^global::/, '');
  const resolved = imports.aliases.get(spelled) ?? spelled;
  const parts = resolved.split('.');
  if (!AX_NAME.test(parts[parts.length - 1])) return null;
  if (parts.length > 1) return parts.slice(0, -1).some((part) => AX_NAME.test(part)) ? resolved : null;
  return imports.imported ? resolved : null;
}

/** Fields VS marks as hosted OCXs: it emits
 * `this.<field>.OcxState = ((System.Windows.Forms.AxHost.State)(resources.GetObject("<field>.OcxState")))` for
 * every one. This catches a RE-NAMESPACED interop assembly (Interop.WMPLib.AxWindowsMediaPlayer) whose namespace
 * carries no Ax segment, without loosening the namespace rule for anything else — no user type acquires an
 * AxHost.State cast by accident. */
function ocxHostedFields(source: string): Set<string> {
  const found = new Set<string>();
  const ocx = /(?:\bthis\s*\.\s*)?([A-Za-z_]\w*)\s*\.\s*OcxState\s*=[^;]*?\bAxHost\s*\.\s*State\b/g;
  for (let m = ocx.exec(source); m; m = ocx.exec(source)) found.add(m[1]);
  return found;
}

/** Split a declarator tail on its TOP-LEVEL commas: parenthesised/bracketed/braced groups and string literals are
 * dropped first, so `= new Point(1, 2)` is one declarator, not two. */
function outerCommaSegments(tail: string): string[] {
  let depth = 0;
  let out = '';
  for (let i = 0; i < tail.length; i++) {
    const ch = tail[i];
    if (ch === '"' || ch === '\'') {
      const quote = ch;
      i++;
      while (i < tail.length && tail[i] !== quote) { if (tail[i] === '\\') i++; i++; }
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ')' || ch === ']' || ch === '}') { depth--; continue; }
    if (depth === 0) out += ch;
  }
  return out.split(',');
}

/** Identify the source shape emitted by Windows Forms AxInterop wrappers. The TYPE test stays deliberately narrow
 * (see AX_NAME): a random user type called Axle must not be branded ActiveX. The DECLARATION test is deliberately
 * permissive, because every part of a field declaration except the type is under the developer's control —
 * `Modifiers` is a first-class designer property (private is only the default), and a hand-edit can add
 * readonly/static, an attribute, an initializer or a second declarator. Gating on the literal word `private` meant
 * one property change turned the refusal off and the form rendered with its ActiveX controls silently dropped.
 * Construction sites (`this.x = new AxWMPLib.AxWindowsMediaPlayer();`) are scanned too, so a form whose field
 * declarations live in another partial file is still refused. */
export function activeXControlsInDesignerSource(source: string): ActiveXControlReference[] {
  const result: ActiveXControlReference[] = [];
  const seen = new Set<string>();
  const code = withoutComments(withoutLiteralFalseRegions(source));
  const imports = axImports(code);
  const ocx = ocxHostedFields(code);
  const push = (control: string, type: string): void => {
    if (seen.has(control)) return;
    seen.add(control);
    result.push({ control, type });
  };

  // <attributes> <any modifiers> <Type> <name>[= …][, name2 …]; — the tail stops at `{`/`}` so a `class Foo {`
  // header can never swallow the declarations that follow it. The leading delimiter is a LOOKBEHIND, not a
  // consumed character: consuming it would eat the `;` that ends declaration N, hiding declaration N+1 when both
  // sit on one line.
  const field = /(?<=^|[\n;{}])\s*(?:\[[^\]]*\]\s*)*(?:(?:public|private|protected|internal|static|readonly|new|volatile|unsafe|extern)\s+)*(?:global::)?([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s+([A-Za-z_]\w*)\s*([^;{}]*);/g;
  for (let m = field.exec(code); m; m = field.exec(code)) {
    const declared = axWrapperType(m[1], imports);
    const names = [m[2], ...outerCommaSegments(m[3]).slice(1)
      .map((seg) => /^\s*([A-Za-z_]\w*)/.exec(seg)?.[1])
      .filter((name): name is string => !!name)];
    for (const name of names) {
      if (declared) push(name, declared);
      else if (ocx.has(name)) push(name, m[1].replace(/\s+/g, ''));
    }
  }

  const ctor = /(?:([A-Za-z_]\w*)\s*=\s*)?\bnew\s+(?:global::)?([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\(/g;
  for (let m = ctor.exec(code); m; m = ctor.exec(code)) {
    const created = axWrapperType(m[2], imports);
    if (!created) continue;
    push(m[1] ?? created.split('.').pop()!, created);
  }

  // An OCX marked only by its OcxState assignment (declaration in another partial file) is still refused.
  for (const name of ocx) push(name, 'System.Windows.Forms.AxHost');
  return result;
}

function uint16(bytes: Buffer, offset: number): number | null {
  return offset >= 0 && offset + 2 <= bytes.length ? bytes.readUInt16LE(offset) : null;
}

function uint32(bytes: Buffer, offset: number): number | null {
  return offset >= 0 && offset + 4 <= bytes.length ? bytes.readUInt32LE(offset) : null;
}

function rvaToFileOffset(bytes: Buffer, sectionTable: number, sections: number, rva: number): number | null {
  for (let index = 0; index < sections; index++) {
    const section = sectionTable + index * 40;
    const virtualSize = uint32(bytes, section + 8);
    const virtualAddress = uint32(bytes, section + 12);
    const rawSize = uint32(bytes, section + 16);
    const rawPointer = uint32(bytes, section + 20);
    if (virtualSize === null || virtualAddress === null || rawSize === null || rawPointer === null) return null;
    const span = Math.max(virtualSize, rawSize);
    if (rva >= virtualAddress && rva < virtualAddress + span) return rawPointer + (rva - virtualAddress);
  }
  return null;
}

/** True only when a PE image actually requires an x86 process. Managed AnyCPU assemblies also carry IMAGE_FILE_MACHINE_I386,
 * so the CLR 32BITREQUIRED flag is authoritative for managed images; native I386 images without a CLR header are x86. */
export function peImageRequiresX86(bytes: Uint8Array): boolean {
  const buffer = Buffer.from(bytes);
  if (buffer.length < 64 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) return false;
  const pe = uint32(buffer, 0x3c);
  if (pe === null || pe + 24 > buffer.length || buffer.toString('ascii', pe, pe + 4) !== 'PE\0\0') return false;
  const machine = uint16(buffer, pe + 4);
  if (machine !== 0x014c) return false;
  const sections = uint16(buffer, pe + 6);
  const optionalSize = uint16(buffer, pe + 20);
  if (sections === null || optionalSize === null) return false;
  const optional = pe + 24;
  const magic = uint16(buffer, optional);
  const dataDirectories = magic === 0x10b ? optional + 96 : magic === 0x20b ? optional + 112 : null;
  if (dataDirectories === null) return true;
  const cliRva = uint32(buffer, dataDirectories + 14 * 8);
  if (!cliRva) return true;
  const sectionTable = optional + optionalSize;
  const cli = rvaToFileOffset(buffer, sectionTable, sections, cliRva);
  const flags = cli === null ? null : uint32(buffer, cli + 16);
  return flags === null || (flags & 0x2) !== 0;
}

export function assemblyRequiresX86(filePath: string): boolean {
  try { return peImageRequiresX86(fs.readFileSync(filePath)); }
  catch { return false; }
}
