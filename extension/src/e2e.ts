import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as zlib from 'zlib';
import { startEngine, ping, renderDesigner, renderControl, renderWithLayout, describeDesigner, describeComponent, describeLayout, serializeDesigner, setProperty, setTableCell, resetProperty, setImageResource, readTableStyles, setTableStyle, convertValue, getDesignerPalette, resolveAssembly, generateEventHandler, listHandlerCandidates, setEventWiring, addControl, addComponent, listControlTypes, listToolboxItems, removeControl, copyControl, pasteControl, moveZOrder, reparentControl } from './engineClient';
import { findNearestCsproj, projectAssemblyName, csprojReferencesAssembly, projectReferencesAssembly, addReferenceToCsproj } from './csprojRef';

const isPng = (b: Buffer): boolean =>
  b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

/** Build a minimal valid PNG declaring the given IHDR dimensions (header-only decodable). Used to craft a
 *  "pixel bomb" (tiny file, huge declared dimensions) for the image-import DoS-guard regression test. */
function pngWithDims(w: number, h: number): Buffer {
  const crc32 = (b: Buffer): number => {
    let c = ~0;
    for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); }
    return (~c) >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const t = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from([0, 0, 0, 0]))), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Headless end-to-end proof of the extension's engine-client side (no VS Code GUI):
 * spawn the engine in --pipe mode, Ping it, render the sample .Designer.cs, write PNG,
 * then prove the live-update path: a content change yields a different render. The final
 * check inside the actual VS Code Extension Host (F5) is left to the user.
 */
/**
 * Headless proof of the "auto-add a project reference when a control from a non-referenced assembly is
 * dropped" helpers (src/csprojRef.ts). Pure string/fs logic — the vscode glue (prompt + WorkspaceEdit) in
 * designerEditor.ts stays F5-only, but the risky parsing/insertion is verified here against a REAL .csproj.
 */
function verifyCsprojHelpers(repo: string): void {
  const engineCsproj = path.join(repo, 'engine', 'Engine.csproj');
  if (!fs.existsSync(engineCsproj)) throw new Error('csprojRef: fixture missing — ' + engineCsproj);
  const engineText = fs.readFileSync(engineCsproj, 'utf8');

  // projectAssemblyName: reads <AssemblyName>, falls back to the file name.
  if (projectAssemblyName(engineText, engineCsproj) !== 'WinFormsDesigner.Engine') throw new Error('csprojRef: projectAssemblyName did not read <AssemblyName>');
  if (projectAssemblyName('<Project></Project>', '/x/Foo.Bar.csproj') !== 'Foo.Bar') throw new Error('csprojRef: projectAssemblyName fallback to file name broken');

  // csprojReferencesAssembly: a PackageReference is detected (any name form); an absent one is not.
  if (!csprojReferencesAssembly(engineText, 'StreamJsonRpc')) throw new Error('csprojRef: existing PackageReference not detected');
  if (!csprojReferencesAssembly(engineText, 'streamjsonrpc')) throw new Error('csprojRef: reference match must be case-insensitive');
  if (csprojReferencesAssembly(engineText, 'PgmUiControls')) throw new Error('csprojRef: false positive for an unreferenced assembly');
  // strong-named <Reference> (simple name before the comma) and <ProjectReference> path (file base name).
  if (!csprojReferencesAssembly('<Reference Include="MyControls, Version=1.0.0.0, Culture=neutral" />', 'MyControls')) throw new Error('csprojRef: strong-named Reference simple-name match broken');
  if (!csprojReferencesAssembly('<ProjectReference Include="..\\Lib\\MyControls.csproj" />', 'MyControls')) throw new Error('csprojRef: ProjectReference base-name match broken');

  // findNearestCsproj: walks up from engine/samples to engine/Engine.csproj, bounded by the repo root.
  const found = findNearestCsproj(path.join(repo, 'engine', 'samples'), repo);
  if (!found || path.normalize(found).toLowerCase() !== path.normalize(engineCsproj).toLowerCase()) throw new Error('csprojRef: findNearestCsproj did not locate engine/Engine.csproj, got ' + found);

  // addReferenceToCsproj: inserts a well-formed ItemGroup before the single </Project>, and the result then
  // reports the assembly as referenced (round-trip). Original content and the closing tag are preserved.
  const added = addReferenceToCsproj(engineText, 'PgmUiControls', '..\\PgmUi\\bin\\PgmUiControls.dll');
  if (!/<Reference Include="PgmUiControls">/.test(added)) throw new Error('csprojRef: addReferenceToCsproj did not add the <Reference>');
  if (!/<HintPath>\.\.\\PgmUi\\bin\\PgmUiControls\.dll<\/HintPath>/.test(added)) throw new Error('csprojRef: addReferenceToCsproj did not add the HintPath');
  if ((added.match(/<\/Project>/g) || []).length !== 1) throw new Error('csprojRef: addReferenceToCsproj must keep exactly one </Project>');
  if (added.indexOf(engineText.slice(0, engineText.lastIndexOf('</Project>'))) !== 0) throw new Error('csprojRef: addReferenceToCsproj altered the original body');
  if (!csprojReferencesAssembly(added, 'PgmUiControls')) throw new Error('csprojRef: added reference is not detected by csprojReferencesAssembly (round-trip)');
  // idempotent guard direction: XML special chars are escaped in the include name.
  if (addReferenceToCsproj('<Project></Project>', 'A&B', 'x.dll').indexOf('Include="A&amp;B"') < 0) throw new Error('csprojRef: include name is not XML-escaped');
  // EOL preservation: a CRLF project stays CRLF (no stray lone \n introduced by the insert).
  const crlf = '<Project Sdk="Microsoft.NET.Sdk">\r\n  <PropertyGroup>\r\n  </PropertyGroup>\r\n</Project>\r\n';
  const crlfOut = addReferenceToCsproj(crlf, 'X', 'x.dll');
  if (/[^\r]\n/.test(crlfOut)) throw new Error('csprojRef: addReferenceToCsproj introduced a lone \\n into a CRLF file');

  // review fix (#5, nit): a mostly-LF file with one stray CRLF must NOT gain CRLFs (snippet follows the majority LF).
  const mixed = '<Project>\r\n<PropertyGroup>\n</PropertyGroup>\n</Project>\n';
  const mixedOut = addReferenceToCsproj(mixed, 'M', 'm.dll');
  if ((mixedOut.match(/\r\n/g) || []).length !== (mixed.match(/\r\n/g) || []).length) throw new Error('csprojRef: mixed-EOL insert changed the CRLF count (should follow the majority LF)');

  // review fix (#3, low): a trailing comment that contains "</Project>" must NOT divert the insert into the comment.
  const trailing = '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup />\n</Project>\n<!-- legacy </Project> -->\n';
  const trailingOut = addReferenceToCsproj(trailing, 'Z', 'z.dll');
  if (!csprojReferencesAssembly(trailingOut, 'Z')) throw new Error('csprojRef: reference not registered — insert diverted into a trailing comment');
  if (trailingOut.indexOf('<Reference Include="Z">') > trailingOut.indexOf('<!--')) throw new Error('csprojRef: <Reference> inserted after the root </Project> (into the trailing comment)');

  // review fix (#1/#2, high): projectReferencesAssembly resolves a <ProjectReference> to a project whose
  // <AssemblyName> differs from its file name, so an existing reference is detected (no redundant <Reference>).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-csprojref-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'LibA.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><AssemblyName>Contoso.Controls</AssemblyName></PropertyGroup></Project>');
    const formCsproj = path.join(tmpDir, 'FormProj.csproj');
    const formText = '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><ProjectReference Include="LibA.csproj" /></ItemGroup></Project>';
    fs.writeFileSync(formCsproj, formText);
    if (!projectReferencesAssembly(formText, formCsproj, 'Contoso.Controls')) throw new Error('csprojRef: projectReferencesAssembly did not resolve a ProjectReference by its target <AssemblyName>');
    if (!projectReferencesAssembly(formText, formCsproj, 'contoso.controls')) throw new Error('csprojRef: projectReferencesAssembly must be case-insensitive');
    if (projectReferencesAssembly(formText, formCsproj, 'Unrelated')) throw new Error('csprojRef: projectReferencesAssembly false positive for an unreferenced assembly');
    if (!projectReferencesAssembly(engineText, engineCsproj, 'StreamJsonRpc')) throw new Error('csprojRef: projectReferencesAssembly must still match a name-level (Package) reference');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log('e2e: csprojRef helpers verified — projectAssemblyName; csprojReferencesAssembly (Package+strong-name+ProjectReference, case-insensitive, no false positive); projectReferencesAssembly resolves a ProjectReference by target <AssemblyName>; findNearestCsproj walks up to engine/Engine.csproj; addReferenceToCsproj inserts a valid <Reference>+HintPath before the ROOT </Project> (round-trip, XML-escaped, majority-EOL, comment-safe)');
}

async function main(): Promise<void> {
  const repo = path.resolve(__dirname, '..', '..');
  // WFD_ENGINE_DLL lets a run point at a freshly-built engine in an alternate output dir (e.g. when the default
  // bin/Release copy is locked by a live Dev-Host); defaults to the standard build output.
  const dll = process.env.WFD_ENGINE_DLL || path.join(repo, 'engine', 'bin', 'Release', 'net9.0-windows', 'WinFormsDesigner.Engine.dll');
  const designer = path.join(repo, 'engine', 'samples', 'SampleForm.Designer.cs');
  const outPng = path.resolve(__dirname, '..', 'e2e-render.png');

  if (!fs.existsSync(dll)) throw new Error('engine dll not found: ' + dll);
  if (!fs.existsSync(designer)) throw new Error('sample not found: ' + designer);

  // The auto-add-project-reference helpers are pure string/fs functions (no engine) — verify them up front.
  verifyCsprojHelpers(repo);

  console.log('e2e: starting engine…');
  const engine = await startEngine(dll, { onLog: (l) => console.error(l) });
  try {
    const pong = await ping(engine);
    console.log('e2e: ping ->', pong);

    const png = await renderDesigner(engine, designer);
    fs.writeFileSync(outPng, png);
    console.log(`e2e: rendered ${png.length} bytes -> ${outPng}`);
    if (!isPng(png)) throw new Error('result is not a valid PNG');

    // live-update simulation: the same path the save listener takes — change the file's
    // content, re-render, and confirm the rendered output actually reflects the change.
    const src = fs.readFileSync(designer, 'utf8');
    const changed = src.replace(
      'this.ClientSize = new System.Drawing.Size(354, 252);',
      'this.ClientSize = new System.Drawing.Size(520, 400);',
    );
    if (changed === src) throw new Error('live-update fixture: ClientSize anchor not found');
    const tmp = path.join(os.tmpdir(), `wfd-e2e-${process.pid}.Designer.cs`);
    fs.writeFileSync(tmp, changed, 'utf8');
    try {
      const png2 = await renderDesigner(engine, tmp);
      console.log(`e2e: re-rendered after change -> ${png2.length} bytes`);
      if (!isPng(png2)) throw new Error('re-render is not a valid PNG');
      if (png2.equals(png)) throw new Error('live-update: render did not change after editing the file');
      console.log('e2e: live-update verified — re-render reflects the content change');
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }

    // property-grid round-trip: describe → setProperty → describe sees the new value
    const before = await describeComponent(engine, designer, 'agreeCheck');
    const textBefore = before?.properties?.find((p) => p.name === 'Text')?.value;
    if (textBefore !== 'I agree to the terms') throw new Error('describe: unexpected agreeCheck.Text=' + textBefore);

    // §7.1 standard-values dropdowns: an enum property carries an EXCLUSIVE standard-values set; a Boolean is
    // an exclusive True/False set; a Color (BackColor) is a NON-exclusive set (named colors + free ARGB entry).
    {
      const props = before?.properties ?? [];
      const flat = props.find((p) => p.name === 'FlatStyle');
      if (!flat || !flat.isEnum || !flat.standardValues || !flat.standardValues.includes('Standard') || flat.standardValuesExclusive !== true) {
        throw new Error('§7.1: FlatStyle should have an exclusive standard-values set incl. "Standard": ' + JSON.stringify(flat));
      }
      const autoSize = props.find((p) => p.name === 'AutoSize' && p.type === 'System.Boolean');
      if (!autoSize || !autoSize.standardValues || !autoSize.standardValues.includes('True') || !autoSize.standardValues.includes('False') || autoSize.standardValuesExclusive !== true) {
        throw new Error('§7.1: Boolean AutoSize should have exclusive True/False standard values: ' + JSON.stringify(autoSize));
      }
      const back = props.find((p) => p.name === 'BackColor');
      if (!back || !back.standardValues || !back.standardValues.length || back.standardValuesExclusive !== false) {
        throw new Error('§7.1: BackColor (Color) should have a NON-exclusive standard-values set: ' + JSON.stringify(back));
      }
      // a flags enum (Anchor) must NOT get a single-select set (can't express combined flags)
      const anchor = props.find((p) => p.name === 'Anchor');
      if (anchor && anchor.standardValues != null) throw new Error('§7.1: flags enum Anchor must have null standard values (kept as text): ' + JSON.stringify(anchor.standardValues));
      console.log(`e2e: §7.1 standard-values verified — FlatStyle enum exclusive (${flat.standardValues.length}), Boolean True/False, BackColor non-exclusive (${back.standardValues.length}), flags Anchor left as text`);
    }

    // Anchor/Dock visual editors (Phase 2): the glyph picker emits an invariant string ("Bottom, Right" / "Fill");
    // the host composes a C# enum/flags expression (toCSharpExpression) and the engine must accept & round-trip it.
    // Exercise the engine side directly — a [Flags] AnchorStyles bitwise-or, and a single DockStyle member.
    {
      const anchorExpr = 'System.Windows.Forms.AnchorStyles.Bottom | System.Windows.Forms.AnchorStyles.Right';
      const aEd = await setProperty(engine, designer, 'okButton', 'Anchor', anchorExpr);
      if (!aEd.safe || aEd.text === null) throw new Error('Anchor flags setProperty rejected: ' + aEd.reason);
      const dEd = await setProperty(engine, designer, 'okButton', 'Dock', 'System.Windows.Forms.DockStyle.Fill');
      if (!dEd.safe || dEd.text === null) throw new Error('Dock setProperty rejected: ' + dEd.reason);
      const tmpA = path.join(os.tmpdir(), `wfd-e2e-anchor-${process.pid}.Designer.cs`);
      const tmpD = path.join(os.tmpdir(), `wfd-e2e-dock-${process.pid}.Designer.cs`);
      fs.writeFileSync(tmpA, aEd.text, 'utf8');
      fs.writeFileSync(tmpD, dEd.text, 'utf8');
      try {
        const av = (await describeComponent(engine, tmpA, 'okButton'))?.properties?.find((p) => p.name === 'Anchor')?.value;
        if (av !== 'Bottom, Right') throw new Error(`Anchor flags round-trip: okButton.Anchor="${av}" (expected "Bottom, Right")`);
        const dv = (await describeComponent(engine, tmpD, 'okButton'))?.properties?.find((p) => p.name === 'Dock')?.value;
        if (dv !== 'Fill') throw new Error(`Dock round-trip: okButton.Dock="${dv}" (expected "Fill")`);
        console.log(`e2e: Anchor/Dock editors verified — Anchor flags → described "${av}", Dock → described "${dv}"`);
      } finally {
        try { fs.unlinkSync(tmpA); fs.unlinkSync(tmpD); } catch { /* ignore */ }
      }
    }

    const edit = await setProperty(engine, designer, 'agreeCheck', 'Text', '"Changed by grid"');
    if (!edit.safe || edit.text === null) throw new Error('setProperty rejected: ' + edit.reason);
    const tmp2 = path.join(os.tmpdir(), `wfd-e2e-edit-${process.pid}.Designer.cs`);
    fs.writeFileSync(tmp2, edit.text, 'utf8');
    try {
      const after = await describeComponent(engine, tmp2, 'agreeCheck');
      const textAfter = after?.properties?.find((p) => p.name === 'Text')?.value;
      if (textAfter !== 'Changed by grid') throw new Error('property edit not reflected: agreeCheck.Text=' + textAfter);
      // root edit via id "this" must be accepted too
      const rootEdit = await setProperty(engine, designer, 'this', 'Text', '"New Title"');
      if (!rootEdit.safe) throw new Error('root setProperty rejected: ' + rootEdit.reason);
      console.log(`e2e: property-grid round-trip verified — agreeCheck.Text "${textBefore}" → "${textAfter}", root edit safe`);
    } finally {
      try { fs.unlinkSync(tmp2); } catch { /* ignore */ }
    }

    // complex-type editors: engine converts the invariant string → idiomatic C# initializer, the
    // targeted edit applies it, and a re-describe sees the round-tripped value. The ARGB case also
    // exercises the interpreter's static-invocation support (Color.FromArgb must evaluate, else the
    // re-describe would not see the color and the file would be flagged unrepresentable).
    const complexRoundTrip = async (
      label: string, comp: string, prop: string, type: string, raw: string, expectValue: string,
    ): Promise<void> => {
      const expr = await convertValue(engine, type, raw);
      if (expr === null) throw new Error(`${label}: convertValue(${type}, "${raw}") returned null`);
      const ed = await setProperty(engine, designer, comp, prop, expr);
      if (!ed.safe || ed.text === null) throw new Error(`${label}: setProperty rejected: ${ed.reason}`);
      const tmpf = path.join(os.tmpdir(), `wfd-e2e-cx-${process.pid}-${comp}-${prop}.Designer.cs`);
      fs.writeFileSync(tmpf, ed.text, 'utf8');
      try {
        const d = await describeComponent(engine, tmpf, comp);
        const v = d?.properties?.find((p) => p.name === prop)?.value;
        if (v !== expectValue) throw new Error(`${label}: round-trip ${comp}.${prop}="${v}" (expected "${expectValue}")`);
        console.log(`e2e: complex round-trip ${label} — ${comp}.${prop} "${raw}" → ${expr} → described "${v}"`);
      } finally {
        try { fs.unlinkSync(tmpf); } catch { /* ignore */ }
      }
    };

    // Point/Size (Replace: okButton.Location / okButton.Size already assigned in the source)
    await complexRoundTrip('Point', 'okButton', 'Location', 'System.Drawing.Point', '12, 34', '12, 34');
    await complexRoundTrip('Size', 'okButton', 'Size', 'System.Drawing.Size', '120, 40', '120, 40');
    // Color named (Insert: okButton.BackColor not set in the source)
    await complexRoundTrip('Color/named', 'okButton', 'BackColor', 'System.Drawing.Color', 'Red', 'Red');
    // Color ARGB (Insert) — proves Color.FromArgb evaluates in the interpreter, not just parses
    await complexRoundTrip('Color/argb', 'okButton', 'BackColor', 'System.Drawing.Color', '64, 128, 255', '64, 128, 255');
    // Padding (Insert: okButton.Padding not set in the source) — new System.Windows.Forms.Padding(l,t,r,b)
    await complexRoundTrip('Padding', 'okButton', 'Padding', 'System.Windows.Forms.Padding', '5, 6, 7, 8', '5, 6, 7, 8');
    // Font no-style (Insert) — proves the interpreter constructs Font from Drawing.Common (newly probed)
    await complexRoundTrip('Font', 'nameTextBox', 'Font', 'System.Drawing.Font', 'Consolas, 10pt', 'Consolas, 10pt');
    // Font single-style (Insert) — emits new Font(name, size, FontStyle.Bold); interpreter evaluates the enum arg
    await complexRoundTrip('Font/bold', 'okButton', 'Font', 'System.Drawing.Font', 'Arial, 12pt, style=Bold', 'Arial, 12pt, style=Bold');
    // Font combined-style (Insert) — emits new Font(name, size, FontStyle.Bold | FontStyle.Italic); the converter
    // folds combined flags into a bitwise-or chain and the interpreter's broadened bitwise-or Eval reads it back.
    await complexRoundTrip('Font/combined', 'cancelButton', 'Font', 'System.Drawing.Font', 'Arial, 9pt, style=Bold, Italic', 'Arial, 9pt, style=Bold, Italic');

    // validation: garbage input must be rejected (null), not turned into broken C#
    if (await convertValue(engine, 'System.Drawing.Color', 'NotARealColorXYZ') !== null) {
      throw new Error('convertValue accepted an invalid color name');
    }
    if (await convertValue(engine, 'System.Drawing.Point', 'not, numbers') !== null) {
      throw new Error('convertValue accepted an invalid point');
    }
    // Rectangle converts to an idiomatic ctor (no stock browsable Rectangle property to round-trip on a
    // standard control — Bounds is Browsable(false); the engine fixture covers the interpret side).
    if (await convertValue(engine, 'System.Drawing.Rectangle', '1, 2, 3, 4') !== 'new System.Drawing.Rectangle(1, 2, 3, 4)') {
      throw new Error('convertValue produced unexpected Rectangle expression');
    }
    // an uninstalled font family is silently substituted by GDI+ — the converter detects that the resulting
    // family differs from what was typed and rejects (null), so the grid never rewrites the author's name.
    if (await convertValue(engine, 'System.Drawing.Font', 'NoSuchFontFamilyXYZ, 10pt') !== null) {
      throw new Error('convertValue accepted an uninstalled font family (should be null)');
    }
    console.log('e2e: complex-type validation verified — invalid values rejected, Rectangle converts, uninstalled font declined');

    // fix #5: a Font carrying a non-default GdiCharSet (204 = RUSSIAN_CHARSET) can't be represented by the
    // grid's invariant-string editor, so describe marks it read-only to prevent silently dropping the charset
    // on edit. Inject such a Font and confirm the property comes back read-only (vs editable for plain fonts).
    const charsetSrc = src.replace(
      'this.okButton.Text = "OK";',
      'this.okButton.Text = "OK";\n            this.okButton.Font = new System.Drawing.Font("Microsoft Sans Serif", 9.75F, System.Drawing.FontStyle.Regular, System.Drawing.GraphicsUnit.Point, ((byte)(204)));',
    );
    if (charsetSrc === src) throw new Error('charset fixture: okButton.Text anchor not found');
    const tmpCs = path.join(os.tmpdir(), `wfd-e2e-charset-${process.pid}.Designer.cs`);
    fs.writeFileSync(tmpCs, charsetSrc, 'utf8');
    try {
      const csComp = await describeComponent(engine, tmpCs, 'okButton');
      const fontProp = csComp?.properties?.find((p) => p.name === 'Font');
      if (!fontProp) throw new Error('charset fixture: okButton.Font not described');
      if (fontProp.readOnly !== true) throw new Error('charset Font should be read-only (would drop GdiCharSet on edit)');
      const plain = await describeComponent(engine, designer, 'nameTextBox');
      const plainFont = plain?.properties?.find((p) => p.name === 'Font');
      if (plainFont?.readOnly !== false) throw new Error('plain Font (charset 1) should remain editable');
      console.log('e2e: charset-Font guard verified — GdiCharSet 204 font is read-only, plain font editable');
    } finally {
      try { fs.unlinkSync(tmpCs); } catch { /* ignore */ }
    }

    // ---- designer palette (Color dropdown + Font editor data) ----
    // The Color dropdown's swatches, the Font Name combobox, and the Font Unit dropdown are all fed by the
    // GetDesignerPalette RPC. Assert the palette is non-empty and internally consistent: a known web color
    // resolves to a 6-hex swatch, a system color is present, at least one installed font family exists, and
    // the Point unit maps to the "pt" suffix the Font editor composes with.
    {
      const pal = await getDesignerPalette(engine);
      if (!pal.webColors.length) throw new Error('palette: no web colors');
      if (!pal.systemColors.length) throw new Error('palette: no system colors');
      if (!pal.fontFamilies.length) throw new Error('palette: no font families');
      if (!pal.fontUnits.length) throw new Error('palette: no font units');
      const red = pal.webColors.find((c) => c.name === 'Red');
      if (!red || !/^[0-9A-Fa-f]{6}$/.test(red.argb)) throw new Error(`palette: Red swatch malformed (${red?.argb})`);
      if (!pal.systemColors.some((c) => c.name === 'Control')) throw new Error('palette: system color "Control" missing');
      const pt = pal.fontUnits.find((u) => u.name === 'Point');
      if (!pt || pt.suffix !== 'pt') throw new Error(`palette: Point unit suffix "${pt?.suffix}" (expected "pt")`);
      // the exact unit suffixes the Font editor composes with must be present & valid (Display is not
      // constructible for a Font → must be absent, not emitted with a bogus suffix)
      if (pal.fontUnits.some((u) => u.name === 'Display')) throw new Error('palette: Display unit should be omitted (invalid for Font)');
      console.log(`e2e: designer palette verified — ${pal.webColors.length} web / ${pal.systemColors.length} system colors, ${pal.fontFamilies.length} fonts, units [${pal.fontUnits.map((u) => u.name + '=' + u.suffix).join(', ')}]`);
    }

    // ---- flags-enum members (generic [Flags] checkbox dropdown) ----
    // A [Flags] property (Anchor = AnchorStyles) must carry its single-bit member names + zero member so the
    // grid can build a checkbox dropdown that composes "Top, Left" and, when cleared, commits the zero member.
    {
      const okc = await describeComponent(engine, designer, 'okButton');
      const anchor = okc?.properties?.find((p) => p.name === 'Anchor');
      if (!anchor) throw new Error('flags: okButton.Anchor not described');
      const fm = anchor.flagsMembers ?? [];
      for (const m of ['Top', 'Bottom', 'Left', 'Right']) {
        if (!fm.includes(m)) throw new Error(`flags: AnchorStyles.${m} missing from flagsMembers [${fm.join(', ')}]`);
      }
      if (fm.includes('None')) throw new Error('flags: zero member "None" must NOT be in flagsMembers');
      if (anchor.flagsZero !== 'None') throw new Error(`flags: AnchorStyles zero member "${anchor.flagsZero}" (expected "None")`);
      // a non-flags enum (a plain enum with a standard-values dropdown) must NOT get flagsMembers
      const dock = okc?.properties?.find((p) => p.name === 'Dock');
      if (dock && dock.flagsMembers) throw new Error('flags: non-flags enum Dock should have null flagsMembers');
      console.log(`e2e: flags-enum members verified — AnchorStyles [${fm.join(', ')}] zero=${anchor.flagsZero}, Dock (non-flags) has none`);
    }

    // ---- resx image resolution (BackgroundImage / PictureBox.Image via resources.GetObject) ----
    // ImageForm assigns pictureBox1.Image and $this.BackgroundImage from its sibling ImageForm.resx (embedded
    // 16x16 bitmaps). The interpreter must resolve resources.GetObject(...) through the safe ResxResolver: every
    // statement (incl. the two GetObject assignments + the `resources` decl) must be representable (none throw),
    // the form must render, and pictureBox1 must be present at its declared size. Pins the read-side of the
    // image pipeline; the SAFETY of the reader (no BinaryFormatter, no file-refs) is covered by its allowlist.
    {
      const imageForm = path.join(repo, 'engine', 'samples', 'ImageForm.Designer.cs');
      const desc = await describeDesigner(engine, imageForm);
      if (desc.unrepresentable.length !== 0) {
        throw new Error(`resx: ImageForm has unrepresentable statements (resources.GetObject not resolved?): ${desc.unrepresentable.join(' | ')}`);
      }
      if (desc.representable !== desc.totalStatements) {
        throw new Error(`resx: ImageForm representable ${desc.representable}/${desc.totalStatements}`);
      }
      const rl = await renderWithLayout(engine, imageForm);
      if (rl.png.length < 200) throw new Error('resx: ImageForm render is blank/too small');
      const pic = rl.controls.find((c) => c.id === 'pictureBox1');
      if (!pic) throw new Error('resx: pictureBox1 missing from layout');
      if (pic.width !== 64 || pic.height !== 64) throw new Error(`resx: pictureBox1 size ${pic.width}x${pic.height} (expected 64x64)`);
      // Slice 2 (describe + preview): the image prop is flagged isImage and carries a valid PNG thumbnail.
      const pcComp = await describeComponent(engine, imageForm, 'pictureBox1');
      const imgP = pcComp?.properties?.find((p) => p.name === 'Image');
      if (!imgP?.isImage) throw new Error('resx: pictureBox1.Image should be flagged isImage');
      if (!imgP.imagePreview || !isPng(Buffer.from(imgP.imagePreview, 'base64'))) throw new Error('resx: pictureBox1.Image has no valid preview thumbnail');
      console.log(`e2e: resx image resolution verified — ImageForm ${desc.representable}/${desc.totalStatements} representable, rendered ${rl.png.length}B, pictureBox1 ${pic.width}x${pic.height}, preview ${imgP.imagePreview.length}B base64`);
    }

    // ---- resx image WRITE pipeline (Import… + (none)) ----
    // SetImageResource embeds a chosen image into the form's sibling .resx and writes the resources.GetObject
    // assignment (ensuring the resources local). The round-trip must then RENDER the image and the preview must
    // read it back; ResetProperty clears it. Also pins the write-side SAFETY: a non-allowlisted property type
    // and non-image bytes are both refused. The .resx is created when absent and appended-to when present.
    {
      const BLUE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAdSURBVDhPY1BIOPCfEsyALkAqHjVg1IBRAwaLAQDB4j8ffOS2lgAAAABJRU5ErkJggg==';
      const base = path.join(os.tmpdir(), `wfd-e2e-imgwrite-${process.pid}`);
      const designerTmp = base + '.Designer.cs';
      const resxTmp = base + '.resx';
      const src = [
        'namespace SampleApp {',
        '    partial class E2eImageForm {',
        '        private void InitializeComponent() {',
        '            this.pictureBox1 = new System.Windows.Forms.PictureBox();',
        '            this.SuspendLayout();',
        '            this.pictureBox1.Location = new System.Drawing.Point(20, 20);',
        '            this.pictureBox1.Name = "pictureBox1";',
        '            this.pictureBox1.Size = new System.Drawing.Size(48, 48);',
        '            this.pictureBox1.TabIndex = 0;',
        '            this.ClientSize = new System.Drawing.Size(200, 150);',
        '            this.Controls.Add(this.pictureBox1);',
        '            this.Name = "E2eImageForm";',
        '            this.ResumeLayout(false);',
        '        }',
        '        private System.Windows.Forms.PictureBox pictureBox1;',
        '    }',
        '}',
      ].join('\n');
      fs.writeFileSync(designerTmp, src, 'utf8');
      try {
        // (a) child image prop pictureBox1.Image — .resx CREATED (resxText null), assignment + resources local INSERTED
        const w1 = await setImageResource(engine, designerTmp, 'pictureBox1', 'Image', 'System.Drawing.Image', BLUE_PNG, null, src);
        if (!w1.safe || w1.designerText === null || w1.resxText === null) throw new Error(`resx-write: pictureBox1.Image rejected: ${w1.reason}`);
        if (w1.resxKey !== 'pictureBox1.Image') throw new Error(`resx-write: wrong child key ${w1.resxKey}`);
        if (!/resources\.GetObject\("pictureBox1\.Image"\)/.test(w1.designerText)) throw new Error('resx-write: GetObject assignment missing from designer text');
        if (!/ComponentResourceManager\s+resources\s*=/.test(w1.designerText)) throw new Error('resx-write: resources local not inserted');
        if (!w1.resxText.includes('name="pictureBox1.Image"') || !w1.resxText.includes(BLUE_PNG)) throw new Error('resx-write: resx missing the entry/payload');

        // (b) form image prop this.BackgroundImage — .resx now EXISTS (pass w1.resxText); key "$this.BackgroundImage"
        const w2 = await setImageResource(engine, designerTmp, 'this', 'BackgroundImage', 'System.Drawing.Image', BLUE_PNG, w1.resxText, w1.designerText);
        if (!w2.safe || w2.designerText === null || w2.resxText === null) throw new Error(`resx-write: BackgroundImage rejected: ${w2.reason}`);
        if (w2.resxKey !== '$this.BackgroundImage') throw new Error(`resx-write: wrong form key ${w2.resxKey}`);
        if ((w2.designerText.match(/ComponentResourceManager\s+resources\s*=/g) || []).length !== 1) throw new Error('resx-write: resources local duplicated on the 2nd import');
        if (!w2.resxText.includes('name="$this.BackgroundImage"') || !w2.resxText.includes('name="pictureBox1.Image"')) throw new Error('resx-write: 2nd upsert dropped the 1st entry');

        // write BOTH files → prove the round-trip RENDERS the images and the preview reads them back
        fs.writeFileSync(designerTmp, w2.designerText, 'utf8');
        fs.writeFileSync(resxTmp, w2.resxText, 'utf8');
        const desc2 = await describeDesigner(engine, designerTmp);
        if (desc2.unrepresentable.length !== 0) throw new Error(`resx-write: round-trip has unrepresentable statements: ${desc2.unrepresentable.join(' | ')}`);
        const rl2 = await renderWithLayout(engine, designerTmp);
        if (rl2.png.length < 200) throw new Error('resx-write: round-trip render is blank/too small');
        const pcAfter = await describeComponent(engine, designerTmp, 'pictureBox1');
        const imgAfter = pcAfter?.properties?.find((p) => p.name === 'Image');
        if (!imgAfter?.isImage) throw new Error('resx-write: pictureBox1.Image not flagged isImage after write');
        if (!imgAfter.imagePreview || !isPng(Buffer.from(imgAfter.imagePreview, 'base64'))) throw new Error('resx-write: no valid preview after write (round-trip read failed)');

        // (c) Clear ((none)) via ResetProperty — the assignment is removed
        const cleared = await resetProperty(engine, designerTmp, 'pictureBox1', 'Image', w2.designerText);
        if (!cleared.safe || cleared.text == null) throw new Error(`resx-write: clear failed: ${cleared.reason}`);
        if (/resources\.GetObject\("pictureBox1\.Image"\)/.test(cleared.text)) throw new Error('resx-write: clear did not remove the assignment');

        // (d) SECURITY: a non-allowlisted property type is refused
        const badType = await setImageResource(engine, designerTmp, 'pictureBox1', 'Tag', 'System.Object', BLUE_PNG, w2.resxText, w2.designerText);
        if (badType.safe) throw new Error('resx-write: a non-image property type must be refused');
        // (e) SECURITY: non-image bytes are refused
        const notImg = Buffer.from('this is definitely not an image file, just plain text').toString('base64');
        const badBytes = await setImageResource(engine, designerTmp, 'pictureBox1', 'Image', 'System.Drawing.Image', notImg, w2.resxText, w2.designerText);
        if (badBytes.safe) throw new Error('resx-write: non-image bytes must be refused');

        // (f) SECURITY: a pixel bomb (tiny file declaring 19999x19999 = 400M px) is refused by the pixel/dimension
        // bound from a header-only decode — never materializes the ~1.6 GB raster.
        const bomb = pngWithDims(19999, 19999).toString('base64');
        const bombRes = await setImageResource(engine, designerTmp, 'pictureBox1', 'Image', 'System.Drawing.Image', bomb, w2.resxText, w2.designerText);
        if (bombRes.safe) throw new Error('resx-write: a pixel-bomb image must be refused');
        if (!/dimension/i.test(bombRes.reason)) throw new Error(`resx-write: pixel bomb refused for the wrong reason: ${bombRes.reason}`);

        // (g) ANCHOR: a component whose only InitializeComponent statement is its `new` line still finds an
        // insert anchor (its own creation) — imports on a freshly-added tray component don't dead-end.
        const bareSrc = [
          'namespace S { partial class Bare {',
          '  private void InitializeComponent() {',
          '    this.pb = new System.Windows.Forms.PictureBox();',
          '    this.Controls.Add(this.pb); this.Name = "Bare"; }',
          '  private System.Windows.Forms.PictureBox pb; } }',
        ].join('\n');
        const bareRes = await setImageResource(engine, designerTmp, 'pb', 'Image', 'System.Drawing.Image', BLUE_PNG, null, bareSrc);
        if (!bareRes.safe || bareRes.mode !== 'Insert') throw new Error(`resx-write: a creation-only component should Insert, got ${bareRes.mode}: ${bareRes.reason}`);

        // (h) FIDELITY: upserting into a resx that already holds a multi-line (LF) string and a whitespace-only
        // value preserves both verbatim (no LF->CRLF churn, no whitespace collapse).
        const richResx = '<?xml version="1.0" encoding="utf-8"?>\n<root>\n  <resheader name="resmimetype"><value>text/microsoft-resx</value></resheader>\n  <data name="multi" xml:space="preserve"><value>a\nb\nc</value></data>\n  <data name="spacer"><value>   </value></data>\n</root>\n';
        const fid = await setImageResource(engine, designerTmp, 'pictureBox1', 'Image', 'System.Drawing.Image', BLUE_PNG, richResx, w2.designerText);
        if (!fid.safe || fid.resxText === null) throw new Error(`resx-write: fidelity upsert rejected: ${fid.reason}`);
        const mMatch = /<data name="multi"[^>]*>\s*<value>([\s\S]*?)<\/value>/.exec(fid.resxText);
        if (!mMatch || mMatch[1] !== 'a\nb\nc') throw new Error(`resx-write: multi-line LF value mangled: ${JSON.stringify(mMatch && mMatch[1])}`);
        const sMatch = /<data name="spacer"[^>]*>\s*<value>([\s\S]*?)<\/value>/.exec(fid.resxText);
        if (!sMatch || sMatch[1] !== '   ') throw new Error(`resx-write: whitespace-only value not preserved: ${JSON.stringify(sMatch && sMatch[1])}`);

        console.log(`e2e: resx image WRITE pipeline verified — SetImageResource embeds pictureBox1.Image + $this.BackgroundImage (single resources local, .resx created then appended), round-trip renders ${rl2.png.length}B + preview reads back, ResetProperty clears; SECURITY: non-image type/bytes + pixel-bomb refused, creation-only anchor works, LF/whitespace resx fidelity preserved`);
      } finally {
        for (const f of [designerTmp, resxTmp]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
      }
    }

    // ---- explicit control-assembly override (RPC asm fallback) ----
    // CustomForm references CustomControls.GaugeControl. Auto-discovery walks up to engine/Engine.csproj
    // and finds WinFormsDesigner.Engine.dll (which lacks GaugeControl), so WITHOUT the override the custom
    // type is unresolved (form serializes unsafely, gauges not created). Passing the explicit CustomControls.dll
    // resolves it fully — proving the optional asm param threads through Render/Describe/Serialize RPCs. The
    // 1-arg calls (no override) also confirm the optional positional param stays interop-compatible.
    const customForm = path.join(repo, 'engine', 'samples', 'CustomForm.Designer.cs');
    const customDll = path.join(repo, 'samples', 'CustomControls', 'bin', 'Release', 'net9.0-windows', 'CustomControls.dll');
    if (fs.existsSync(customForm) && fs.existsSync(customDll)) {
      const autoSer = await serializeDesigner(engine, customForm);                // 1-arg → auto-discover
      const explicitSer = await serializeDesigner(engine, customForm, customDll);  // 2-arg → explicit override
      if (explicitSer.safe !== true) {
        throw new Error('explicit-asm serialize should be safe; unrepresentable: ' + explicitSer.unrepresentable.join('; '));
      }
      if (explicitSer.code === null) throw new Error('explicit-asm serialize returned null code despite safe');
      if (autoSer.safe !== false) {
        throw new Error('auto-resolve serialize of CustomForm should be unsafe (GaugeControl unresolved without override)');
      }
      // the custom control's custom property only resolves with the override
      const gauge = await describeComponent(engine, customForm, 'cpuGauge', customDll);
      const gaugeVal = gauge?.properties?.find((p) => p.name === 'Value')?.value;
      if (gaugeVal !== '85') throw new Error('explicit-asm describe: cpuGauge.Value=' + gaugeVal + ' (expected 85)');
      const gaugeAuto = await describeComponent(engine, customForm, 'cpuGauge'); // 1-arg → unresolved → not found
      if (gaugeAuto !== null) throw new Error('auto-resolve should not find cpuGauge (GaugeControl unresolved)');
      // §7.2 Increment 2: the project assembly's own control appears in the toolbox under "Project Controls"
      const tbProj = await listToolboxItems(engine, customForm, customDll);
      const gaugeItem = tbProj.find((t) => t.name === 'GaugeControl');
      if (!gaugeItem || !gaugeItem.fromProject || gaugeItem.category !== 'Project Controls') {
        throw new Error('§7.2 Inc2: GaugeControl should appear as a Project Control: ' + JSON.stringify(tbProj.filter((t) => t.fromProject)));
      }
      if (gaugeItem.fqn !== 'CustomControls.GaugeControl') throw new Error('§7.2 Inc2: GaugeControl fqn wrong: ' + gaugeItem.fqn);
      if (!tbProj.some((t) => t.name === 'Button' && !t.fromProject)) throw new Error('§7.2 Inc2: framework controls must still be present alongside project controls');
      // a project control adds via its fqn (validated against the enumerated set), framework path unaffected
      const addGauge = await addControl(engine, customForm, 'this', 'CustomControls.GaugeControl', fs.readFileSync(customForm, 'utf8'), undefined, undefined, customDll);
      if (!addGauge.safe || addGauge.newText === null) throw new Error('§7.2 Inc2: AddControl(GaugeControl) rejected: ' + addGauge.reason);
      if (addGauge.newText.indexOf('new CustomControls.GaugeControl()') < 0) throw new Error('§7.2 Inc2: AddControl(GaugeControl) did not emit the project type ctor');
      const addBogus = await addControl(engine, customForm, 'this', 'CustomControls.NotAThing', fs.readFileSync(customForm, 'utf8'), undefined, undefined, customDll);
      if (addBogus.safe) throw new Error('§7.2 Inc2: AddControl must reject a project type that is not in the enumerated set');
      // render with the override paints the gauges → a different (larger) PNG than auto-resolve
      const autoPng = await renderDesigner(engine, customForm);
      const explicitPng = await renderDesigner(engine, customForm, customDll);
      if (!isPng(explicitPng)) throw new Error('explicit-asm render is not a PNG');
      if (explicitPng.equals(autoPng)) throw new Error('explicit-asm render should differ from auto-resolve (gauges painted)');
      // a non-existent explicit override is a hard error now (no silent fallback to auto-discovery that
      // re-runs the very path the override was set to bypass — the user's typo would otherwise be invisible).
      let threw = false;
      try { await serializeDesigner(engine, customForm, customDll + '.nonexistent'); } catch { threw = true; }
      if (!threw) throw new Error('a non-existent explicit asm path should be rejected, not silently auto-resolved');
      console.log(`e2e: explicit-asm override verified — serialize safe with override (unsafe auto), cpuGauge.Value=85 (null auto), render differs (${autoPng.length}→${explicitPng.length} bytes), missing-path rejected`);
    } else {
      console.log('e2e: explicit-asm override SKIPPED — build samples/CustomControls (Release) to exercise it');
    }

    // ---- dirty-region: single-control render (S3) ----
    // Re-render one control and confirm the patch matches the model: size equals the control's described
    // Size, the PNG is valid, and its full-frame (window) position implies a client origin that is the
    // SAME across direct children (proves the chrome-offset transform), and an unknown id → found=false.
    // The engine half; webview drawing of the patch is verified via F5.
    {
      const parsePair = (s?: string | null): [number, number] => {
        const [a, b] = (s ?? '').split(',').map((n) => parseInt(n.trim(), 10));
        return [a, b];
      };
      const modelPatch = async (id: string) => {
        const d = await describeComponent(engine, designer, id);
        const [w, h] = parsePair(d?.properties?.find((p) => p.name === 'Size')?.value);
        const [lx, ly] = parsePair(d?.properties?.find((p) => p.name === 'Location')?.value);
        return { id, w, h, lx, ly, patch: await renderControl(engine, designer, id) };
      };
      const ok = await modelPatch('okButton');
      const ag = await modelPatch('agreeCheck');
      for (const c of [ok, ag]) {
        if (!c.patch.found) throw new Error(`renderControl: ${c.id} not found`);
        if (!isPng(c.patch.png)) throw new Error(`renderControl: ${c.id} patch not a valid PNG`);
        if (c.patch.width !== c.w || c.patch.height !== c.h) {
          throw new Error(`renderControl ${c.id} size ${c.patch.width}x${c.patch.height} != described ${c.w}x${c.h}`);
        }
      }
      // window coord = client origin + control's client position; the origin must match across direct children
      const ox = ok.patch.x - ok.lx, oy = ok.patch.y - ok.ly;
      if (ox !== ag.patch.x - ag.lx || oy !== ag.patch.y - ag.ly) {
        throw new Error(`renderControl client origin inconsistent: ok(${ox},${oy}) vs agree(${ag.patch.x - ag.lx},${ag.patch.y - ag.ly})`);
      }
      if (ox < 0 || oy < 0) throw new Error(`renderControl client origin negative (${ox},${oy})`);
      const missing = await renderControl(engine, designer, 'noSuchControlXYZ');
      if (missing.found) throw new Error('renderControl should report found=false for an unknown id');
      console.log(`e2e: dirty-region single-control render verified — okButton ${ok.patch.width}x${ok.patch.height} @ window(${ok.patch.x},${ok.patch.y}); consistent client origin (${ox},${oy}); unknown id → found=false`);

      // ---- layout hit-test map (click-to-select) ----
      // The layout's per-control bounds MUST equal the proven RenderControl placement (both share
      // ComputeWindowOffset), so a click maps to exactly the area a patch repaints. Assert okButton's
      // layout rect == its patch rect, the root covers the full frame at (0,0), controls are innermost-
      // first (deepest before the root), parent ids are correct, and a known point hit-tests to the
      // expected control (the same logic the webview will run).
      const layout = await describeLayout(engine, designer);
      if (layout.width <= 0 || layout.height <= 0) throw new Error('layout: non-positive frame size');
      const lOk = layout.controls.find((c) => c.id === 'okButton');
      if (!lOk) throw new Error('layout: okButton missing');
      if (lOk.x !== ok.patch.x || lOk.y !== ok.patch.y || lOk.width !== ok.patch.width || lOk.height !== ok.patch.height) {
        throw new Error(`layout okButton rect (${lOk.x},${lOk.y},${lOk.width},${lOk.height}) != patch (${ok.patch.x},${ok.patch.y},${ok.patch.width},${ok.patch.height})`);
      }
      const root = layout.controls.find((c) => c.isRoot);
      if (!root) throw new Error('layout: root missing');
      if (root.id !== 'this' || root.x !== 0 || root.y !== 0 || root.width !== layout.width || root.height !== layout.height) {
        throw new Error('layout: root should be id "this" covering the full frame at (0,0)');
      }
      if (layout.controls[layout.controls.length - 1].isRoot !== true) {
        throw new Error('layout: root must sort last (innermost-first) so empty-form clicks select the form');
      }
      if (lOk.parentId !== 'this') throw new Error('layout: okButton parentId should be "this"');
      // anchor/dock strings feed the canvas anchor-tether overlay (Phase 2): every control carries them,
      // the root is "None".
      if (typeof lOk.anchor !== 'string' || !lOk.anchor.length || typeof lOk.dock !== 'string' || !lOk.dock.length) {
        throw new Error(`layout: okButton must carry anchor/dock strings (anchor=${JSON.stringify(lOk.anchor)}, dock=${JSON.stringify(lOk.dock)})`);
      }
      if (root.anchor !== 'None' || root.dock !== 'None') throw new Error('layout: root anchor/dock must be "None"');
      const optA = layout.controls.find((c) => c.id === 'optionA');
      if (!optA || optA.parentId !== 'optionsGroup' || optA.depth !== 2) {
        throw new Error('layout: optionA should be nested in optionsGroup at depth 2');
      }
      // tab-order overlay (Phase 2): every non-root control carries its TabIndex; the root is -1
      if (typeof lOk.tabIndex !== 'number' || lOk.tabIndex < 0) throw new Error('layout: okButton tabIndex missing/invalid');
      if (root.tabIndex !== -1) throw new Error('layout: root tabIndex should be -1 (no tab order)');
      // component tray (§7.3): SampleForm has no non-visual components → empty tray
      if (!Array.isArray(layout.tray)) throw new Error('layout: tray must be an array');
      // simulate the webview hit-test: first containing rect (innermost-first order) at okButton's center
      const hit = (px: number, py: number): string | undefined =>
        layout.controls.find((c) => px >= c.x && px < c.x + c.width && py >= c.y && py < c.y + c.height)?.id;
      const center = hit(lOk.x + Math.floor(lOk.width / 2), lOk.y + Math.floor(lOk.height / 2));
      if (center !== 'okButton') throw new Error(`layout hit-test at okButton center → ${center} (expected okButton)`);
      // a click on empty form chrome (top-left of the frame, above the client area) selects the form
      const corner = hit(1, 1);
      if (corner !== 'this') throw new Error(`layout hit-test at frame corner → ${corner} (expected the form "this")`);
      console.log(`e2e: layout hit-test map verified — okButton rect == patch (${lOk.x},${lOk.y},${lOk.width},${lOk.height}) anchor="${lOk.anchor}"/dock="${lOk.dock}"; root full-frame & last; center→okButton, corner→form`);

      // ---- combined render+layout RPC (one graph load) ----
      // RenderWithLayout folds renderDesigner + describeLayout into a SINGLE graph load (perf on large
      // forms). Prove it is a drop-in: the PNG is byte-identical to renderDesigner and the controls are
      // field-identical to describeLayout — same frame size, same per-control rects in the same
      // innermost-first order. (Byte-identity also pins the ordering choice: building the layout before
      // DrawToBitmap must not perturb the rendered pixels.)
      const combined = await renderWithLayout(engine, designer);
      if (!isPng(combined.png)) throw new Error('renderWithLayout: png is not a valid PNG');
      if (!combined.png.equals(png)) {
        throw new Error(`renderWithLayout: png (${combined.png.length}B) differs from renderDesigner (${png.length}B) — must be byte-identical`);
      }
      if (combined.width !== layout.width || combined.height !== layout.height) {
        throw new Error(`renderWithLayout: frame ${combined.width}x${combined.height} != describeLayout ${layout.width}x${layout.height}`);
      }
      // client-area size (for the form-resize commit) must be positive, smaller than the window frame
      // (chrome > 0), and identical across the combined and separate calls.
      if (combined.clientWidth <= 0 || combined.clientHeight <= 0) throw new Error('renderWithLayout: non-positive client size');
      if (combined.clientWidth >= combined.width || combined.clientHeight >= combined.height) {
        throw new Error(`renderWithLayout: client ${combined.clientWidth}x${combined.clientHeight} not inside frame ${combined.width}x${combined.height}`);
      }
      if (combined.clientWidth !== layout.clientWidth || combined.clientHeight !== layout.clientHeight) {
        throw new Error('renderWithLayout: client size differs from describeLayout');
      }
      if (combined.controls.length !== layout.controls.length) {
        throw new Error(`renderWithLayout: ${combined.controls.length} controls != describeLayout ${layout.controls.length}`);
      }
      for (let i = 0; i < layout.controls.length; i++) {
        const a = combined.controls[i], b = layout.controls[i];
        if (a.id !== b.id || a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height ||
            a.parentId !== b.parentId || a.depth !== b.depth || a.isRoot !== b.isRoot || a.anchor !== b.anchor || a.dock !== b.dock) {
          throw new Error(`renderWithLayout: control[${i}] "${a.id}" (${a.x},${a.y},${a.width},${a.height}) != describeLayout "${b.id}" (${b.x},${b.y},${b.width},${b.height})`);
        }
      }
      console.log(`e2e: combined render+layout verified — RenderWithLayout png == renderDesigner (${combined.png.length}B), ${combined.controls.length} controls == describeLayout, one graph load`);

      // hardening: the byte/field-identity must ALSO hold on the explicit-asm path (custom controls from
      // an ALC), and a missing file must reject exactly like the separate calls — so the combined RPC
      // can't silently drift from renderDesigner/describeLayout on the asm-threading or error paths.
      const sameControls = (a: typeof combined.controls, b: typeof combined.controls): boolean =>
        a.length === b.length && a.every((c, i) =>
          c.id === b[i].id && c.x === b[i].x && c.y === b[i].y && c.width === b[i].width &&
          c.height === b[i].height && c.parentId === b[i].parentId && c.depth === b[i].depth && c.isRoot === b[i].isRoot);
      if (fs.existsSync(customForm) && fs.existsSync(customDll)) {
        const cmb = await renderWithLayout(engine, customForm, customDll);
        const sep = await renderDesigner(engine, customForm, customDll);
        const sepLayout = await describeLayout(engine, customForm, customDll);
        if (!cmb.png.equals(sep)) throw new Error('renderWithLayout(explicit-asm): png differs from renderDesigner');
        if (!sameControls(cmb.controls, sepLayout.controls)) throw new Error('renderWithLayout(explicit-asm): controls differ from describeLayout');
        console.log(`e2e: combined render+layout (explicit-asm) verified — ${cmb.png.length}B png == renderDesigner, ${cmb.controls.length} controls == describeLayout (custom gauges from ALC)`);
      }
      let combinedThrew = false;
      try { await renderWithLayout(engine, designer + '.nonexistent'); } catch { combinedThrew = true; }
      if (!combinedThrew) throw new Error('renderWithLayout should reject a non-existent designer file (parity with renderDesigner)');
      console.log('e2e: combined render+layout error-parity verified — non-existent file rejected');

      // directional perf (LOG ONLY, not an assertion — timing is environment-dependent): one combined RPC
      // vs the two separate RPCs over N warm iterations. The win = the 2nd LoadGraph (parse+resolve+
      // BeginLoad+Interpret) the separate path repeats; it grows with control count, so SampleForm (9
      // controls) is a floor. Confirms the fold is at worst a wash on a tiny form and never a regression.
      {
        const N = 20;
        const med = (xs: number[]): number => { const s = xs.slice().sort((a, b) => a - b); return s[s.length >> 1]; };
        const cMs: number[] = [], sMs: number[] = [];
        for (let i = 0; i < N; i++) {
          let t = process.hrtime.bigint();
          await renderWithLayout(engine, designer);
          cMs.push(Number(process.hrtime.bigint() - t) / 1e6);
          t = process.hrtime.bigint();
          await Promise.all([renderDesigner(engine, designer), describeLayout(engine, designer)]);
          sMs.push(Number(process.hrtime.bigint() - t) / 1e6);
        }
        console.log(`e2e: combined-RPC timing (SampleForm, ${N} warm iters, median) — combined ${med(cMs).toFixed(1)}ms vs separate ${med(sMs).toFixed(1)}ms (delta = avoided 2nd graph load; floor, grows with form size)`);
      }

      // design-surface Visible semantics: ControlDesigner SHADOWS Visible, so a design-time Visible=false
      // control still renders on the surface (and stays selectable) just like in Visual Studio. The
      // layout must therefore KEEP it (and the render is unchanged). This pins that behavior so a future
      // "filter invisible controls" change can't silently make a painted control unselectable.
      const hiddenSrc = src.replace(
        'this.nameLabel = new System.Windows.Forms.Label();',
        'this.nameLabel = new System.Windows.Forms.Label();\n            this.nameLabel.Visible = false;',
      );
      if (hiddenSrc === src) throw new Error('hidden-control fixture: nameLabel ctor anchor not found');
      const tmpHidden = path.join(os.tmpdir(), `wfd-e2e-hidden-${process.pid}.Designer.cs`);
      fs.writeFileSync(tmpHidden, hiddenSrc, 'utf8');
      try {
        const hl = await describeLayout(engine, tmpHidden);
        if (!hl.controls.some((c) => c.id === 'nameLabel')) {
          throw new Error('layout should still include a design-time Visible=false control (it is shadowed & still painted)');
        }
        // and the render is byte-identical to the normal one (Visible=false is shadowed → still painted)
        const hiddenPng = await renderDesigner(engine, tmpHidden);
        if (!hiddenPng.equals(png)) {
          throw new Error('design-time Visible=false unexpectedly changed the render (should be shadowed on the surface)');
        }
        console.log('e2e: design-surface Visible-shadowing verified — Visible=false control still rendered & in the hit-test map (VS-like)');
      } finally {
        try { fs.unlinkSync(tmpHidden); } catch { /* ignore */ }
      }
    }

    // ---- TableLayoutPanel cell placement (Phase 2) ----
    // VS emits children via the 3-arg overload Controls.Add(child, column, row). The interpreter must honor the
    // cell or the children auto-flow and the form renders wrong (piled into the first cells). Assert the designed
    // grid: cellButton (col 1) sits RIGHT of cellLabel (col 0), and cellText (row 1) sits BELOW it.
    const tlpForm = path.join(repo, 'engine', 'samples', 'TableLayoutForm.Designer.cs');
    if (fs.existsSync(tlpForm)) {
      const tl = await describeLayout(engine, tlpForm);
      const lbl = tl.controls.find((c) => c.id === 'cellLabel');
      const btn = tl.controls.find((c) => c.id === 'cellButton');
      const txt = tl.controls.find((c) => c.id === 'cellText');
      if (!lbl || !btn || !txt) throw new Error('TLP: cell children missing from layout (3-arg Controls.Add not parented?)');
      if (btn.parentId !== 'tableLayoutPanel1' || lbl.parentId !== 'tableLayoutPanel1' || txt.parentId !== 'tableLayoutPanel1') {
        throw new Error('TLP: cell children should be parented into tableLayoutPanel1');
      }
      if (!(btn.x > lbl.x)) throw new Error(`TLP: cellButton (col 1) must be right of cellLabel (col 0): btn.x=${btn.x} lbl.x=${lbl.x}`);
      if (!(txt.y > lbl.y)) throw new Error(`TLP: cellText (row 1) must be below cellLabel (row 0): txt.y=${txt.y} lbl.y=${lbl.y}`);
      // ColumnStyles/RowStyles applied (slice c): col0 = ColumnStyle(Percent, 25) and row0 = RowStyle(Absolute, 40),
      // so the col0/col1 boundary (cellButton.x) sits well left of center and the row0/row1 boundary (cellText.y)
      // well above the middle — both ≈25-27%, not the ≈50% they'd be if the styles were dropped (equal-sized cells).
      const tlp = tl.controls.find((c) => c.id === 'tableLayoutPanel1');
      if (!tlp) throw new Error('TLP: tableLayoutPanel1 missing from layout');
      const colFrac = (btn.x - tlp.x) / tlp.width;
      const rowFrac = (txt.y - tlp.y) / tlp.height;
      if (!(colFrac < 0.4)) throw new Error(`TLP: ColumnStyle(Percent,25) not applied — col0/col1 boundary at ${(colFrac * 100).toFixed(0)}% (equal cells = 50%)`);
      if (!(rowFrac < 0.4)) throw new Error(`TLP: RowStyle(Absolute,40) not applied — row0/row1 boundary at ${(rowFrac * 100).toFixed(0)}% (equal cells = 50%)`);
      console.log(`e2e: TableLayoutPanel cells verified — 3-arg Controls.Add honored (btn right of lbl x ${btn.x}>${lbl.x}, txt below lbl y ${txt.y}>${lbl.y}); ColumnStyle/RowStyle applied (col0 ${(colFrac * 100).toFixed(0)}%, row0 ${(rowFrac * 100).toFixed(0)}% — not equal 50%)`);

      // grid-cell edit (slice b): the Column/Row extenders surface for a TLP child, and SetTableCell relocates it.
      const cellInfo = await describeComponent(engine, tlpForm, 'cellLabel');
      const colProp = cellInfo?.properties.find((p) => p.name === 'Column');
      const rowProp = cellInfo?.properties.find((p) => p.name === 'Row');
      if (!colProp || !rowProp) throw new Error('TLP: Column/Row extenders not surfaced for the cell child');
      if (!colProp.tableCell || !rowProp.tableCell) throw new Error('TLP: Column/Row must be flagged tableCell (edit-routing signal)');
      if (colProp.value !== '0' || rowProp.value !== '0') throw new Error(`TLP: cellLabel should start at col 0/row 0, got col=${colProp.value} row=${rowProp.value}`);
      const diskTlp = fs.readFileSync(tlpForm, 'utf8');
      // full move: cellLabel (0,0) → the empty bottom-right cell (1,1) — must shift right (col 1) AND down (row 1).
      const e1 = await setTableCell(engine, tlpForm, 'cellLabel', 1, 1, diskTlp);
      if (!e1.safe || e1.text === null) throw new Error('SetTableCell(cellLabel, 1, 1) rejected: ' + e1.reason);
      if (!e1.text.includes('this.cellLabel, 1, 1')) throw new Error('SetTableCell did not rewrite the cell args to (1, 1)');
      const ml = await describeLayout(engine, tlpForm, undefined, e1.text);
      const lbl2 = ml.controls.find((c) => c.id === 'cellLabel');
      if (!lbl2) throw new Error('TLP: cellLabel missing after cell move');
      if (!(lbl2.x > lbl.x + 40 && lbl2.y > lbl.y + 20)) throw new Error(`TLP: cellLabel should move to col1/row1: (${lbl.x},${lbl.y}) → (${lbl2.x},${lbl2.y})`);
      // partial edit (row = null keeps the existing row): cellText (0,1) → column 1, still row 1.
      const e2 = await setTableCell(engine, tlpForm, 'cellText', 1, null, diskTlp);
      if (!e2.safe || e2.text === null) throw new Error('SetTableCell(cellText, col=1, keep row) rejected: ' + e2.reason);
      if (!e2.text.includes('this.cellText, 1, 1')) throw new Error('SetTableCell partial (col-only) must keep the existing row → expected "this.cellText, 1, 1"');
      // §6.5 gate: reject a negative cell, and reject an unknown child (no matching 3-arg Add)
      if ((await setTableCell(engine, tlpForm, 'cellLabel', -1, null, diskTlp)).safe) throw new Error('SetTableCell must reject a negative column');
      if ((await setTableCell(engine, tlpForm, 'noSuchChild', 1, null, diskTlp)).safe) throw new Error('SetTableCell must reject an unknown child');
      console.log(`e2e: TableLayoutPanel grid-cell edit verified — Column/Row surfaced (tableCell); SetTableCell moved cellLabel (0,0)→(1,1) [(${lbl.x},${lbl.y})→(${lbl2.x},${lbl2.y})], partial col-only keeps row, negative & unknown rejected`);

      // §6.5 column/row SIZE-STYLE edit: read the 2 col + 2 row styles, then rewrite one style's args.
      const styles = await readTableStyles(engine, tlpForm, 'tableLayoutPanel1');
      if (!styles.found || styles.styles.length !== 4) throw new Error('TLP styles: expected 4 (2 col + 2 row), got ' + styles.styles.length);
      const sc0 = styles.styles.find((s) => s.axis === 'Column' && s.index === 0);
      const sr0 = styles.styles.find((s) => s.axis === 'Row' && s.index === 0);
      if (!sc0 || sc0.sizeType !== 'Percent' || Math.round(sc0.value) !== 25) throw new Error(`TLP styles: col0 should be Percent/25, got ${sc0?.sizeType}/${sc0?.value}`);
      if (!sr0 || sr0.sizeType !== 'Absolute' || Math.round(sr0.value) !== 40) throw new Error(`TLP styles: row0 should be Absolute/40, got ${sr0?.sizeType}/${sr0?.value}`);
      const diskTlp2 = fs.readFileSync(tlpForm, 'utf8');
      // edit col0 value 25 → 60 (keep Percent); only that ctor's args change, sibling col1 (75F) untouched.
      const st1 = await setTableStyle(engine, tlpForm, 'tableLayoutPanel1', 'Column', 0, null, 60, diskTlp2);
      if (!st1.safe || st1.text == null) throw new Error('SetTableStyle(col0 → 60%) rejected: ' + st1.reason);
      if (!/ColumnStyle\(System\.Windows\.Forms\.SizeType\.Percent,\s*60F\)/.test(st1.text)) throw new Error('SetTableStyle did not rewrite col0 to (Percent, 60F)');
      if (!st1.text.includes('75F')) throw new Error('SetTableStyle over-touched sibling column style (75F gone)');
      const reread = await readTableStyles(engine, tlpForm, 'tableLayoutPanel1', st1.text);
      const nc0 = reread.styles.find((s) => s.axis === 'Column' && s.index === 0);
      if (!nc0 || Math.round(nc0.value) !== 60) throw new Error('SetTableStyle: re-read col0 not 60');
      // the edited buffer still interprets: col0 now 60/(60+75) ≈ 44% → the col boundary shifts right of the prior ~26%.
      const styLay = await describeLayout(engine, tlpForm, undefined, st1.text);
      const sBtn = styLay.controls.find((c) => c.id === 'cellButton');
      const sTlp = styLay.controls.find((c) => c.id === 'tableLayoutPanel1');
      if (sBtn && sTlp) {
        const frac = (sBtn.x - sTlp.x) / sTlp.width;
        if (!(frac > 0.35)) throw new Error(`SetTableStyle: col0→60% should push the col boundary right (~44%), got ${(frac * 100).toFixed(0)}%`);
      }
      // change a Row style's TYPE Percent→AutoSize (drops the value arg → 1-arg ctor).
      const st2 = await setTableStyle(engine, tlpForm, 'tableLayoutPanel1', 'Row', 1, 'AutoSize', null, diskTlp2);
      if (!st2.safe || st2.text == null) throw new Error('SetTableStyle(row1 → AutoSize) rejected: ' + st2.reason);
      if (!/RowStyle\(System\.Windows\.Forms\.SizeType\.AutoSize\)/.test(st2.text)) throw new Error('SetTableStyle did not rewrite row1 to AutoSize (1-arg)');
      // the 1-arg AutoSize ctor still interprets (the engine builds the TLP from the edited buffer without error).
      const st2Lay = await describeLayout(engine, tlpForm, undefined, st2.text);
      if (!st2Lay.controls.find((c) => c.id === 'tableLayoutPanel1')) throw new Error('SetTableStyle: AutoSize-edited buffer failed to interpret');
      // no-op: re-applying a style's CURRENT value is a safe no-op (byte-identical), like SetTableCell/ResetProperty.
      const noop = await setTableStyle(engine, tlpForm, 'tableLayoutPanel1', 'Column', 0, 'Percent', 25, diskTlp2);
      if (!noop.safe || noop.text == null) throw new Error('SetTableStyle no-op (set current value) should be safe, got: ' + noop.reason);
      if (noop.text !== diskTlp2) throw new Error('SetTableStyle no-op should return byte-identical text');
      // §6.5 gate: out-of-range index, bogus size type, negative value — all rejected.
      if ((await setTableStyle(engine, tlpForm, 'tableLayoutPanel1', 'Column', 9, null, 10, diskTlp2)).safe) throw new Error('SetTableStyle must reject an out-of-range index');
      if ((await setTableStyle(engine, tlpForm, 'tableLayoutPanel1', 'Column', 0, 'Bogus', 10, diskTlp2)).safe) throw new Error('SetTableStyle must reject an invalid size type');
      if ((await setTableStyle(engine, tlpForm, 'tableLayoutPanel1', 'Column', 0, null, -5, diskTlp2)).safe) throw new Error('SetTableStyle must reject a negative value');
      console.log('e2e: TableLayoutPanel style edit verified — 4 styles read (col0 Percent/25, row0 Absolute/40); col0→60% rewrites only that ctor (sibling 75F intact) and re-flows the boundary right; row1→AutoSize drops the value arg; out-of-range/bad-type/negative rejected');
    } else {
      console.log('e2e: TableLayoutPanel cells SKIPPED — engine/samples/TableLayoutForm.Designer.cs missing');
    }

    // ---- Reset property (VS "Reset" / Dock↔Anchor mutual-exclusivity) ----
    // ResetProperty deletes a property's assignment(s) so it reverts to default. Nothing is interpolated — only
    // whole target-statement lines are removed, §6.5-gated (OnlyPropertyReset): ONLY the (comp, prop) assignments
    // may go, everything else must be byte-identical. panel1 carries a MULTI-LINE Anchor (cast + bitwise-or split
    // across 3 lines) among Location/Size/Name/TabIndex/Padding; btn2 carries both Dock and Anchor (the conjugate).
    const adForm = path.join(repo, 'engine', 'samples', 'AnchorDockForm.Designer.cs');
    if (fs.existsSync(adForm)) {
      const adDisk = fs.readFileSync(adForm, 'utf8');
      // (1) remove the multi-line panel1.Anchor; siblings and other controls stay intact.
      const r1 = await resetProperty(engine, adForm, 'panel1', 'Anchor', adDisk);
      if (!r1.safe || r1.text == null) throw new Error('ResetProperty(panel1, Anchor) rejected: ' + r1.reason);
      if (/this\.panel1\.Anchor\s*=/.test(r1.text)) throw new Error('ResetProperty must remove the panel1.Anchor assignment (all 3 lines)');
      if (!r1.text.includes('this.panel1.Padding') || !r1.text.includes('this.panel1.Size = new System.Drawing.Size(200, 100)')) {
        throw new Error('ResetProperty removed a NON-target panel1 statement (over-deleted)');
      }
      if (!/this\.btn2\.Anchor\s*=/.test(r1.text) || !/this\.btn2\.Dock\s*=/.test(r1.text)) throw new Error('ResetProperty must not touch other controls');
      // the buffer still parses + interprets, and Anchor is now default (no longer source-explicit)
      const desc = await describeComponent(engine, adForm, 'panel1', undefined, r1.text);
      const anchorP = desc?.properties.find((p) => p.name === 'Anchor');
      if (anchorP && anchorP.sourceExplicit) throw new Error('panel1.Anchor should not be source-explicit after reset');
      // (2) conjugate proof: resetting btn2.Dock removes ONLY the Dock line, leaving btn2.Anchor.
      const r2 = await resetProperty(engine, adForm, 'btn2', 'Dock', adDisk);
      if (!r2.safe || r2.text == null) throw new Error('ResetProperty(btn2, Dock) rejected: ' + r2.reason);
      if (/this\.btn2\.Dock\s*=/.test(r2.text)) throw new Error('ResetProperty must remove the btn2.Dock assignment');
      if (!/this\.btn2\.Anchor\s*=/.test(r2.text)) throw new Error('ResetProperty(Dock) must leave btn2.Anchor intact (conjugate)');
      // (3) no-op: resetting an already-default property is safe with mode "Noop" and no text (C# null → TS undefined).
      const r3 = await resetProperty(engine, adForm, 'panel1', 'Anchor', r1.text);
      if (!r3.safe) throw new Error('ResetProperty of an already-default property must be a safe no-op');
      if (r3.text != null || r3.mode !== 'Noop') throw new Error('ResetProperty no-op must return no text (mode Noop), got mode=' + r3.mode);
      const r4 = await resetProperty(engine, adForm, 'panel1', 'Nonexistent', adDisk);
      if (!r4.safe || r4.text != null) throw new Error('ResetProperty of an unset property must be a safe no-op');
      // (4) reject an invalid component identifier (guards against a crafted id reaching the gate).
      if ((await resetProperty(engine, adForm, 'bad id!', 'Anchor', adDisk)).safe) throw new Error('ResetProperty must reject an invalid component id');
      // (5) same-line DUPLICATE targets (hand-edited): both assignments share one physical line → identical
      //     whole-line span. The merge must delete that line EXACTLY ONCE (not twice) so following trivia — the
      //     KEEP comment — survives. (Adversarial review found the un-merged loop over-deleted the comment.)
      const dupBuf = [
        'namespace S { partial class F {',
        '    private System.Windows.Forms.Panel p;',
        '    private void InitializeComponent() {',
        '        this.p = new System.Windows.Forms.Panel();',
        '        this.p.Dock = System.Windows.Forms.DockStyle.Right; this.p.Dock = System.Windows.Forms.DockStyle.Left;',
        '        // KEEP THIS COMMENT LINE — long enough to be over-deleted by the stale-offset bug',
        '        this.p.Name = "p";',
        '        this.Controls.Add(this.p);',
        '    }',
        '} }',
        '',
      ].join('\n');
      const rDup = await resetProperty(engine, adForm, 'p', 'Dock', dupBuf);
      if (!rDup.safe || rDup.text == null) throw new Error('ResetProperty of same-line duplicate targets should still be safe: ' + rDup.reason);
      if (/this\.p\.Dock\s*=/.test(rDup.text)) throw new Error('ResetProperty must remove BOTH same-line Dock assignments');
      if (!rDup.text.includes('// KEEP THIS COMMENT LINE')) throw new Error('ResetProperty over-deleted the following comment (stale-offset bug not fixed)');
      if (!/this\.p\.Name\s*=\s*"p"/.test(rDup.text)) throw new Error('ResetProperty over-deleted the following statement');
      console.log('e2e: ResetProperty verified — panel1.Anchor (multi-line) removed with siblings + other controls intact; btn2.Dock reset leaves Anchor (conjugate); same-line duplicate removed once (following comment survives); no-op & invalid-id handled');
    } else {
      console.log('e2e: ResetProperty SKIPPED — engine/samples/AnchorDockForm.Designer.cs missing');
    }

    // ---- SplitContainer cell placement (slice e) ----
    // Children are added via a sub-container PROPERTY: splitContainer1.Panel1.Controls.Add(child). The interpreter
    // must walk the intermediate "Panel1"/"Panel2" segment and parent into the SplitterPanel (not the container,
    // which rejects a direct Controls.Add). The bug left both children piled at the form's client origin. Assert
    // they land in opposite panels and that SplitterDistance=120 took effect (boundary ~120, not the ~50% default).
    const splitForm = path.join(repo, 'engine', 'samples', 'SplitterForm.Designer.cs');
    if (fs.existsSync(splitForm)) {
      const sl = await describeLayout(engine, splitForm);
      const sc = sl.controls.find((c) => c.id === 'splitContainer1');
      const lb = sl.controls.find((c) => c.id === 'leftButton');
      const rl = sl.controls.find((c) => c.id === 'rightLabel');
      if (!sc || !lb || !rl) throw new Error('SplitContainer: controls missing from layout (Panel1/Panel2 Controls.Add not parented?)');
      if (!(rl.x - lb.x > 100)) throw new Error(`SplitContainer: children must sit in opposite panels (well apart), got lb.x=${lb.x} rl.x=${rl.x} (bug piles both at the form origin)`);
      if (!(lb.x - sc.x < 60)) throw new Error(`SplitContainer: leftButton should be near Panel1 left: lb.x=${lb.x} sc.x=${sc.x}`);
      if (!(rl.x - sc.x >= 120 && rl.x - sc.x < 170)) throw new Error(`SplitContainer: rightLabel should sit just past SplitterDistance=120, not the ~50% (≈198) default: rl.x-sc.x=${rl.x - sc.x}`);
      console.log(`e2e: SplitContainer verified — leftButton→Panel1 (x ${lb.x}), rightLabel→Panel2 (x ${rl.x}); SplitterDistance=120 applied (panel boundary ≈${rl.x - sc.x}px from container, not ~50%)`);
    } else {
      console.log('e2e: SplitContainer SKIPPED — engine/samples/SplitterForm.Designer.cs missing');
    }

    // ---- FlowLayoutPanel reorder (slice d) ----
    // A FlowLayoutPanel positions children by the order of their Controls.Add — exactly what MoveZOrder (gate
    // OnlyReordered) relocates. So "reorder a flow child" reuses the z-order path: Bring to Front moves a child's
    // Controls.Add first → it now flows first (leftmost). Verify the flow follows Add order and that MoveZOrder
    // (on a NON-root parent's child) re-flows it.
    const flowForm = path.join(repo, 'engine', 'samples', 'FlowForm.Designer.cs');
    if (fs.existsSync(flowForm)) {
      const diskFlow = fs.readFileSync(flowForm, 'utf8');
      const fb = await describeLayout(engine, flowForm);
      const a0 = fb.controls.find((c) => c.id === 'btnA');
      const c0 = fb.controls.find((c) => c.id === 'btnC');
      if (!a0 || !c0) throw new Error('Flow: btnA/btnC missing from layout');
      if (!(a0.x < c0.x)) throw new Error(`Flow: initial flow order should be A left of C: a=${a0.x} c=${c0.x}`);
      const moved = await moveZOrder(engine, flowForm, 'btnC', true, diskFlow);
      if (!moved.safe || moved.newText === null) throw new Error('Flow: MoveZOrder(btnC, front) rejected — a flow child (non-root parent) must reorder: ' + moved.reason);
      const fa = await describeLayout(engine, flowForm, undefined, moved.newText);
      const a1 = fa.controls.find((c) => c.id === 'btnA');
      const c1 = fa.controls.find((c) => c.id === 'btnC');
      if (!a1 || !c1) throw new Error('Flow: controls missing after reorder');
      if (!(c1.x < a1.x)) throw new Error(`Flow: after Bring-to-Front, btnC must flow before btnA: c=${c1.x} a=${a1.x}`);
      console.log(`e2e: FlowLayoutPanel reorder verified — flow follows Add order (A@${a0.x}<C@${c0.x}); MoveZOrder(front) re-flows btnC first (C@${c1.x}<A@${a1.x})`);
    } else {
      console.log('e2e: FlowLayoutPanel reorder SKIPPED — engine/samples/FlowForm.Designer.cs missing');
    }

    // ---- DataGridView + BindingSource resilience (§11 fragile fixtures golden) ----
    // DataGridView (Columns.AddRange + ISupportInitialize BeginInit/EndInit) and a tray BindingSource are
    // "fragile": full normalize-save can't round-trip them (BinaryFormatter/CodeDom limits) → safe=false. But the
    // INTERACTIVE path must work: the form renders, both columns + the binding source describe, the BindingSource
    // sits in the component tray, and a targeted property edit succeeds (the resilient path that skips full serialize).
    const gridForm = path.join(repo, 'engine', 'samples', 'GridForm.Designer.cs');
    if (fs.existsSync(gridForm)) {
      const gl = await renderWithLayout(engine, gridForm);
      if (!isPng(gl.png)) throw new Error('§11 GridForm did not render');
      for (const n of ['dataGridView1', 'nameColumn', 'valueColumn', 'bindingSource1']) {
        if (!(await describeComponent(engine, gridForm, n))) throw new Error('§11 GridForm: component dropped from describe: ' + n);
      }
      const glay = await describeLayout(engine, gridForm);
      const gtray = (glay as unknown as { tray?: Array<{ id: string }> }).tray || [];
      if (!gtray.some((t) => t.id === 'bindingSource1')) throw new Error('§11 GridForm: bindingSource1 should be in the component tray, not the visual layout');
      const gdisk = fs.readFileSync(gridForm, 'utf8');
      const ge = await setProperty(engine, gridForm, 'refreshButton', 'Text', '"Reload"', gdisk);
      if (!ge.safe || ge.text === null) throw new Error('§11 GridForm: a targeted edit must work even on a fragile form: ' + ge.reason);
      const gser = await serializeDesigner(engine, gridForm);
      console.log(`e2e: §11 fragile fixtures verified — GridForm renders (${gl.png.length}B), DataGridView columns + tray BindingSource described, targeted edit works, full-serialize degrades (safe=${gser.safe})`);
    } else {
      console.log('e2e: §11 fragile fixtures SKIPPED — engine/samples/GridForm.Designer.cs missing');
    }

    // ---- ToolStrip / .NET-9 serialize limit (graceful read-only, not a crash) ----
    // .NET 9 removed BinaryFormatter, which the CodeDom host serializer needs for ToolStrip/MenuStrip
    // resources. Such a form must still RENDER (it loads fine) and its full normalize-save must DEGRADE
    // to read-only (safe=false) — NOT throw out of the RPC (a throw would crash PreviewSave/
    // SerializeDesigner on any menu form). Pins the SerializeFromFile try/catch fallback.
    const menuForm = path.join(repo, 'engine', 'samples', 'MenuStripForm.Designer.cs');
    if (fs.existsSync(menuForm)) {
      const menuPng = await renderDesigner(engine, menuForm);
      if (!isPng(menuPng)) throw new Error('MenuStrip form should still render to a valid PNG');
      const menuSer = await serializeDesigner(engine, menuForm); // must NOT throw
      if (menuSer.safe !== false) throw new Error('ToolStrip serialize should degrade to read-only (safe=false), got safe=' + menuSer.safe);
      if (menuSer.code != null) throw new Error('an unsafe (read-only) serialize must return null/absent code'); // != catches null AND undefined (JSON omits the null field)
      console.log(`e2e: ToolStrip .NET-9 serialize guard verified — MenuStrip form renders (${menuPng.length}B), full-serialize degrades to read-only (no crash)`);
    } else {
      console.log('e2e: ToolStrip serialize guard SKIPPED — engine/samples/MenuStripForm.Designer.cs missing');
    }

    // ---- Events tab: enumerate events + parse wired handlers from the source ----
    // EventForm wires okButton.Click/MouseEnter and the form's Load. describeComponent must enumerate the
    // control's events (a long list) and report the handler method parsed from `+= new EventHandler(this.X)`.
    const eventForm = path.join(repo, 'engine', 'samples', 'EventForm.Designer.cs');
    if (fs.existsSync(eventForm)) {
      const okc = await describeComponent(engine, eventForm, 'okButton');
      const clickEv = okc?.events?.find((e) => e.name === 'Click');
      if (!clickEv) throw new Error('Events: okButton.Click not enumerated');
      if (clickEv.handler !== 'okButton_Click') throw new Error('Events: okButton.Click handler=' + clickEv.handler + ' (expected okButton_Click)');
      const unwired = okc?.events?.find((e) => e.name === 'Resize');
      if (!unwired || unwired.handler != null) throw new Error('Events: an unwired event must have no handler'); // != catches null AND undefined
      const formc = await describeComponent(engine, eventForm, 'this');
      const loadEv = formc?.events?.find((e) => e.name === 'Load');
      if (loadEv?.handler !== 'EventForm_Load') throw new Error('Events: form Load handler=' + loadEv?.handler + ' (expected EventForm_Load)');
      console.log(`e2e: Events tab verified — okButton ${okc?.events?.length} events (Click→okButton_Click), form Load→EventForm_Load, unwired→null`);

      // ---- create event handler (VS-style): wire an UNWIRED event + generate a signature-matching stub ----
      // Drive GenerateEventHandler against the unsaved buffers. okButton.MouseDown is unwired and uses a
      // NON-trivial delegate (MouseEventHandler) — proves the stub signature comes from delegate reflection,
      // not a hardcoded (object,EventArgs). The §6.5 gate must add EXACTLY one wiring statement, nothing else.
      const ecPath = path.join(repo, 'engine', 'samples', 'EventForm.cs');
      const dText = fs.readFileSync(eventForm, 'utf8');
      const cText = fs.existsSync(ecPath) ? fs.readFileSync(ecPath, 'utf8') : null;
      if (!cText) throw new Error('GenerateEventHandler: EventForm.cs code-behind fixture missing');

      const gen = await generateEventHandler(engine, eventForm, 'okButton', 'MouseDown', null, dText, cText, null);
      if (!gen.safe) throw new Error('GenerateEventHandler rejected: ' + gen.reason);
      if (gen.alreadyWired) throw new Error('GenerateEventHandler: MouseDown should be unwired');
      if (gen.handlerName !== 'okButton_MouseDown') throw new Error('GenerateEventHandler: handler name=' + gen.handlerName);
      const wireStmt = 'this.okButton.MouseDown += new System.Windows.Forms.MouseEventHandler(this.okButton_MouseDown);';
      if (!gen.designerText || gen.designerText.indexOf(wireStmt) < 0) throw new Error('GenerateEventHandler: wiring statement not added');
      const before = (dText.match(/\+= new /g) || []).length;
      const after = (gen.designerText.match(/\+= new /g) || []).length;
      if (after !== before + 1) throw new Error(`GenerateEventHandler §6.5: wiring count ${before}→${after} (expected +1)`);
      // tolerate the delegate's own parameter names (sender/e vs arg0/arg1) — assert the shape: a void method
      // named okButton_MouseDown taking an object and a MouseEventArgs.
      const stubRe = /private void okButton_MouseDown\(object \w+, System\.Windows\.Forms\.MouseEventArgs \w+\)/;
      if (!gen.stubCreated || !gen.codeText || !stubRe.test(gen.codeText)) {
        throw new Error('GenerateEventHandler: typed stub not generated; stubCreated=' + gen.stubCreated
          + ' reason="' + gen.reason + '" tail=' + JSON.stringify(gen.codeText ? gen.codeText.slice(-260) : null));
      }
      // the wired buffer must still render (the interpreter safely skips the += handler wiring)
      const wiredPng = await renderWithLayout(engine, eventForm, undefined, gen.designerText);
      if (!isPng(wiredPng.png)) throw new Error('GenerateEventHandler: form with the new wiring did not render');

      // an already-wired event whose handler already exists in the .cs → change nothing (just navigate)
      const gen2 = await generateEventHandler(engine, eventForm, 'okButton', 'Click', null, dText, cText, null);
      if (!gen2.safe || !gen2.alreadyWired) throw new Error('GenerateEventHandler: Click should be already-wired');
      if (gen2.handlerName !== 'okButton_Click') throw new Error('GenerateEventHandler: already-wired handler=' + gen2.handlerName);
      // != null catches both null and undefined (C# null serializes to an absent JSON-RPC field → undefined)
      if (gen2.designerText != null || gen2.codeText != null) throw new Error('GenerateEventHandler: already-wired + existing stub must change nothing');

      // §6.5: a non-identifier handler name (code-injection attempt) must be REJECTED, never interpolated.
      const inj = await generateEventHandler(engine, eventForm, 'okButton', 'MouseLeave', 'evil){}static void Pwn(){', dText, cText, null);
      if (inj.safe || inj.designerText != null || inj.codeText != null) throw new Error('GenerateEventHandler MUST reject a non-identifier handler name (injection): safe=' + inj.safe);
      console.log(`e2e: create-event-handler verified — okButton.MouseDown wired + typed stub generated (§6.5: +1 wiring only), wired form renders (${wiredPng.png.length}B), already-wired Click → no change, injection handler name rejected`);

      // ---- events dropdown (#2): compatible-handler candidates + wire/rewire/unwire ----
      const cands = await listHandlerCandidates(engine, eventForm, 'okButton', dText, cText, null);
      // Click is EventHandler(object,EventArgs) → all 3 fixture methods match
      if (!cands['Click'] || cands['Click'].indexOf('okButton_Click') < 0) throw new Error('ListHandlerCandidates: Click should list okButton_Click; got ' + JSON.stringify(cands['Click']));
      // MouseDown is MouseEventHandler(object,MouseEventArgs) → the fixture has no such method → no candidates
      // (proves PRECISE type matching, not arity-only — an (object,EventArgs) method must NOT be offered).
      if (cands['MouseDown'] && cands['MouseDown'].length) throw new Error('ListHandlerCandidates: MouseDown must not match EventArgs-only methods; got ' + JSON.stringify(cands['MouseDown']));

      // rewire Click → okButton_MouseEnter (existing compatible method) — only the Click RHS changes
      const rew = await setEventWiring(engine, eventForm, 'okButton', 'Click', 'okButton_MouseEnter', dText, cText, null);
      if (!rew.safe || !rew.designerText) throw new Error('SetEventWiring rewire rejected: ' + rew.reason);
      if (rew.designerText.indexOf('this.okButton.Click += new System.EventHandler(this.okButton_MouseEnter);') < 0) throw new Error('rewire did not point Click at okButton_MouseEnter');
      if (rew.designerText.indexOf('this.okButton.Click += new System.EventHandler(this.okButton_Click);') >= 0) throw new Error('rewire left the old Click handler');

      // unwire the form Load (wired to EventForm_Load) — the wiring line is removed
      const unw = await setEventWiring(engine, eventForm, 'this', 'Load', null, dText, cText, null);
      if (!unw.safe || !unw.designerText) throw new Error('SetEventWiring unwire rejected: ' + unw.reason);
      if (unw.designerText.indexOf('this.Load += ') >= 0) throw new Error('unwire did not remove the Load wiring');

      // wire an UNWIRED event (okButton.MouseLeave, EventHandler) to an existing compatible method
      const wir = await setEventWiring(engine, eventForm, 'okButton', 'MouseLeave', 'okButton_Click', dText, cText, null);
      if (!wir.safe || !wir.designerText || wir.designerText.indexOf('this.okButton.MouseLeave += new System.EventHandler(this.okButton_Click);') < 0) throw new Error('SetEventWiring wire-to-existing failed: ' + wir.reason);

      // refuse wiring to a method that doesn't exist in the code-behind (would not compile)
      const bad = await setEventWiring(engine, eventForm, 'okButton', 'MouseLeave', 'NoSuchMethod', dText, cText, null);
      if (bad.safe) throw new Error('SetEventWiring must refuse wiring to a non-existent handler method');
      console.log(`e2e: events dropdown verified — candidates by precise signature (Click→${cands['Click'].length}, MouseDown→none), rewire/unwire/wire-to-existing safe, missing method rejected`);
    } else {
      console.log('e2e: Events tab SKIPPED — engine/samples/EventForm.Designer.cs missing');
    }

    // ---- collection AddRange (ListView Columns) — representable + round-trip safe ----
    // The interpreter now executes Items/Columns.AddRange (resolve the collection, add each referenced
    // component), so a ListView form with columns is FULLY representable (round-trip safe) — previously
    // Columns.AddRange was unrepresentable → read-only. (ListView serializes cleanly on .NET 9.)
    const listViewForm = path.join(repo, 'engine', 'samples', 'ListViewForm.Designer.cs');
    if (fs.existsSync(listViewForm)) {
      const ser = await serializeDesigner(engine, listViewForm);
      if (ser.safe !== true) throw new Error('ListView Columns.AddRange should be round-trip safe; unrep: ' + ser.unrepresentable.join('; '));
      const lp = await renderDesigner(engine, listViewForm);
      if (!isPng(lp)) throw new Error('ListView form should render to a valid PNG');
      console.log(`e2e: collection AddRange verified — ListView Columns.AddRange representable, form round-trip safe (renders ${lp.length}B)`);
    } else {
      console.log('e2e: collection AddRange SKIPPED — engine/samples/ListViewForm.Designer.cs missing');
    }

    // ---- extender providers (ToolTip/ErrorProvider) ----
    // The interpreter recognizes the components container, the provider ctor new ToolTip(this.components),
    // and provider.SetToolTip(target, value) — so the form renders (tooltip wired) and is fully interpreted.
    // Full-serialize stays read-only (the CodeDom serializer's extender/tray path needs BinaryFormatter,
    // removed in .NET 9) but degrades gracefully — no crash.
    const extenderForm = path.join(repo, 'engine', 'samples', 'ExtenderForm.Designer.cs');
    if (fs.existsSync(extenderForm)) {
      const ep = await renderDesigner(engine, extenderForm);
      if (!isPng(ep)) throw new Error('extender form should render to a valid PNG');
      const tt = await describeComponent(engine, extenderForm, 'toolTip1');
      if (!tt) throw new Error('extender: toolTip1 provider was not interpreted (ctor with components container)');
      // component tray (§7.3): the non-visual ToolTip provider appears in the tray, not the visual layout
      const exLayout = await describeLayout(engine, extenderForm);
      if (!exLayout.tray.some((t) => t.id === 'toolTip1')) {
        throw new Error('§7.3 tray: toolTip1 should be in the component tray: ' + JSON.stringify(exLayout.tray));
      }
      if (exLayout.controls.some((c) => c.id === 'toolTip1')) throw new Error('§7.3: a non-visual component must NOT be in the visual layout');
      const es = await serializeDesigner(engine, extenderForm);
      if (es.safe !== false) throw new Error('extender serialize should degrade to read-only on .NET 9 (BinaryFormatter)');
      // §7.3 delete-tray: RemoveControl removes a NON-visual tray component (its field + ctor + SetToolTip wiring),
      // and the control it provided a tooltip for (helpButton) survives — the engine side of "delete from the tray".
      const exDisk = fs.readFileSync(extenderForm, 'utf8');
      const rmTray = await removeControl(engine, extenderForm, 'toolTip1', exDisk);
      if (!rmTray.safe || rmTray.newText == null) throw new Error('§7.3 delete-tray: RemoveControl(toolTip1) rejected: ' + rmTray.reason);
      if (/\btoolTip1\b/.test(rmTray.newText)) throw new Error('§7.3 delete-tray: toolTip1 field/statements/wiring not fully removed');
      if (!/\bhelpButton\b/.test(rmTray.newText)) throw new Error('§7.3 delete-tray: the provided-to control (helpButton) must survive');
      const trayGone = await describeLayout(engine, extenderForm, undefined, rmTray.newText);
      if (trayGone.tray.some((t) => t.id === 'toolTip1')) throw new Error('§7.3 delete-tray: toolTip1 still in tray after removal');
      if (!trayGone.controls.some((c) => c.id === 'helpButton')) throw new Error('§7.3 delete-tray: helpButton missing after tray removal');
      console.log(`e2e: extender providers verified — ToolTip/SetToolTip interpreted & rendered (${ep.length}B), in tray (§7.3), serialize degrades read-only; delete-tray removes toolTip1 (helpButton survives)`);
    } else {
      console.log('e2e: extender providers SKIPPED — engine/samples/ExtenderForm.Designer.cs missing');
    }
    // §6.5 safety: the extender ctor relaxation is gated to `new T(this.<components>)` ONLY — a non-container
    // ctor arg is still a hand-edit → unrepresentable (must not silently create + drop state).
    {
      const src6 = fs.readFileSync(designer, 'utf8');
      const hostile = src6.replace('this.okButton = new System.Windows.Forms.Button();', 'this.okButton = new System.Windows.Forms.Button(this.nameTextBox);');
      if (hostile === src6) throw new Error('§6.5 fixture: okButton ctor anchor not found');
      const tmpH = path.join(os.tmpdir(), `wfd-e2e-ctorarg-${process.pid}.Designer.cs`);
      fs.writeFileSync(tmpH, hostile, 'utf8');
      try {
        const hs = await serializeDesigner(engine, tmpH);
        if (hs.safe !== false) throw new Error('§6.5: a non-container ctor arg must NOT be round-trip safe');
        if (!hs.unrepresentable.some((u) => u.includes('ctor args'))) throw new Error('§6.5: ctor-arg hand-edit should be flagged unrepresentable; got: ' + hs.unrepresentable.join('; '));
        console.log('e2e: §6.5 safety preserved — a non-container ctor arg is still flagged unrepresentable (extender relaxation is narrow)');
      } finally {
        try { fs.unlinkSync(tmpH); } catch { /* ignore */ }
      }
    }

    // ---- render / edit from in-memory text (VS-style unsaved preview) ----
    // Pass a modified BUFFER (different ClientSize) without touching the file: the render must reflect the
    // buffer (not disk), describeComponent must read the buffer, setProperty must edit the buffer text, and
    // the file on disk must stay byte-identical. Proves the dirty-preview render/edit-from-text path.
    {
      const diskText = fs.readFileSync(designer, 'utf8');
      const bufText = diskText.replace('this.ClientSize = new System.Drawing.Size(354, 252);', 'this.ClientSize = new System.Drawing.Size(640, 480);');
      if (bufText === diskText) throw new Error('render-from-text fixture: ClientSize anchor not found');
      const fromDisk = await renderWithLayout(engine, designer);
      const fromBuf = await renderWithLayout(engine, designer, undefined, bufText);
      if (fromBuf.png.equals(fromDisk.png)) throw new Error('render-from-text: buffer render should differ from disk');
      if (fromBuf.clientWidth !== 640 || fromBuf.clientHeight !== 480) throw new Error(`render-from-text: buffer ClientSize not applied (${fromBuf.clientWidth}x${fromBuf.clientHeight})`);
      const bufText2 = diskText.replace('this.okButton.Text = "OK";', 'this.okButton.Text = "Buffered";');
      const okBuf = await describeComponent(engine, designer, 'okButton', undefined, bufText2);
      if (okBuf?.properties?.find((p) => p.name === 'Text')?.value !== 'Buffered') throw new Error('describeComponent from buffer did not see the buffered Text');
      const ed = await setProperty(engine, designer, 'okButton', 'Text', '"FromBuf"', bufText2);
      if (!ed.safe || ed.text === null || ed.text.indexOf('"FromBuf"') < 0) throw new Error('setProperty from buffer failed: ' + ed.reason);
      if (fs.readFileSync(designer, 'utf8') !== diskText) throw new Error('render/edit-from-text must NOT modify the file on disk');
      console.log('e2e: render/edit-from-text (unsaved preview) verified — buffer render differs from disk (640x480), describe & setProperty read the buffer, disk untouched');
    }

    // ---- toolbox auto-population (§7.2) — reflect framework controls, grouped by VS category ----
    {
      const items = await listToolboxItems(engine);
      if (items.length < 30) throw new Error(`listToolboxItems too small (${items.length}) — auto-population not working`);
      const byName = new Map(items.map((i) => [i.name, i]));
      for (const n of ['Button', 'Label', 'TextBox', 'TreeView', 'DataGridView', 'TabControl', 'NumericUpDown']) {
        const it = byName.get(n);
        if (!it) throw new Error('listToolboxItems missing ' + n);
        if (!it.fqn.startsWith('System.Windows.Forms.')) throw new Error(`toolbox item fqn wrong for ${n}: ${it.fqn}`);
        if (!it.category) throw new Error('toolbox item missing category: ' + n);
      }
      if (byName.get('Button')!.category !== 'Common Controls') throw new Error('Button miscategorized: ' + byName.get('Button')!.category);
      if (byName.get('TabControl')!.category !== 'Containers') throw new Error('TabControl miscategorized: ' + byName.get('TabControl')!.category);
      // toolbox icons (§7.2): each framework control carries its own [ToolboxBitmap] as a base64 PNG, and the
      // icons are control-specific (not one shared generic glyph) — assert presence + a valid PNG + distinctness.
      const PNG_B64 = 'iVBORw0KGgo'; // base64 of the PNG magic bytes (\x89PNG\r\n)
      for (const n of ['Button', 'Label', 'TextBox', 'TreeView']) {
        const ic = byName.get(n)!.iconPng;
        if (!ic || !ic.startsWith(PNG_B64)) throw new Error(`toolbox icon missing/!PNG for ${n}: ${ic ? ic.slice(0, 16) : '<none>'}`);
      }
      if (byName.get('Button')!.iconPng === byName.get('Label')!.iconPng) throw new Error('toolbox icons not control-specific (Button === Label)');
      // base/utility classes must NOT leak into the palette
      for (const bad of ['Control', 'ContainerControl', 'ScrollableControl', 'UserControl', 'Form']) {
        if (byName.has(bad)) throw new Error('listToolboxItems must not expose base/utility type ' + bad);
      }
      // a reflected (non-curated) control adds & renders; it emits NO explicit Size (runtime DefaultSize applies)
      const diskTb = fs.readFileSync(designer, 'utf8');
      const beforeTb = await describeLayout(engine, designer);
      const addTv = await addControl(engine, designer, 'this', 'TreeView', diskTb);
      if (!addTv.safe || addTv.newText === null) throw new Error('AddControl(TreeView) rejected: ' + addTv.reason);
      if (addTv.name !== 'treeview1') throw new Error('AddControl(TreeView) unexpected name: ' + addTv.name);
      if (addTv.newText.indexOf('this.treeview1 = new System.Windows.Forms.TreeView();') < 0) throw new Error('AddControl(TreeView) missing ctor statement');
      if (addTv.newText.indexOf('this.treeview1.Size') >= 0) throw new Error('AddControl(TreeView) should not emit an explicit Size (DefaultSize applies)');
      const afterTv = await renderWithLayout(engine, designer, undefined, addTv.newText);
      if (!isPng(afterTv.png)) throw new Error('AddControl(TreeView): form did not render');
      if (afterTv.controls.length !== beforeTb.controls.length + 1) throw new Error('AddControl(TreeView): expected +1 control');
      if (!afterTv.controls.some((c) => c.id === 'treeview1')) throw new Error('AddControl(TreeView): treeview1 not in layout');
      if (fs.readFileSync(designer, 'utf8') !== diskTb) throw new Error('AddControl(TreeView) must NOT modify disk');
      // regression guard: a control whose type name ENDS in "Container" (SplitContainer) must materialize —
      // not be swallowed by the `new System.ComponentModel.Container()` disposal-holder heuristic.
      const addSc = await addControl(engine, designer, 'this', 'SplitContainer', diskTb);
      if (!addSc.safe || addSc.newText === null) throw new Error('AddControl(SplitContainer) rejected: ' + addSc.reason);
      const afterSc = await renderWithLayout(engine, designer, undefined, addSc.newText);
      if (!afterSc.controls.some((c) => c.id === addSc.name)) {
        throw new Error(`AddControl(SplitContainer): ${addSc.name} missing from layout — swallowed by the Container heuristic`);
      }
      console.log(`e2e: toolbox §7.2 auto-population verified — ${items.length} controls in ${new Set(items.map((i) => i.category)).size} categories; TreeView add+render (no explicit Size) & SplitContainer materializes (not Container-swallowed)`);
    }

    // ---- toolbox non-visual components/dialogs + AddComponent (§7.2, F5 #4) ----
    {
      const items = await listToolboxItems(engine);
      const timer = items.find((i) => i.name === 'Timer');
      const dlg = items.find((i) => i.name === 'OpenFileDialog');
      if (!timer || !timer.isComponent || timer.category !== 'Components') throw new Error('toolbox: Timer should be a Components item flagged isComponent');
      if (!dlg || !dlg.isComponent || dlg.category !== 'Dialogs') throw new Error('toolbox: OpenFileDialog should be a Dialogs item flagged isComponent');
      // collection sub-items (ToolStrip items, DataGridView columns) must NOT leak into the palette
      for (const bad of ['ToolStripButton', 'ToolStripMenuItem', 'DataGridViewTextBoxColumn']) {
        if (items.some((i) => i.name === bad)) throw new Error('toolbox: collection sub-item leaked into the palette: ' + bad);
      }
      const diskSrc = fs.readFileSync(designer, 'utf8');
      const addT = await addComponent(engine, designer, 'Timer', diskSrc);
      if (!addT.safe || addT.newText === null) throw new Error('AddComponent(Timer) rejected: ' + addT.reason);
      if (!/private System\.Windows\.Forms\.Timer \w+;/.test(addT.newText)) throw new Error('AddComponent did not add a Timer field');
      if (!/this\.\w+ = new System\.Windows\.Forms\.Timer\((this\.components)?\);/.test(addT.newText)) throw new Error('AddComponent did not construct the Timer');
      // the new component lands in the component tray (and the form still renders), NOT the visual layout
      const lay = await describeLayout(engine, designer, undefined, addT.newText);
      const tray = (lay as unknown as { tray?: Array<{ id: string; type: string }> }).tray || [];
      if (!tray.some((t) => t.type.endsWith('Timer'))) throw new Error('AddComponent(Timer): the component must appear in the tray');
      if (lay.controls.some((c) => c.type.endsWith('Timer'))) throw new Error('AddComponent(Timer): a non-visual component must NOT be in the visual layout');
      // container fidelity: a form WITH an initialized `components` container sites the component in it (disposal)
      const gridFormP = path.join(repo, 'engine', 'samples', 'GridForm.Designer.cs');
      if (fs.existsSync(gridFormP)) {
        const addG = await addComponent(engine, gridFormP, 'Timer', fs.readFileSync(gridFormP, 'utf8'));
        if (!addG.safe || addG.newText === null) throw new Error('AddComponent(Timer) on GridForm rejected: ' + addG.reason);
        if (!/new System\.Windows\.Forms\.Timer\(this\.components\);/.test(addG.newText)) throw new Error('AddComponent should site the component in the form\'s existing components container (disposal fidelity)');
      }
      // gate: reject an unknown type and a visual control (Button is not a tray component)
      if ((await addComponent(engine, designer, 'NotAComponent', diskSrc)).safe) throw new Error('AddComponent must reject an unknown component');
      if ((await addComponent(engine, designer, 'Button', diskSrc)).safe) throw new Error('AddComponent must reject a visual control (Button)');
      console.log(`e2e: toolbox components/dialogs verified — Timer/OpenFileDialog are tray components (isComponent), sub-items excluded; AddComponent(Timer) → field + new Timer(), lands in tray not layout, unknown/control rejected`);
    }

    // ---- add control (toolbox) — engine AddControl: field decl + InitializeComponent statements ----
    {
      const types = await listControlTypes(engine);
      if (types.indexOf('Button') < 0) throw new Error('listControlTypes missing Button: ' + JSON.stringify(types));
      const diskAdd = fs.readFileSync(designer, 'utf8');
      const beforeLayout = await describeLayout(engine, designer);
      const add = await addControl(engine, designer, 'this', 'Button', diskAdd);
      if (!add.safe || add.newText === null) throw new Error('AddControl rejected: ' + add.reason);
      if (add.name !== 'button1') throw new Error('AddControl unexpected name: ' + add.name);
      if (add.newText.indexOf('this.button1 = new System.Windows.Forms.Button();') < 0
        || add.newText.indexOf('this.Controls.Add(this.button1);') < 0
        || add.newText.indexOf('private System.Windows.Forms.Button button1;') < 0) {
        throw new Error('AddControl missing expected statements / field declaration');
      }
      // the added control must render AND appear in the layout (one more control than before)
      const afterAdd = await renderWithLayout(engine, designer, undefined, add.newText);
      if (!isPng(afterAdd.png)) throw new Error('AddControl: form with the new control did not render');
      if (afterAdd.controls.length !== beforeLayout.controls.length + 1) {
        throw new Error(`AddControl: control count ${beforeLayout.controls.length}→${afterAdd.controls.length} (expected +1)`);
      }
      if (!afterAdd.controls.some((c) => c.id === 'button1')) throw new Error('AddControl: button1 not in the hit-test layout');
      if (fs.readFileSync(designer, 'utf8') !== diskAdd) throw new Error('AddControl must NOT modify the file on disk');
      // toolbox drag&drop: a drop position (locX/locY) becomes the control's Location instead of the cascade
      const addAt = await addControl(engine, designer, 'this', 'Button', diskAdd, 50, 60);
      if (!addAt.safe || addAt.newText === null) throw new Error('AddControl(locX/locY) rejected: ' + addAt.reason);
      if (addAt.newText.indexOf('new System.Drawing.Point(50, 60)') < 0) throw new Error('AddControl did not place the control at the drop location (50, 60)');
      if (!isPng((await renderWithLayout(engine, designer, undefined, addAt.newText)).png)) throw new Error('AddControl(loc) form did not render');
      // §6.5 / robustness: a non-allowlisted type and an unknown parent are rejected
      const badType = await addControl(engine, designer, 'this', 'Process', diskAdd);
      if (badType.safe) throw new Error('AddControl must reject a non-allowlisted control type');
      const badParent = await addControl(engine, designer, 'noSuchParent', 'Button', diskAdd);
      if (badParent.safe) throw new Error('AddControl must reject an unknown parent');
      // ---- remove control (engine RemoveControl) ----
      // add → remove round-trips to the EXACT original bytes (the strongest correctness proof)
      const rem = await removeControl(engine, designer, add.name, add.newText);
      if (!rem.safe || rem.newText === null) throw new Error('RemoveControl rejected: ' + rem.reason);
      if (rem.newText !== diskAdd) throw new Error('RemoveControl: add→remove did not round-trip to the original bytes');
      // remove an existing leaf (okButton) → renders with one fewer control, others intact
      const remOk = await removeControl(engine, designer, 'okButton', diskAdd);
      if (!remOk.safe || remOk.newText === null) throw new Error('RemoveControl(okButton) rejected: ' + remOk.reason);
      const afterRemove = await renderWithLayout(engine, designer, undefined, remOk.newText);
      if (afterRemove.controls.some((c) => c.id === 'okButton')) throw new Error('RemoveControl: okButton still in the layout');
      if (afterRemove.controls.length !== beforeLayout.controls.length - 1) {
        throw new Error(`RemoveControl: control count ${beforeLayout.controls.length}→${afterRemove.controls.length} (expected -1)`);
      }
      // refuse the root form
      if ((await removeControl(engine, designer, 'this', diskAdd)).safe) throw new Error('RemoveControl must refuse the root form');
      // refuse a container WITH children: add a Panel, add a Button into it, then try to remove the Panel
      const withPanel = await addControl(engine, designer, 'this', 'Panel', diskAdd);
      const withChild = await addControl(engine, designer, withPanel.name, 'Button', withPanel.newText!);
      if ((await removeControl(engine, designer, withPanel.name, withChild.newText!)).safe) {
        throw new Error('RemoveControl must refuse a container with children');
      }
      console.log(`e2e: add/remove-control verified — add (${add.name}) renders +1 (→${afterAdd.controls.length}); remove round-trips to original bytes; remove leaf okButton → -1; refuse root & container-with-children; unknown type/parent rejected; disk untouched`);
    }

    // ---- copy / paste (clipboard) — engine CopyControl/PasteControl: clone field + statements, rename, offset ----
    {
      const diskCp = fs.readFileSync(designer, 'utf8');
      const beforeLayout = await describeLayout(engine, designer, undefined, diskCp);
      const cp = await copyControl(engine, designer, 'okButton', diskCp);
      if (!cp.safe || !cp.clip) throw new Error('CopyControl(okButton) rejected: ' + cp.reason);
      const ps = await pasteControl(engine, designer, cp.clip, 'this', diskCp);
      if (!ps.safe || ps.newText === null) throw new Error('PasteControl rejected: ' + ps.reason);
      if (ps.name !== 'button1') throw new Error('PasteControl unexpected name: ' + ps.name);
      if (ps.newText.indexOf('private System.Windows.Forms.Button button1;') < 0) throw new Error('paste missing field declaration');
      if (ps.newText.indexOf('this.button1 = new System.Windows.Forms.Button();') < 0) throw new Error('paste missing ctor statement');
      if (ps.newText.indexOf('this.button1.Name = "button1";') < 0) throw new Error('paste did not sync the Name property to the new field name');
      if (ps.newText.indexOf('this.button1.Text = "OK";') < 0) throw new Error('paste did not clone the Text property');
      if (ps.newText.indexOf('new System.Drawing.Point(158, 212)') < 0) throw new Error('paste did not offset the Location (150,204 → 158,212)');
      if (ps.newText.indexOf('this.Controls.Add(this.button1);') < 0) throw new Error('paste did not parent the clone into the form');
      // the clone renders, the original okButton survives, disk is untouched
      const afterPaste = await renderWithLayout(engine, designer, undefined, ps.newText);
      if (!isPng(afterPaste.png)) throw new Error('paste: form with the clone did not render');
      if (!afterPaste.controls.some((c) => c.id === 'button1')) throw new Error('paste: button1 not in the hit-test layout');
      if (!afterPaste.controls.some((c) => c.id === 'okButton')) throw new Error('paste: original okButton lost');
      if (afterPaste.controls.length !== beforeLayout.controls.length + 1) throw new Error('paste: expected +1 control');
      if (fs.readFileSync(designer, 'utf8') !== diskCp) throw new Error('copy/paste must NOT modify the file on disk');
      // copy refuses the root form and a container WITH children (optionsGroup holds optionA/optionB)
      if ((await copyControl(engine, designer, 'this', diskCp)).safe) throw new Error('CopyControl must refuse the root form');
      if ((await copyControl(engine, designer, 'optionsGroup', diskCp)).safe) throw new Error('CopyControl must refuse a container with children');
      if ((await pasteControl(engine, designer, 'not-json', 'this', diskCp)).safe) throw new Error('PasteControl must reject malformed clipboard data');
      // paste into a container: add an empty Panel, paste okButton into it
      const panel = await addControl(engine, designer, 'this', 'Panel', diskCp);
      const intoPanel = await pasteControl(engine, designer, cp.clip, panel.name, panel.newText!);
      if (!intoPanel.safe || intoPanel.newText === null) throw new Error('paste into container rejected: ' + intoPanel.reason);
      if (intoPanel.newText.indexOf(`this.${panel.name}.Controls.Add(this.${intoPanel.name});`) < 0) throw new Error('paste did not parent the clone into the panel');
      // SECURITY: the clip is not trusted (arrives raw over RPC). A crafted Fqn that injects a class member, a
      // statement with a side-effecting RHS, or a sibling reference must ALL be rejected (PascalCase clip keys).
      const craft = (fqn: string, name: string, statements: string[]) => JSON.stringify({ Fqn: fqn, Name: name, Statements: statements });
      const fqnInj = await pasteControl(engine, designer, craft('int Hack { get { return 0; } } private System.Windows.Forms.Button', 'x', ['this.x.Name = "x";']), 'this', diskCp);
      if (fqnInj.safe) throw new Error('PasteControl must reject a crafted Fqn that injects a class member');
      const stmtInj = await pasteControl(engine, designer, craft('System.Windows.Forms.Button', 'x', ['this.x.Tag = System.IO.File.ReadAllText("C:/secret.txt");']), 'this', diskCp);
      if (stmtInj.safe) throw new Error('PasteControl must reject a statement that calls into a non-designer type');
      const sibRef = await pasteControl(engine, designer, craft('System.Windows.Forms.Button', 'x', ['this.x.Tag = this.okButton;']), 'this', diskCp);
      if (sibRef.safe) throw new Error('PasteControl must reject a statement that references a sibling control');
      // AST-based rename must NOT corrupt a string literal that contains the text "this.<oldId>"
      const litClip = craft('System.Windows.Forms.Button', 'x', ['this.x = new System.Windows.Forms.Button();', 'this.x.Text = "see this.x now";']);
      const litPaste = await pasteControl(engine, designer, litClip, 'this', diskCp);
      if (!litPaste.safe || litPaste.newText === null) throw new Error('paste of a literal-bearing clip rejected: ' + litPaste.reason);
      if (litPaste.newText.indexOf('"see this.x now"') < 0 || litPaste.newText.indexOf('see this.button1 now') >= 0) throw new Error('AST rename corrupted a string literal containing "this.<id>"');
      console.log(`e2e: copy/paste verified — clone (${ps.name}) renames+offsets & renders (+1); original survives; refuse root/container/bad-clip; paste into a container parents; SECURITY: reject Fqn-injection, non-designer call, sibling-ref; AST rename preserves string literals; disk untouched`);
    }

    // ---- z-order (Bring to Front / Send to Back) — engine MoveZOrder: relocate Controls.Add among siblings ----
    {
      const diskZ = fs.readFileSync(designer, 'utf8');
      const beforeLayout = await describeLayout(engine, designer, undefined, diskZ);
      const addIdx = (text: string, id: string) => text.indexOf(`Controls.Add(this.${id});`);
      // Bring to Front → the control's Controls.Add precedes the first sibling's (nameLabel)
      const toFront = await moveZOrder(engine, designer, 'okButton', true, diskZ);
      if (!toFront.safe || toFront.newText === null) throw new Error('MoveZOrder(front) rejected: ' + toFront.reason);
      if (!(addIdx(toFront.newText, 'okButton') < addIdx(toFront.newText, 'nameLabel'))) throw new Error('Bring to Front did not move okButton before the first sibling Add');
      // Send to Back → the control's Controls.Add follows the last sibling's (cancelButton)
      const toBack = await moveZOrder(engine, designer, 'okButton', false, diskZ);
      if (!toBack.safe || toBack.newText === null) throw new Error('MoveZOrder(back) rejected: ' + toBack.reason);
      if (!(addIdx(toBack.newText, 'okButton') > addIdx(toBack.newText, 'cancelButton'))) throw new Error('Send to Back did not move okButton after the last sibling Add');
      // the reorder preserves the control SET (only the order of one Add changed) and still renders
      const afterZ = await renderWithLayout(engine, designer, undefined, toFront.newText);
      if (!isPng(afterZ.png) || afterZ.controls.length !== beforeLayout.controls.length) throw new Error('z-order changed the control set or broke the render');
      // no-op when already at the requested end, and refuse the root form
      if ((await moveZOrder(engine, designer, 'nameLabel', true, diskZ)).newText !== diskZ) throw new Error('Bring to Front of the front-most control should be a no-op');
      if ((await moveZOrder(engine, designer, 'cancelButton', false, diskZ)).newText !== diskZ) throw new Error('Send to Back of the back-most control should be a no-op');
      if ((await moveZOrder(engine, designer, 'this', true, diskZ)).safe) throw new Error('MoveZOrder must refuse the root form');
      // VISUAL proof the z-order actually affects painting: overlap two opaque buttons, then render the two
      // extreme orders — they must differ (the front button's face/text covers the back one).
      const locExpr = await convertValue(engine, 'System.Drawing.Point', '245, 204');
      const overlapped = await setProperty(engine, designer, 'okButton', 'Location', locExpr!, diskZ);
      if (!overlapped.safe || overlapped.text === null) throw new Error('z-order visual setup: could not overlap okButton onto cancelButton');
      const cancelFront = await moveZOrder(engine, designer, 'cancelButton', true, overlapped.text);
      const cancelBack = await moveZOrder(engine, designer, 'cancelButton', false, overlapped.text);
      const pngFront = (await renderWithLayout(engine, designer, undefined, cancelFront.newText!)).png;
      const pngBack = (await renderWithLayout(engine, designer, undefined, cancelBack.newText!)).png;
      if (pngFront.equals(pngBack)) throw new Error('z-order had no visual effect: cancelButton front vs back rendered identically');
      // guards: refuse when the Add shares a physical line with another statement, and when the container uses AddRange
      const tinyForm = (body: string) => `namespace T { partial class F {\n  private System.Windows.Forms.Button a;\n  private System.Windows.Forms.Button b;\n  private void InitializeComponent() {\n    this.a = new System.Windows.Forms.Button();\n    this.b = new System.Windows.Forms.Button();\n${body}\n  }\n}}`;
      const sharedLine = tinyForm('    this.Controls.Add(this.a); this.Controls.Add(this.b);');
      if ((await moveZOrder(engine, designer, 'a', false, sharedLine)).safe) throw new Error('MoveZOrder must refuse when the Add shares a line with another statement');
      const withAddRange = tinyForm('    this.Controls.AddRange(new System.Windows.Forms.Control[] { this.a });\n    this.Controls.Add(this.b);');
      if ((await moveZOrder(engine, designer, 'b', true, withAddRange)).safe) throw new Error('MoveZOrder must refuse a container that uses Controls.AddRange');
      console.log('e2e: z-order verified — front/back relocate the Controls.Add (front < first sibling, back > last); control set preserved; no-op at ends; refuse root; visual proof front≠back; refuse shared-line & AddRange containers');
    }

    // ---- §7.4 reparent: move a leaf control into a different container / back to the root ----
    {
      const rpDisk = fs.readFileSync(designer, 'utf8'); // SampleForm: okButton (root leaf), optionsGroup (container of optionA/optionB)
      const rp1 = await reparentControl(engine, designer, 'okButton', 'optionsGroup', rpDisk);
      if (!rp1.safe || rp1.newText == null) throw new Error('§7.4 reparent(okButton → optionsGroup) rejected: ' + rp1.reason);
      if (!/this\.optionsGroup\.Controls\.Add\(this\.okButton\)/.test(rp1.newText)) throw new Error('reparent: okButton not re-parented into optionsGroup');
      if (/this\.Controls\.Add\(this\.okButton\)/.test(rp1.newText)) throw new Error('reparent: the old root Controls.Add(okButton) must be gone');
      const rpLay = await describeLayout(engine, designer, undefined, rp1.newText);
      const okc = rpLay.controls.find((c) => c.id === 'okButton');
      if (!okc || okc.parentId !== 'optionsGroup') throw new Error(`reparent: okButton.parentId should reflow to optionsGroup, got ${okc?.parentId}`);
      // reverse the move (→ root) and confirm it reproduces the original file byte-for-byte (receiver-only edit).
      const rp2 = await reparentControl(engine, designer, 'okButton', 'this', rp1.newText);
      if (!rp2.safe || rp2.newText == null) throw new Error('§7.4 reparent(okButton → root) rejected: ' + rp2.reason);
      if (rp2.newText !== rpDisk) throw new Error('reparent there-and-back should reproduce the original bytes');
      // §6.5 gate refusals: the root, a self-parent, an unknown parent.
      if ((await reparentControl(engine, designer, 'this', 'optionsGroup', rpDisk)).safe) throw new Error('reparent must refuse the root form');
      if ((await reparentControl(engine, designer, 'okButton', 'okButton', rpDisk)).safe) throw new Error('reparent must refuse a self-parent');
      if ((await reparentControl(engine, designer, 'okButton', 'noSuchParent', rpDisk)).safe) throw new Error('reparent must refuse an unknown parent');
      // container-with-children (leaf-only): reparenting optionsGroup (holds optionA/optionB) even to the root is
      // refused by the leaf check (root skips the target-type check, so this exercises leaf-only directly).
      if ((await reparentControl(engine, designer, 'optionsGroup', 'this', rpDisk)).safe) throw new Error('reparent must refuse a container with children (leaf-only)');
      // review fix — the target must be a container that accepts a DIRECT child: a leaf Control (CheckBox) is refused.
      if ((await reparentControl(engine, designer, 'okButton', 'agreeCheck', rpDisk)).safe) throw new Error('reparent must refuse a non-container target (agreeCheck is a CheckBox)');
      if (fs.readFileSync(designer, 'utf8') !== rpDisk) throw new Error('reparent must not touch disk (buffer path)');
      // review fix (MED) — reparenting into a NON-Control tray field (ToolTip) is refused: it would emit
      // non-compiling `toolTip1.Controls.Add(...)`.
      const extForm = path.join(repo, 'engine', 'samples', 'ExtenderForm.Designer.cs');
      if (fs.existsSync(extForm)) {
        const extDisk2 = fs.readFileSync(extForm, 'utf8');
        if ((await reparentControl(engine, extForm, 'helpButton', 'toolTip1', extDisk2)).safe) throw new Error('reparent must refuse a non-Control (tray component) target — would not compile');
      }
      // review fix (LOW) / cycle-safety — a TableLayoutPanel's 3-arg cell children still make it a container, so
      // reparenting it (even to root) is refused by the robust leaf check.
      if (fs.existsSync(tlpForm)) {
        const tlpDisk2 = fs.readFileSync(tlpForm, 'utf8');
        if ((await reparentControl(engine, tlpForm, 'tableLayoutPanel1', 'this', tlpDisk2)).safe) throw new Error('reparent must refuse a TableLayoutPanel with 3-arg cell children (leaf-only/cycle-safe)');
      }
      console.log('e2e: §7.4 reparent verified — okButton → optionsGroup (parentId reflows) and back to root (byte-identical); refuses root/self/unknown/container-with-children/non-container target/non-Control tray target/TLP-cells; disk untouched');
    }

    // ---- group move (multi-select): chain setProperty(Location) over several controls (applyGroupMove core) ----
    {
      const disk0 = fs.readFileSync(designer, 'utf8');
      const groupIds = ['okButton', 'cancelButton'];
      const dxg = 7, dyg = 11;
      const readLoc = async (text: string, id: string): Promise<[number, number] | null> => {
        const comp = await describeComponent(engine, designer, id, undefined, text);
        const v = comp?.properties?.find((p) => p.name === 'Location')?.value;
        const parts = v ? v.split(',').map((n) => parseInt(n.trim(), 10)) : null;
        return parts && parts.length === 2 && parts.every((n) => Number.isFinite(n)) ? [parts[0], parts[1]] : null;
      };
      const orig: Record<string, [number, number]> = {};
      let gtext = disk0;
      for (const gid of groupIds) {
        const l = await readLoc(gtext, gid);
        if (!l) throw new Error(`group-move: ${gid} has no representable Location`);
        orig[gid] = l;
        const expr = await convertValue(engine, 'System.Drawing.Point', `${l[0] + dxg}, ${l[1] + dyg}`);
        if (expr === null) throw new Error('group-move: convertValue failed');
        const res = await setProperty(engine, designer, gid, 'Location', expr, gtext);
        if (!res.safe || res.text === null) throw new Error(`group-move: setProperty ${gid} rejected: ${res.reason}`);
        gtext = res.text; // chain the next edit over the updated buffer (like applyGroupMove)
      }
      for (const gid of groupIds) {
        const l = await readLoc(gtext, gid);
        if (!l || l[0] !== orig[gid][0] + dxg || l[1] !== orig[gid][1] + dyg) {
          throw new Error(`group-move: ${gid} Location ${l} != expected (${orig[gid][0] + dxg}, ${orig[gid][1] + dyg})`);
        }
      }
      const agreeBefore = await readLoc(disk0, 'agreeCheck');
      const agreeAfter = await readLoc(gtext, 'agreeCheck');
      if (JSON.stringify(agreeBefore) !== JSON.stringify(agreeAfter)) throw new Error('group-move: a non-selected control was moved');
      if (!isPng((await renderWithLayout(engine, designer, undefined, gtext)).png)) throw new Error('group-move: form did not render after the group move');
      if (fs.readFileSync(designer, 'utf8') !== disk0) throw new Error('group-move must NOT modify disk');
      console.log(`e2e: group-move (multi-select) verified — chained Location edits moved ${groupIds.length} controls by (${dxg}, ${dyg}), non-selected control untouched, form renders, disk untouched`);
    }

    // ---- MSBuild design-time resolver (auto-discovery for complex projects) ----
    // ComplexProject is multi-target (net8/net9-windows) with a <BaseOutputPath>build-out\</BaseOutputPath>
    // that redirects output OUT of bin/. The lightweight bin-search cannot find it (no bin/ dir); only the
    // MSBuild eval + TFM selection resolve it. Asserts ResolveAssembly returns the build-out net9 dll and
    // that the fixture invariant (no bin/) holds, so TFM-selection + custom-OutputPath has a regression test.
    const complexFixture = path.join(repo, 'samples', 'ComplexProject', 'MainForm.Designer.cs');
    const complexDll = path.join(repo, 'samples', 'ComplexProject', 'build-out', 'Debug', 'net9.0-windows', 'ComplexProject.dll');
    if (fs.existsSync(complexFixture) && fs.existsSync(complexDll)) {
      if (fs.existsSync(path.join(repo, 'samples', 'ComplexProject', 'bin'))) {
        throw new Error('fixture invariant broken: ComplexProject must have no bin/ dir (BaseOutputPath redirects output)');
      }
      const resolved = await resolveAssembly(engine, complexFixture);
      if (!resolved) throw new Error('ResolveAssembly returned null for the multi-target/custom-output fixture');
      if (path.normalize(resolved).toLowerCase() !== path.normalize(complexDll).toLowerCase()) {
        throw new Error(`ResolveAssembly: expected ${complexDll}, got ${resolved}`);
      }
      console.log(`e2e: MSBuild resolver verified — multi-target/custom-output fixture → ${resolved} (bin-search alone could not)`);
    } else {
      console.log('e2e: MSBuild resolver SKIPPED — build samples/ComplexProject (-f net9.0-windows -c Debug) to exercise it');
    }

    console.log('E2E RESULT: PASS — extension client renders, live-updates, edits properties (incl. Point/Size/Color/Font/Padding), renders single-control dirty-region patches, resolves complex-project output via MSBuild, and honors an explicit assembly override via the engine over named-pipe JSON-RPC');
  } finally {
    engine.dispose();
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('E2E RESULT: FAIL —', e instanceof Error ? e.message : e);
  process.exit(1);
});
