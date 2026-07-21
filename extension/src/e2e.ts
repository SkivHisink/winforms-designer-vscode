import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as zlib from 'zlib';
import { spawnSync } from 'child_process';
import { releaseCompiledAssembly, startEngine, ping, renderDesigner, renderControl, renderWithLayout, renderCompiledWithLayout, renderInterpretedWithLayout, describeDesigner, describeComponent, describeCompiledComponent, describeInterpretedComponent, setCompiledPropertyLive, describeLayout, serializeDesigner, previewSave, setProperty, setModifier, setTableCell, resetProperty, setImageResource, readTableStyles, setTableStyle, convertValue, getDesignerPalette, resolveAssembly, generateEventHandler, listHandlerCandidates, setEventWiring, addControl, addComponent, listControlTypes, listToolboxItems, removeControl, copyControl, pasteControl, moveZOrder, reparentControl, addTabPage, removeTabPage, listCollectionItems, setCollectionItems, listStringArray, setStringArray, listColumns, setColumns, listGridColumns, setGridColumns, listTreeNodes, setTreeNodes, TreeNodeItem, listToolStripItems, setToolStripItems, ToolStripItemModel, ToolStripItemBounds, serializeImageList, deserializeImageList, setCompiledImageListLive, setImageList, discardCompiledLive } from './engineClient';
import { findNearestCsproj, projectAssemblyName, csprojReferencesAssembly, projectReferencesAssembly, addReferenceToCsproj, resolveFrameworkOutput, resolveFrameworkOnlyOutput, multiTargetHasFramework } from './csprojRef';
import { categorizeUnrepresentable, diagnosticsSignature } from './renderDiagnostics';
import { isLocalizableDesigner } from './localizable';
import { chooseFormNoticeKind } from './formNotice';
import { hasBinaryResx, binaryResxKeys, binaryResxCount } from './binaryResx';
import { isByteLocalEdit, diffLines, changedLines } from './byteLocal';
import { refuseWhileRenderFailed } from './renderGate';
import { retainSelectionId } from './selection';
import { learnMoreUrl } from './learnMore';

/** Build the net48 ctx fixture on demand (it compiles the SAME engine/samples/ContextMenuForm.Designer.cs the net9
* ctx leg renders from source). Returns true if a usable DLL exists after the call. Rebuilds only when the DLL is
* missing or older than its inputs; any build failure (no net48 toolchain, locked output) → false, so the net48
* e2e leg SKIPS instead of failing (the suite stays green on a net9-only box). */
function ensureNet48Fixture(fixtureDir: string, fixtureDll: string, sampleFiles: string[]): boolean {
  try {
    const csproj = path.join(fixtureDir, 'Net48CtxFixture.csproj');
    if (!fs.existsSync(csproj)) return false;
    // staleness inputs: the csproj + every .cs companion in the fixture dir + every referenced sample (so adding a form
    // to the fixture, or editing any of them, forces a rebuild instead of serving a stale DLL).
    const companions = fs.readdirSync(fixtureDir).filter((f) => f.endsWith('.cs')).map((f) => path.join(fixtureDir, f));
    const inputs = [csproj, ...companions, ...sampleFiles].filter((f) => fs.existsSync(f));
    const newestInput = inputs.reduce((m, f) => Math.max(m, fs.statSync(f).mtimeMs), 0);
    if (fs.existsSync(fixtureDll) && fs.statSync(fixtureDll).mtimeMs >= newestInput) return true; // up to date
    const res = spawnSync('dotnet', ['build', fixtureDir, '-c', 'Release', '--nologo', '-v', 'q'], { encoding: 'utf8' });
    if (res.status !== 0) {
      console.error('[e2e] net48 fixture build failed (skipping net48 ctx leg): ' + ((res.stderr || res.stdout || res.error?.message || '').trim().split('\n').slice(-3).join(' | ')));
      return false;
    }
    return fs.existsSync(fixtureDll);
  } catch (e) {
    console.error('[e2e] net48 fixture build error (skipping): ' + (e as Error).message);
    return false;
  }
}

const isPng = (b: Buffer): boolean =>
  b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

/** Build a minimal valid PNG declaring the given IHDR dimensions (header-only decodable). Used to craft a
* "pixel bomb" (tiny file, huge declared dimensions) for the image-import DoS-guard regression test. */
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
  if (csprojReferencesAssembly(engineText, 'VendorControls')) throw new Error('csprojRef: false positive for an unreferenced assembly');
  // strong-named <Reference> (simple name before the comma) and <ProjectReference> path (file base name).
  if (!csprojReferencesAssembly('<Reference Include="MyControls, Version=1.0.0.0, Culture=neutral" />', 'MyControls')) throw new Error('csprojRef: strong-named Reference simple-name match broken');
  if (!csprojReferencesAssembly('<ProjectReference Include="..\\Lib\\MyControls.csproj" />', 'MyControls')) throw new Error('csprojRef: ProjectReference base-name match broken');

  // findNearestCsproj: walks up from engine/samples to engine/Engine.csproj, bounded by the repo root.
  const found = findNearestCsproj(path.join(repo, 'engine', 'samples'), repo);
  if (!found || path.normalize(found).toLowerCase() !== path.normalize(engineCsproj).toLowerCase()) throw new Error('csprojRef: findNearestCsproj did not locate engine/Engine.csproj, got ' + found);

  // addReferenceToCsproj: inserts a well-formed ItemGroup before the single </Project>, and the result then
  // reports the assembly as referenced (round-trip). Original content and the closing tag are preserved.
  const added = addReferenceToCsproj(engineText, 'VendorControls', '..\\Vendor\\bin\\VendorControls.dll');
  if (!/<Reference Include="VendorControls">/.test(added)) throw new Error('csprojRef: addReferenceToCsproj did not add the <Reference>');
  if (!/<HintPath>\.\.\\Vendor\\bin\\VendorControls\.dll<\/HintPath>/.test(added)) throw new Error('csprojRef: addReferenceToCsproj did not add the HintPath');
  if ((added.match(/<\/Project>/g) || []).length !== 1) throw new Error('csprojRef: addReferenceToCsproj must keep exactly one </Project>');
  if (added.indexOf(engineText.slice(0, engineText.lastIndexOf('</Project>'))) !== 0) throw new Error('csprojRef: addReferenceToCsproj altered the original body');
  if (!csprojReferencesAssembly(added, 'VendorControls')) throw new Error('csprojRef: added reference is not detected by csprojReferencesAssembly (round-trip)');
  // idempotent guard direction: XML special chars are escaped in the include name.
  if (addReferenceToCsproj('<Project></Project>', 'A&B', 'x.dll').indexOf('Include="A&amp;B"') < 0) throw new Error('csprojRef: include name is not XML-escaped');
  // EOL preservation: a CRLF project stays CRLF (no stray lone \n introduced by the insert).
  const crlf = '<Project Sdk="Microsoft.NET.Sdk">\r\n  <PropertyGroup>\r\n  </PropertyGroup>\r\n</Project>\r\n';
  const crlfOut = addReferenceToCsproj(crlf, 'X', 'x.dll');
  if (/[^\r]\n/.test(crlfOut)) throw new Error('csprojRef: addReferenceToCsproj introduced a lone \\n into a CRLF file');

  // A mostly-LF file with one stray CRLF must NOT gain CRLFs (snippet follows the majority LF).
  const mixed = '<Project>\r\n<PropertyGroup>\n</PropertyGroup>\n</Project>\n';
  const mixedOut = addReferenceToCsproj(mixed, 'M', 'm.dll');
  if ((mixedOut.match(/\r\n/g) || []).length !== (mixed.match(/\r\n/g) || []).length) throw new Error('csprojRef: mixed-EOL insert changed the CRLF count (should follow the majority LF)');

  // A trailing comment that contains "</Project>" must NOT divert the insert into the comment.
  const trailing = '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup />\n</Project>\n<!-- legacy </Project> -->\n';
  const trailingOut = addReferenceToCsproj(trailing, 'Z', 'z.dll');
  if (!csprojReferencesAssembly(trailingOut, 'Z')) throw new Error('csprojRef: reference not registered — insert diverted into a trailing comment');
  if (trailingOut.indexOf('<Reference Include="Z">') > trailingOut.indexOf('<!--')) throw new Error('csprojRef: <Reference> inserted after the root </Project> (into the trailing comment)');

  // projectReferencesAssembly resolves a <ProjectReference> to a project whose
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

  // ---- "Learn More Online" URL routing (bug: third-party types 404'd on learn.microsoft.com/dotnet/api) ----
  // A Microsoft/System type resolves to its .NET API reference page; a third-party type (DevExpress/Telerik/etc.) must
  // NOT hit /dotnet/api (that page 404s) — it routes to a web search; a blank/unknown name → the WinForms hub.
  {
    const btn = learnMoreUrl('System.Windows.Forms.Button');
    if (btn !== 'https://learn.microsoft.com/dotnet/api/system.windows.forms.button') throw new Error(`learnMore: a System type must hit the .NET API ref (got ${btn})`);
    if (learnMoreUrl('Microsoft.VisualBasic.PowerPacks.LineShape') !== 'https://learn.microsoft.com/dotnet/api/microsoft.visualbasic.powerpacks.lineshape') throw new Error('learnMore: a Microsoft.* type must hit the .NET API ref');
    const dx = learnMoreUrl('DevExpress.XtraTab.XtraTabControl');
    if (!dx.startsWith('https://www.bing.com/search?q=')) throw new Error(`learnMore: a third-party (DevExpress) type must route to a web search, not a 404'ing /dotnet/api page (got ${dx})`);
    if (dx.includes('/dotnet/api/')) throw new Error('learnMore: a DevExpress type must never build a /dotnet/api URL (it 404s)');
    if (learnMoreUrl('') !== 'https://learn.microsoft.com/dotnet/desktop/winforms/') throw new Error('learnMore: a blank type must fall back to the WinForms hub');
    if (learnMoreUrl('Button') !== 'https://learn.microsoft.com/dotnet/desktop/winforms/') throw new Error('learnMore: a bare (non-dotted) name must fall back to the WinForms hub');
    console.log('e2e: Learn More URL routing verified — System/Microsoft types → .NET API ref; DevExpress (third-party) → web search (no 404 /dotnet/api); blank/bare → WinForms hub');
  }

  // ---- T1.3 cross-runtime routing: framework-only output resolution + multi-target detection ----
  // A multi-target (net48;net9) project builds BOTH a net9 output (with a .deps.json sidecar) and a net48
  // output (no sidecar). resolveFrameworkOnlyOutput must pick the net48 one — the assembly the net48 compiled-
  // preview engine can load — even when the net9 output is NEWER; resolveFrameworkOutput stays freshest-overall.
  {
    const mt = fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-xrt-'));
    try {
      const csproj = path.join(mt, 'App.csproj'); // no <AssemblyName> → asm name derives from the file ("App")
      fs.writeFileSync(csproj, '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFrameworks>net48;net9.0-windows</TargetFrameworks></PropertyGroup></Project>');
      const net48Dir = path.join(mt, 'bin', 'Debug', 'net48');
      const net9Dir = path.join(mt, 'bin', 'Debug', 'net9.0-windows');
      fs.mkdirSync(net48Dir, { recursive: true });
      fs.mkdirSync(net9Dir, { recursive: true });
      const net48Dll = path.join(net48Dir, 'App.dll');
      const net9Dll = path.join(net9Dir, 'App.dll');
      fs.writeFileSync(net48Dll, 'MZ'); // net4x build — no sidecar
      fs.writeFileSync(net9Dll, 'MZ'); // .NET build — has a .deps.json sidecar
      fs.writeFileSync(path.join(net9Dir, 'App.deps.json'), '{}');
      // make the net9 output strictly NEWER so "freshest overall" ≠ "framework-only" — the case that would
      // wrongly route a vendor form to net9 without the framework-only resolver.
      const baseSec = fs.statSync(net48Dll).mtimeMs / 1000;
      fs.utimesSync(net48Dll, baseSec, baseSec);
      fs.utimesSync(net9Dll, baseSec + 10, baseSec + 10);

      const fwOnly = resolveFrameworkOnlyOutput(csproj);
      if (!fwOnly || path.normalize(fwOnly).toLowerCase() !== path.normalize(net48Dll).toLowerCase()) {
        throw new Error('csprojRef: resolveFrameworkOnlyOutput must pick the net48 (no-sidecar) output, got ' + fwOnly);
      }
      const freshest = resolveFrameworkOutput(csproj);
      if (!freshest || path.normalize(freshest).toLowerCase() !== path.normalize(net9Dll).toLowerCase()) {
        throw new Error('csprojRef: resolveFrameworkOutput must stay freshest-overall (net9), got ' + freshest);
      }

      // multiTargetHasFramework: a plural tag with >1 TFM incl. a net4x → true; pure-.NET multi-target, a
      // single-target net4x, and a single TFM in a plural tag → false.
      if (!multiTargetHasFramework('<Project><PropertyGroup><TargetFrameworks>net48;net9.0-windows</TargetFrameworks></PropertyGroup></Project>')) throw new Error('csprojRef: multiTargetHasFramework should be true for net48;net9.0-windows');
      if (multiTargetHasFramework('<Project><PropertyGroup><TargetFrameworks>net8.0;net9.0-windows</TargetFrameworks></PropertyGroup></Project>')) throw new Error('csprojRef: multiTargetHasFramework false positive (no .NET Framework TFM)');
      if (multiTargetHasFramework('<Project><PropertyGroup><TargetFramework>net48</TargetFramework></PropertyGroup></Project>')) throw new Error('csprojRef: multiTargetHasFramework must be false for a single-target net48 project');
      if (multiTargetHasFramework('<Project><PropertyGroup><TargetFrameworks>net48</TargetFrameworks></PropertyGroup></Project>')) throw new Error('csprojRef: multiTargetHasFramework must be false for a single TFM in a plural tag');
      // Comment-blindness — a commented-out <TargetFrameworks> must NOT be read as live config,
      // and a commented net48 leftover must not mask the real (pure-.NET) multi-target.
      if (multiTargetHasFramework('<!-- <TargetFrameworks>net48;net9.0-windows</TargetFrameworks> -->')) throw new Error('csprojRef: multiTargetHasFramework must ignore a commented-out <TargetFrameworks>');
      if (multiTargetHasFramework('<!-- old <TargetFrameworks>net48;net9.0-windows</TargetFrameworks> --><TargetFrameworks>net8.0;net9.0-windows</TargetFrameworks>')) throw new Error('csprojRef: multiTargetHasFramework must read the LIVE (pure-.NET) TFMs, not the commented net48 one');
      // A conditioned/attributed <TargetFrameworks Condition="…"> tag is still recognized.
      if (!multiTargetHasFramework("<TargetFrameworks Condition=\"'$(Config)'==''\">net48;net9.0-windows</TargetFrameworks>")) throw new Error('csprojRef: multiTargetHasFramework must handle a conditioned <TargetFrameworks> tag');

      // an unbuilt multi-target project → no framework output yet (drives the "build it" notice, not a switch).
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-xrt-empty-'));
      try {
        const c2 = path.join(empty, 'App.csproj');
        fs.writeFileSync(c2, '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFrameworks>net48;net9.0-windows</TargetFrameworks></PropertyGroup></Project>');
        if (resolveFrameworkOnlyOutput(c2) !== undefined) throw new Error('csprojRef: resolveFrameworkOnlyOutput should be undefined when nothing is built');
      } finally { try { fs.rmSync(empty, { recursive: true, force: true }); } catch { /* ignore */ } }

      console.log('e2e: T1.3 cross-runtime helpers verified — resolveFrameworkOnlyOutput picks the net48 (no-sidecar) output over a NEWER net9 one; resolveFrameworkOutput stays freshest-overall; multiTargetHasFramework true for net48;net9 + conditioned tag (false for pure-.NET multi-target / single-target / single-TFM-plural / commented-out block); unbuilt project → no framework output');
    } finally {
      try { fs.rmSync(mt, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // ---- T2.2 partial-render diagnostics: the engine's `unrepresentable` strings → categorized, actionable items ----
  // (pure/headless: mirrors what the canvas banner surfaces without a live webview). The three real shapes are a
  // statement wearing an "[Ex: unresolved type X]" jacket (missing type), a plain "[Ex: msg]" (init error), and a
  // bare refused statement (unsupported). Signatures are order-independent so the dismiss-latch survives re-renders.
  {
    const items = categorizeUnrepresentable([
      'this.numericUpDown1.Maximum = new decimal(new int[] { 500, 0, 0, 0 });  [InvalidOperationException: unresolved type decimal]',
      'this.grid1 = new Vendor.FancyGrid();  [TargetInvocationException: license check failed]',
      '((Acme.Licensing.ISupportInitialize)(this.button1)).BeginInit()',
    ' ', // blank → ignored
    'this.numericUpDown1.Maximum = new decimal(new int[] { 500, 0, 0, 0 }); [InvalidOperationException: unresolved type decimal]', // dup → collapsed
    ]);
    if (items.length !== 3) throw new Error('T2.2 categorize: expected 3 items (blank ignored, dup collapsed), got ' + items.length + ' → ' + JSON.stringify(items));
    const missing = items.find((i) => i.category === 'missingType');
    if (!missing || missing.detail !== 'decimal') throw new Error('T2.2 categorize: unresolved-type-in-jacket must be missingType detail=decimal, got ' + JSON.stringify(missing));
    // the statement legitimately contains '[' (new int[]); assert only the trailing "[…Exception: …]" jacket is gone
    if (/InvalidOperationException|unresolved type/.test(missing!.text)) throw new Error('T2.2 categorize: missingType text must be stripped of the exception jacket, got: ' + missing!.text);
    const init = items.find((i) => i.category === 'initError');
    if (!init || init.detail !== 'license check failed') throw new Error('T2.2 categorize: exception-without-unresolved-type must be initError detail=message, got ' + JSON.stringify(init));
    const unsupported = items.find((i) => i.category === 'unsupported');
    if (!unsupported || unsupported.detail !== '' || !/BeginInit/.test(unsupported.text)) throw new Error('T2.2 categorize: bare refused statement must be unsupported (no detail), got ' + JSON.stringify(unsupported));
    if (categorizeUnrepresentable([]).length !== 0 || categorizeUnrepresentable(undefined).length !== 0) throw new Error('T2.2 categorize: empty/undefined must yield []');
    // signature: order-independent + stable, and sensitive to the actual set (drives the dismiss latch)
    const sigA = diagnosticsSignature(items);
    const sigB = diagnosticsSignature([items[2], items[0], items[1]]);
    if (sigA !== sigB) throw new Error('T2.2 signature must be order-independent');
    if (sigA === diagnosticsSignature(items.slice(0, 2))) throw new Error('T2.2 signature must change when the problem set changes');

    // ---- csproj resolution edge cases ----
    // categorizer-0: a statement whose text contains a LITERAL "[XxxException: …]" before the real trailing jacket
    // must strip only the TAIL jacket (not the sibling literal) — greedy leading group anchors to the rightmost.
    const sib = categorizeUnrepresentable(['this.errLabel.Text = "[SqlException: connection failed]";  [NotSupportedException: converter missing]']);
    if (sib.length !== 1 || sib[0].category !== 'initError' || sib[0].detail !== 'converter missing') throw new Error('T2.2 categorize-0: sibling "[…Exception:]" literal must not hijack the jacket, got ' + JSON.stringify(sib));
    if (sib[0].text !== 'this.errLabel.Text = "[SqlException: connection failed]";') throw new Error('T2.2 categorize-0: only the trailing jacket must be stripped, sibling literal kept; got text=' + sib[0].text);
    // categorizer-1: an exception message that merely MENTIONS "unresolved type" as prose (not the engine's start/
    // parenthesized signal) stays initError, not missingType.
    const prose = categorizeUnrepresentable(['this.x.Init();  [InvalidOperationException: failed; unresolved type Foo was referenced]']);
    if (prose[0].category !== 'initError') throw new Error('T2.2 categorize-1: "unresolved type" as mid-message prose must stay initError, got ' + JSON.stringify(prose));
    // the genuine parenthesized bare form IS missing-type
    const paren = categorizeUnrepresentable(['cannot evaluate invocation (unresolved type) System.Foo']);
    if (paren[0].category !== 'missingType' || paren[0].detail !== 'System.Foo') throw new Error('T2.2 categorize-1: "(unresolved type) X" bare form must be missingType detail=X, got ' + JSON.stringify(paren));
    // categorizer-2: two DIFFERENT sets that a naive space-joined signature would collide must get DISTINCT signatures.
    const c1 = categorizeUnrepresentable(['foo  [SomeException: a b]']);
    const c2 = categorizeUnrepresentable(['foo a  [SomeException: b]']);
    if (diagnosticsSignature(c1) === diagnosticsSignature(c2)) throw new Error('T2.2 categorize-2: distinct sets must not collide in the signature');

    console.log('e2e: T2.2 render-diagnostics categorize verified — unresolved-type→missingType (jacket stripped), exception→initError (message), bare statement→unsupported; blank ignored + dup collapsed; empty/undefined→[]; signature order-independent, set-sensitive & collision-free; tail-anchored jacket (sibling "[Ex:]" literal kept); prose "unresolved type"→initError; "(unresolved type) X"→missingType');
  }

  // ---- 0.10.0 trust-floor: localizable-form detection (read-only refusal) ----
  // isLocalizableDesigner is the runtime-independent trust boundary that turns a [Localizable(true)] form into a
  // read-only preview (a property edit on such a form would splice a direct assignment that diverges from the .resx =
  // silent data loss). It is deliberately BROAD/fail-closed: it keys on the `ApplyResources(` CALL alone (the
  // ComponentResourceManager bulk-apply only a localizable form emits), NOT the manager declaration shape — so no
  // valid-C# declaration spelling can evade it (a false negative is the data-loss path). A false positive is a
  // harmless read-only refusal (the two-signal rule was defeated by a cross-file `global using`
  // alias, where the manager token never appears in the designer buffer).
  {
    // the real localizable fixture is detected…
    const locSrc = fs.readFileSync(path.join(repo, 'engine', 'samples', 'LocalizableForm.Designer.cs'), 'utf8');
    if (!isLocalizableDesigner(locSrc)) throw new Error('localizable: LocalizableForm fixture must be detected as localizable');
    if (!/resources\.ApplyResources\(this\.button1, "button1"\)/.test(locSrc)) throw new Error('localizable: fixture missing the ApplyResources anchor it is meant to exercise');
    // …and the sibling .resx actually holds the localized values (the divergence risk the read-only lock guards):
    // editing button1.Text in the designer would splice a .Designer.cs assignment while the real value lives HERE.
    const locResx = fs.readFileSync(path.join(repo, 'engine', 'samples', 'LocalizableForm.resx'), 'utf8');
    if (!/name="button1\.Text"/.test(locResx) || !/name="\$this\.ClientSize"/.test(locResx))
      throw new Error('localizable: fixture .resx must hold the localized values (button1.Text / $this.ClientSize)');

    // NEGATIVE: a resx-image form that uses only resources.GetObject(...) is NOT localizable (no ApplyResources).
    const imgSrc = fs.readFileSync(path.join(repo, 'engine', 'samples', 'ImageForm.Designer.cs'), 'utf8');
    if (/ApplyResources/.test(imgSrc)) throw new Error('localizable: ImageForm fixture unexpectedly contains ApplyResources — pick another negative');
    if (isLocalizableDesigner(imgSrc)) throw new Error('localizable: a GetObject-only (non-localizable) form must NOT be flagged');

    // NEGATIVE: a plain form with no ComponentResourceManager at all.
    if (isLocalizableDesigner(fs.readFileSync(path.join(repo, 'engine', 'samples', 'SampleForm.Designer.cs'), 'utf8')))
      throw new Error('localizable: a plain form must NOT be flagged');

    // POSITIVE — every valid-C# way to reach an ApplyResources call must be caught, because a false negative is the
    // silent-data-loss path. Crucially this includes the two the narrow decl-shape AND the two-signal (manager-token)
    // rules BOTH missed: a cross-file `global using` alias where the manager token never appears in
    // the DESIGNER BUFFER, and a verbatim `@ApplyResources` method spelling.
    const variants: Array<[string, string]> = [
      ['conventional', 'System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof(F));\n resources.ApplyResources(this.b, "b");'],
      ['renamed local', 'System.ComponentModel.ComponentResourceManager rm = new System.ComponentModel.ComponentResourceManager(typeof(F));\n rm.ApplyResources(this.b, "b");'],
      ['var inference', 'var resources = new System.ComponentModel.ComponentResourceManager(typeof(F));\n resources.ApplyResources(this.b, "b");'],
      ['cross-file global-using alias', 'CRM resources = new CRM(typeof(F));\n resources.ApplyResources(this.b, "b"); // alias `global using CRM = ...ComponentResourceManager;` lives in GlobalUsings.cs — the manager token is NOT in this buffer'],
      ['split decl/init', 'System.ComponentModel.ComponentResourceManager resources;\n resources = new System.ComponentModel.ComponentResourceManager(typeof(F));\n resources.ApplyResources(this.b, "b");'],
      ['verbatim @method', 'var resources = new System.ComponentModel.ComponentResourceManager(typeof(F));\n resources.@ApplyResources(this.b, "b");'],
      ['verbatim @id receiver', 'System.ComponentModel.ComponentResourceManager @resources = new System.ComponentModel.ComponentResourceManager(typeof(F));\n @resources.ApplyResources(this.b, "b");'],
      ['nullable', 'System.ComponentModel.ComponentResourceManager? resources = new System.ComponentModel.ComponentResourceManager(typeof(F));\n resources.ApplyResources(this.b, "b");'],
      ['unicode id + whitespace', 'var rés = new System.ComponentModel.ComponentResourceManager(typeof(F));\n rés . ApplyResources ( this.b , "b" ) ;'],
      // A comment BETWEEN `.` and `ApplyResources` is still a real call → must be caught
      // (the lexical strip collapses the comment to whitespace).
      ['comment-separated', 'var resources = new System.ComponentModel.ComponentResourceManager(typeof(F));\n resources./* generated */ApplyResources(this.b, "b");'],
      // Each is valid C# invoking the REAL ComponentResourceManager.ApplyResources.
      // (1) Unicode identifier escape: C# decodes `R`→'R', so `ApplyResources` IS ApplyResources.
      ['unicode-escaped method', 'var resources = new System.ComponentModel.ComponentResourceManager(typeof(F));\n resources.Apply\\u0052esources(this.b, "b");'],
      // C# removes Unicode FORMAT chars (Cf, e.g. U+200C ZWNJ) when comparing identifiers (§6.4.3),
      // so `ApplyResources` IS the identifier ApplyResources — decodeUnicodeEscapes must strip Cf too.
      ['unicode Cf (ZWNJ) inside method name', 'var resources = new System.ComponentModel.ComponentResourceManager(typeof(F));\n resources.Apply\\u200CResources(this.b, "b");'],
      // (2) Method-group indirection: the member access is `.ApplyResources;` (no call paren) — matched by \b, not \(.
      ['method-group indirection', 'var resources = new System.ComponentModel.ComponentResourceManager(typeof(F));\n System.Action<object,string> apply = resources.ApplyResources;\n apply(this.b, "b");'],
      // (3) A C# 11 raw string with an embedded quote must NOT desync the lexer into swallowing the later real call.
      ['raw-string-adjacent code', 'var resources = new System.ComponentModel.ComponentResourceManager(typeof(F));\n var d = """literal with a " quote""";\n resources.ApplyResources(this.b, "b");'],
      // (4) line terminators: a `//` comment must stop at EACH of C#'s five line terminators, not swallow the
      // code after it. \r (CR-only), plus the three Unicode separators C# also treats as line terminators
      // (U+0085 NEL, U+2028 LINE SEP, U+2029 PARAGRAPH SEP) — each followed by a real call must be detected.
      ['CR-only line comment before call', '// disabled-note\r resources.ApplyResources(this.b, "b");'],
      ['NEL (U+0085) line comment before call', '// note\u0085 resources.ApplyResources(this.b, "b");'],
      ['LSEP (U+2028) line comment before call', '// note\u2028 resources.ApplyResources(this.b, "b");'],
      ['PSEP (U+2029) line comment before call', '// note\u2029 resources.ApplyResources(this.b, "b");'],
      // A $-interpolated string EVALUATES its
      // `{…}` holes, so a call reachable from a hole (via a lambda) is executable code — the stripper must NOT
      // blank it. Both a raw interpolated string ($"""…""") and an ordinary one ($"…") must still be detected.
      ['interpolated raw-string hole', 'static string Run(System.Action a){ a(); return ""; }\n var value = $"""{Run(() => resources.ApplyResources(this.b, key))}""";'],
      ['interpolated string hole', 'var v = $"x {Run(() => resources.ApplyResources(this.b, key))} y";'],
      // A hole that contains a NESTED string literal — the outer $"…" scanner must
      // walk the hole (consuming "x") and NOT terminate at the hole's first inner quote (which would leave a
      // tail that blanks the real call). Verbatim-interpolated ($@"…") must behave the same.
      ['interpolated hole with nested string arg', 'var v = $"{Run("x", () => resources.ApplyResources(this.b, key))}";'],
      ['verbatim-interpolated hole with nested string', 'var v = $@"{Run("x", () => resources.ApplyResources(this.b, key))}";'],
      // exotic multi-$ raw interpolation whose hole nests a same-delimiter raw string can mis-terminate the
      // hole-aware scanner; the fail-closed safety net in isLocalizableDesigner (interpolation prefix +
      // ApplyResources mention → lock) must still catch it. Never appears in a real .Designer.cs; proves the
      // no-false-negative guarantee holds for EVERY interpolation input, not just the lexer's modelled cases.
      ['multi-$ raw, nested raw in hole (safety net)', 'var v = $$"""{{ var t = $"""y"""; resources.ApplyResources(this.b, key); }}""";'],
      // The same mis-terminated multi-$ hole PLUS a Unicode-escaped method name — the safety net's
      // ApplyResources word-match must run on the DECODED text, else `ApplyResources` slips through.
      ['multi-$ raw + nested raw + unicode-escaped method (safety net)', 'var v = $$"""{{ var t = $"""y"""; resources.Apply\\u0052esources(this.b, key); }}""";'],
    ];
    for (const [name, src] of variants) {
      if (!isLocalizableDesigner(src)) throw new Error('localizable: variant NOT detected (data-loss false negative): ' + name);
    }

    // NEGATIVE / edge (pure): empty/undefined/null; a ComponentResourceManager used ONLY for GetObject (no
    // ApplyResources call); and the two forms the RAW-text regex mis-flagged: a string
    // value that merely CONTAINS `.ApplyResources(` (a code-snippet label on a NORMAL form) and a commented-out
    // call. The lexical strip (ignore strings/comments) keeps those non-localizable.
    if (isLocalizableDesigner('') || isLocalizableDesigner(undefined) || isLocalizableDesigner(null))
      throw new Error('localizable: empty/undefined/null must be false');
    const getObjOnly = 'System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof(F));\n this.b.Image = ((System.Drawing.Image)(resources.GetObject("b.Image")));';
    if (isLocalizableDesigner(getObjOnly)) throw new Error('localizable: a ComponentResourceManager used only for GetObject must NOT be flagged');
    const stringSnippet = 'this.label1.Text = ".ApplyResources(";\n this.helpBox.Text = "call resources.ApplyResources(x, \\"y\\")";';
    if (isLocalizableDesigner(stringSnippet)) throw new Error('localizable: a code-snippet STRING VALUE containing .ApplyResources( must NOT flag a normal form read-only (over-lock)');
    const commentedOut = '// resources.ApplyResources(this.b, "b"); -- disabled\n /* resources.ApplyResources(this.c, "c"); */';
    if (isLocalizableDesigner(commentedOut)) throw new Error('localizable: a commented-out ApplyResources call must NOT flag');
    // Counterparts to the new positives — the fixes must not over-reach into false negatives elsewhere:
    // a call TEXT sitting inside a raw-string BODY is string data, not a call → must NOT flag.
    const rawStringBody = 'var s = """\n resources.ApplyResources(x, y);\n """;\n this.b.Name = "b";';
    if (isLocalizableDesigner(rawStringBody)) throw new Error('localizable: an ApplyResources call inside a raw-string BODY is string data, must NOT flag');
    // a CR-only commented-out call (comment ends at \r, nothing real after) must NOT flag.
    const crCommentedOut = '// resources.ApplyResources(this.b, "b");\r';
    if (isLocalizableDesigner(crCommentedOut)) throw new Error('localizable: a CR-only commented-out ApplyResources call must NOT flag');
    // \b precision: a LONGER identifier `.ApplyResourcesToChildren(` is a different method → must NOT flag (over-lock).
    const longerId = 'this.helper.ApplyResourcesToChildren(this.b);';
    if (isLocalizableDesigner(longerId)) throw new Error('localizable: a longer identifier (.ApplyResourcesToChildren) must NOT be matched by the \\b member-access regex');

    console.log('e2e: 0.10.0 localizable detection verified — LocalizableForm flagged (+ .resx holds the localized values); GetObject-only/plain forms not; ALL reach-the-call variants caught (var/cross-file-alias/split/@verbatim/nullable/unicode/comment-separated/unicode-escaped-method/method-group/raw-string-adjacent/CR-only-comment/NEL+LSEP+PSEP-comment/interpolated-raw-hole/interpolated-hole/nested-string-in-hole/verbatim-interpolated-hole/multi-$-raw-safety-net/multi-$-raw+unicode-safety-net); string-snippet + commented-out + raw-string-body + CR-commented + longer-identifier NOT flagged; empty/undefined/null→false');
  }

  // ---- 0.10.0 trust-floor S2/S3: #formNotice single-slot DOMINANT-kind selection (pure) ----
  // A form can be several at once: localizable (read-only lock), binaryResx (data-loss risk), inherited-base
  // (incomplete preview). The banner is single-slot; chooseFormNoticeKind returns the DOMINANT icon-kind by
  // precedence (localizable > binaryResx > inheritedBase) and the host composes the text from all true conditions
  // so no disclosure is hidden. Engine-gating (net9-only for binaryResx/inherited) is upstream.
  {
    // S2 pairs (binaryResx defaults false — the existing 2-arg call sites keep their meaning)
    if (chooseFormNoticeKind(true, true) !== 'localizableInherited') throw new Error('formNotice: localizable AND inherited → combined kind');
    if (chooseFormNoticeKind(true, false) !== 'localizable') throw new Error('formNotice: localizable-only → localizable');
    if (chooseFormNoticeKind(false, true) !== 'inheritedBase') throw new Error('formNotice: inherited-only → inheritedBase');
    if (chooseFormNoticeKind(false, false) !== null) throw new Error('formNotice: clean render → null (banner hidden)');
    // S3 binaryResx precedence
    if (chooseFormNoticeKind(false, false, true) !== 'binaryResx') throw new Error('formNotice: binaryResx-only → binaryResx');
    if (chooseFormNoticeKind(true, false, true) !== 'localizable') throw new Error('formNotice: localizable subsumes binaryResx (lock icon dominates)');
    if (chooseFormNoticeKind(false, true, true) !== 'binaryResx') throw new Error('formNotice: binaryResx (data-loss) outranks inherited (incomplete)');
    if (chooseFormNoticeKind(true, true, true) !== 'localizableInherited') throw new Error('formNotice: all three → localizableInherited (🔒), host appends binaryResx clause');
    // 1.0.0 — the 4th flag is `net48Preview`, the UNCONDITIONAL
    // "this canvas is your last build" disclosure. net48 forms stay editable, so it is NOT a read-only lock; it
    // outranks the two ⚠️ modern disclosures but not the localizable read-only lock. Order: localizable >
    // compiledPreview > binaryResx > inheritedBase.
    if (chooseFormNoticeKind(false, false, false, true) !== 'compiledPreview') throw new Error('formNotice: net48Preview-only → compiledPreview');
    if (chooseFormNoticeKind(false, false, true, true) !== 'compiledPreview') throw new Error('formNotice: compiledPreview outranks binaryResx (net48 never flags binaryResx anyway)');
    if (chooseFormNoticeKind(false, true, false, true) !== 'compiledPreview') throw new Error('formNotice: compiledPreview outranks inheritedBase');
    if (chooseFormNoticeKind(true, false, false, true) !== 'localizable') throw new Error('formNotice: localizable read-only lock subsumes the net48 disclosure');
    // REGRESSION GUARD: the pre-1.0 2-arg/3-arg call sites must keep their exact meaning — the new param defaults
    // false, so adding it cannot silently re-classify an existing caller.
    if (chooseFormNoticeKind(false, false) !== null) throw new Error('formNotice: clean render must stay null with the new param defaulted');
    if (chooseFormNoticeKind(false, true) !== 'inheritedBase') throw new Error('formNotice: 2-arg inherited-only must stay inheritedBase');
    if (chooseFormNoticeKind(false, false, true) !== 'binaryResx') throw new Error('formNotice: 3-arg binaryResx-only must stay binaryResx');
    console.log('e2e: 1.0.0 formNotice kind selection verified — localizable > compiledPreview > binaryResx > inheritedBase; localizable is the only 🔒 read-only lock, net48 compiledPreview is an ℹ️ editable disclosure, binaryResx/inheritedBase are ⚠️; pre-1.0 call sites unchanged');
  }

  // ---- 0.10.0 trust-floor S3: binary-resx host detector (pure) ----
  // hasBinaryResx keys on the SAME BinaryFormatter/SOAP mimetype substrings the engine's ScanBinaryKeys uses, so
  // host (write-guard) and engine (banner count) agree. It drives the fail-closed regenerate tripwire.
  {
    const binResx = fs.readFileSync(path.join(repo, 'engine', 'samples', 'BinaryResxForm.resx'), 'utf8');
    if (!hasBinaryResx(binResx)) throw new Error('binaryResx: BinaryResxForm.resx (ImageStream binary node) must be flagged');
    if (!binaryResxKeys(binResx).has('imageList1.ImageStream')) throw new Error('binaryResx: the ImageStream key must be detected by name');
    // NEGATIVE: a bytearray-image (Bitmap) resx is NOT binary/SOAP → must NOT flag (it renders fine).
    if (hasBinaryResx(fs.readFileSync(path.join(repo, 'engine', 'samples', 'ImageForm.resx'), 'utf8'))) throw new Error('binaryResx: a bytearray.base64 (Bitmap) resx must NOT be flagged');
    // NEGATIVE: a string-only (localizable) resx is not binary.
    if (hasBinaryResx(fs.readFileSync(path.join(repo, 'engine', 'samples', 'LocalizableForm.resx'), 'utf8'))) throw new Error('binaryResx: a string-only resx must NOT be flagged');
    if (hasBinaryResx(null) || hasBinaryResx('') || hasBinaryResx(undefined)) throw new Error('binaryResx: empty/null/undefined → not flagged');
    // The GUARD keys on binaryResxCount (mimetype-attr count), which must be robust where a name-keyed
    // scan could MISS a node — a '>' inside an attribute value, a nameless node, single quotes, uppercase mime,
    // duplicate names — so a DROP is always detected. Each of these has 2 binary nodes → count must be 2.
    const gt = '<data name="a>b" mimetype="application/x-microsoft.net.object.binary.base64"><value>x</value></data><data name="c" mimetype="application/x-microsoft.net.object.soap.base64"><value>y</value></data>';
    if (binaryResxCount(gt) !== 2) throw new Error(`binaryResx: count must be robust to '>' inside an attribute value + soap, got ${binaryResxCount(gt)}`);
    const nameless = "<data mimetype='application/x-microsoft.net.object.binary.base64'><value>x</value></data><data name='k' mimetype='APPLICATION/X-MICROSOFT.NET.OBJECT.BINARY.BASE64'/>";
    if (binaryResxCount(nameless) !== 2) throw new Error(`binaryResx: count must include nameless + uppercase + single-quote nodes, got ${binaryResxCount(nameless)}`);
    // A mimetype written with XML numeric character references (an XML parser decodes `binary&#x2e;base64`
    // to `binary.base64`) must still be counted — the host decodes char-refs before matching, so it agrees with the
    // engine's XML-parsed scan.
    const charRef = '<data name="cr" mimetype="application/x-microsoft.net.object.binary&#x2e;base64"><value>x</value></data>';
    if (binaryResxCount(charRef) !== 1) throw new Error(`binaryResx: a char-ref mimetype (binary&#x2e;base64) must be decoded + counted, got ${binaryResxCount(charRef)}`);
    // the guard's core inequality: dropping one binary node lowers the count → the tripwire refuses.
    const twoBin = binaryResxCount(gt);
    const oneBin = binaryResxCount(gt.replace(/<data name="c"[\s\S]*?<\/data>/, ''));
    if (!(twoBin - oneBin > 0)) throw new Error('binaryResx: dropping a binary node must lower the count (the tripwire refuse condition)');
    if (binaryResxCount(fs.readFileSync(path.join(repo, 'engine', 'samples', 'ImageForm.resx'), 'utf8')) !== 0) throw new Error('binaryResx: a bytearray-image resx must count 0 binary nodes');
    console.log('e2e: 0.10.0 S3 binary-resx host detector verified — BinaryResxForm(ImageStream) flagged; bytearray/string/empty not; binaryResxCount robust to >-in-value / nameless / uppercase / single-quote / duplicate, and a dropped binary node lowers the count (tripwire refuse)');
  }

  // ---- 0.10.0 trust-floor S4: byte-local edit firewall (pure) ----
  // Every persisted edit is a targeted net9 splice (net48 persists the SAME splice — it never writes source). The
  // commit() firewall refuses a persisted `after` that is NOT a confined edit of `before` — a whole-file
  // regenerate/reflow/EOL-normalize/reorder/total-deletion. COARSE by design: it must NEVER refuse a legit splice
  // (even a bulk delete or a collection replace that dominates the file) and MUST refuse a catastrophe.
  // isByteLocalEdit = churn-floor (<64 changed lines→allow) OR structural edges (head+tail survive→middle-confined
  // splice of any size) OR high-survival fallback (≥half of the larger side survives, non-empty).
  {
    const real = fs.readFileSync(path.join(repo, 'engine', 'samples', 'SampleForm.Designer.cs'), 'utf8');
    // no-op
    if (!isByteLocalEdit(real, real)) throw new Error('byteLocal: an identical buffer must be byte-local');
    // single-property splice → allowed; the changed region is ONLY the target line (not usings / field-decls)
    const oneLine = real.replace('this.nameTextBox.Text = "Ada Lovelace";', 'this.nameTextBox.Text = "Grace Hopper";');
    if (oneLine === real) throw new Error('byteLocal: test setup — the one-line replacement did not match the fixture');
    if (!isByteLocalEdit(real, oneLine)) throw new Error('byteLocal: a one-line property splice must be byte-local');
    const d1 = diffLines(real, oneLine);
    if (d1.commonLines < d1.beforeLines - 2) throw new Error(`byteLocal: a one-line splice must keep ~all lines, got common=${d1.commonLines}/${d1.beforeLines}`);
    const ch = changedLines(real, oneLine);
    if (!ch.inserted.some((l) => l.includes('Grace Hopper')) || ch.inserted.some((l) => l.includes('namespace ') || l.includes('private System.')))
      throw new Error('byteLocal: the changed region must be ONLY the target line (a tight splice, not a rewrite)');
    // disjoint 2-span (add-control: a field-decl AND an InitializeComponent statement) → allowed (NOT single-span)
    let added = real.replace('private System.Windows.Forms.Button cancelButton;', 'private System.Windows.Forms.Button cancelButton;\n        private System.Windows.Forms.Button extraButton;');
    added = added.replace('this.Controls.Add(this.cancelButton);', 'this.Controls.Add(this.cancelButton);\n            this.Controls.Add(this.extraButton);');
    if (added === real) throw new Error('byteLocal: test setup — the add-control 2-span edit did not match');
    if (!isByteLocalEdit(real, added)) throw new Error('byteLocal: a disjoint 2-span add-control splice must be byte-local (the false-positive trap — must NOT be single-span)');
    // synthetic large designer with a realistic HEADER + FOOTER (a real edit is always in the middle — it never
    // touches the usings/namespace/class open or the closing braces), so the structural edge check is exercised faithfully.
    const hdr = ['using System.Windows.Forms;', 'namespace Demo', '{', '  partial class Big : Form', '  {', '    private void InitializeComponent()', '    {'];
    const ftr = ['    }', '  }', '}'];
    const body = (tag: string) => Array.from({ length: 500 }, (_, i) => `      this.ctl${i}.Text = "${tag}${i}";`);
    const big = [...hdr, ...body('a'), ...ftr].join('\n');
    const wrap = (mid: string[]) => [...hdr, ...mid, ...ftr].join('\n');
    // 50-hunk group op (every 10th BODY line) → head+tail survive → ALLOWED (predicate NOT too strict for a big multi-select)
    if (!isByteLocalEdit(big, wrap(body('a').map((l, i) => (i % 10 === 0 ? l.replace(/"a\d+"/, '"z"') : l))))) throw new Error('byteLocal: a 50-hunk group op (head+tail preserved) must be ALLOWED — the predicate must not refuse a large multi-select');
    // BULK DELETE (delete 70% of the controls, keeping the class shell) → head+tail survive → ALLOWED.
    if (!isByteLocalEdit(big, wrap(body('a').slice(0, 150)))) throw new Error('byteLocal: a bulk delete (head+tail preserved) must be ALLOWED — not a whole-file rewrite');
    // LARGE IN-PLACE BLOCK REPLACE (replace a 300-line collection block that DOMINATES the body, e.g. TreeView.Nodes /
    // DataGridView.Columns) → before ≈ after, >50% churn, but head+tail survive → ALLOWED via the structural edge check.
    if (!isByteLocalEdit(big, wrap([...body('a').slice(0, 100), ...Array.from({ length: 300 }, (_, i) => `      this.NEW${i}.Text = "x";`), ...body('a').slice(400)]))) throw new Error('byteLocal: a large in-place block replace (head+tail preserved) must be ALLOWED — a collection that dominates the file is still a confined middle edit');
    // whole-file reindent (EVERY line differs, incl. the header) → REFUSED
    if (isByteLocalEdit(big, big.split('\n').map((l) => '    ' + l).join('\n'))) throw new Error('byteLocal: a whole-file reindent must be REFUSED (every line differs, header included)');
    // whole-file CRLF→LF normalization → REFUSED
    if (isByteLocalEdit(big.split('\n').join('\r\n'), big)) throw new Error('byteLocal: a whole-file CRLF→LF normalization must be REFUSED');
    // whole-file reorder (reverse — header becomes footer) → REFUSED (edges destroyed + low survival)
    if (isByteLocalEdit(big, big.split('\n').reverse().join('\n'))) throw new Error('byteLocal: a whole-file reorder must be REFUSED (edges destroyed)');
    // small-file high-FRACTION edit (12/20 lines) but low COUNT (churn 24 < 64) → allowed (the churn floor)
    const small = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    if (!isByteLocalEdit(small, small.split('\n').map((l, i) => (i < 12 ? l + ' X' : l)).join('\n'))) throw new Error('byteLocal: a small-file edit (churn < 64) must be allowed even at a high changed-fraction');
    // A COMPACTED designer whose head+tail are each a SINGLE physical line (all usings/class on line 1) — a
    // middle-only collection replace keeps commonPrefix=1 AND commonSuffix=1 → ALLOWED (EDGE_LINES=1, not 2).
    const compactBefore = ['namespace D; partial class F { private System.Windows.Forms.ComboBox c = new(); private void InitializeComponent() { c.Items.AddRange(new object[] {',
      ...Array.from({ length: 70 }, (_, i) => `    "old-${i}",`), '}); } }'].join('\n');
    const compactAfter = ['namespace D; partial class F { private System.Windows.Forms.ComboBox c = new(); private void InitializeComponent() { c.Items.AddRange(new object[] {',
      ...Array.from({ length: 70 }, (_, i) => `    "new-${i}",`), '}); } }'].join('\n');
    if (!isByteLocalEdit(compactBefore, compactAfter)) throw new Error('byteLocal: a compacted single-physical-line-head/tail collection replace must be ALLOWED');
    // Deleting the ENTIRE designer text (after empty) must be REFUSED — the min() denominator made survival
    // trivially true (0>=0); the max() denominator + afterLines>0 guard refuse it.
    if (isByteLocalEdit(big, '')) throw new Error('byteLocal: deleting the WHOLE file must be REFUSED (not byte-local)');
    if (isByteLocalEdit(big, '}')) throw new Error('byteLocal: truncating the whole file to a single line must be REFUSED');
    console.log('e2e: 0.10.0 S4 byte-local firewall verified — no-op / one-line-splice(tight) / disjoint-2-span / 50-hunk-group / bulk-delete / large-block-replace / compact-collection-replace ALLOWED; reindent / CRLF-normalize / reorder / delete-whole-file / truncate-to-line REFUSED; small-file(churn floor) allowed (EDGE=1 + max()-denominator + afterLines>0)');
  }

  // ---- 0.10.0 trust-floor S5: fail-closed load-failure read-only gate (pure) ----
  // When the last render FAILED, the canvas is a stale preview of a form that didn't load. refuseWhileRenderFailed
  // refuses a MUTATING gesture (in the blocked surface) while renderOk is false, but lets a READ through and never
  // blocks `ready` (the first-render trigger) — so the gate can't deadlock the initial render. A succeeded render
  // (renderOk=true) allows everything.
  {
    const blocked = new Set(['manipulate', 'edit', 'delete', 'createHandler']); // sample mutation surface
    if (refuseWhileRenderFailed('manipulate', blocked, false) !== true) throw new Error('renderGate: a mutating gesture while the last render FAILED must be refused');
    if (refuseWhileRenderFailed('edit', blocked, false) !== true) throw new Error('renderGate: a grid edit while failed must be refused');
    if (refuseWhileRenderFailed('manipulate', blocked, true) !== false) throw new Error('renderGate: a mutating gesture after a SUCCESSFUL render must be allowed');
    if (refuseWhileRenderFailed('pick', blocked, false) !== false) throw new Error('renderGate: a READ (pick) while failed must be allowed — inspection survives');
    if (refuseWhileRenderFailed('ready', blocked, false) !== false) throw new Error('renderGate: `ready` (first-render trigger) must NEVER be blocked — no deadlock');
    if (refuseWhileRenderFailed(undefined, blocked, false) !== false) throw new Error('renderGate: an undefined type must not be refused');
    console.log('e2e: 0.10.0 S5 render-failed read-only gate verified — mutating+failed REFUSED; read/ready/undefined and mutating+ok ALLOWED (no first-render deadlock)');
  }
}

async function main(): Promise<void> {
  const repo = path.resolve(__dirname, '..', '..');
  // WFD_ENGINE_DLL lets a run point at a freshly-built engine in an alternate output dir (e.g. when the default
  // bin/Release copy is locked by a live Dev-Host); defaults to the standard build output.
  const dll = process.env.WFD_ENGINE_DLL || path.join(repo, 'engine', 'bin', 'Release', 'net10.0-windows', 'WinFormsDesigner.Engine.dll');
  const designer = path.join(repo, 'engine', 'samples', 'SampleForm.Designer.cs');
  const outPng = path.resolve(__dirname, '..', 'e2e-render.png');

  if (!fs.existsSync(dll)) throw new Error('engine dll not found: ' + dll);
  if (!fs.existsSync(designer)) throw new Error('sample not found: ' + designer);

  // The auto-add-project-reference helpers are pure string/fs functions (no engine) — verify them up front.
  verifyCsprojHelpers(repo);

  // Startup diagnostics must fail immediately and retain the actionable OS/apphost error. This is the installed-user
  // path for a missing .NET 10 Desktop Runtime or a wrong-architecture package; a ten-second pipe timeout hides it.
  {
    const missingEntry = path.join(os.tmpdir(), 'wfd-engine-does-not-exist', 'WinFormsDesigner.Engine.exe');
    const started = Date.now();
    let message = '';
    try { await startEngine(missingEntry, { onLog: () => undefined }); }
    catch (error) { message = error instanceof Error ? error.message : String(error); }
    if (!message.includes('failed to start WinForms designer engine'))
      throw new Error(`engine startup: missing apphost must return the actionable startup error, got ${JSON.stringify(message)}`);
    if (Date.now() - started > 3_000) throw new Error('engine startup: missing apphost waited for the pipe timeout instead of failing immediately');
    console.log('e2e: engine startup failure is immediate and actionable (missing runtime/apphost path)');
  }

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

    // standard-values dropdowns: an enum property carries an EXCLUSIVE standard-values set; a Boolean is
    // an exclusive True/False set; a Color (BackColor) is a NON-exclusive set (named colors + free ARGB entry).
    {
      const props = before?.properties ?? [];
      const flat = props.find((p) => p.name === 'FlatStyle');
      if (!flat || !flat.isEnum || !flat.standardValues || !flat.standardValues.includes('Standard') || flat.standardValuesExclusive !== true) {
        throw new Error('FlatStyle should have an exclusive standard-values set incl. "Standard": ' + JSON.stringify(flat));
      }
      const autoSize = props.find((p) => p.name === 'AutoSize' && p.type === 'System.Boolean');
      if (!autoSize || !autoSize.standardValues || !autoSize.standardValues.includes('True') || !autoSize.standardValues.includes('False') || autoSize.standardValuesExclusive !== true) {
        throw new Error('Boolean AutoSize should have exclusive True/False standard values: ' + JSON.stringify(autoSize));
      }
      const back = props.find((p) => p.name === 'BackColor');
      if (!back || !back.standardValues || !back.standardValues.length || back.standardValuesExclusive !== false) {
        throw new Error('BackColor (Color) should have a NON-exclusive standard-values set: ' + JSON.stringify(back));
      }
      // a flags enum (Anchor) must NOT get a single-select set (can't express combined flags)
      const anchor = props.find((p) => p.name === 'Anchor');
      if (anchor && anchor.standardValues != null) throw new Error('flags enum Anchor must have null standard values (kept as text): ' + JSON.stringify(anchor.standardValues));
      console.log(`e2e: standard-values verified — FlatStyle enum exclusive (${flat.standardValues.length}), Boolean True/False, BackColor non-exclusive (${back.standardValues.length}), flags Anchor left as text`);
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
    // 0.10.0 S4: an ACTUAL engine property splice must pass the byte-local firewall AND be tightly confined to the
    // target line — proving commit()'s backstop never false-refuses a real edit. This is the persisted text for a
    // net48 edit too (net48 never writes source; it persists the SAME net9 splice), so it proves the net48 path
    // byte-local by construction. (The disjoint-2-span add-control case is pinned in the pure byteLocal unit block.)
    {
      const disk = fs.readFileSync(designer, 'utf8');
      if (!isByteLocalEdit(disk, edit.text)) throw new Error('S4: a real engine property splice must pass the byte-local firewall (must not be refused)');
      const ins = changedLines(disk, edit.text).inserted;
      if (!ins.some((l) => l.includes('Changed by grid')) || ins.some((l) => l.includes('namespace ') || l.includes('void InitializeComponent')))
        throw new Error('S4: the engine splice changed region must be ONLY the target property line (a tight confined edit)');
      console.log('e2e: 0.10.0 S4 engine-splice byte-locality verified — a real setProperty splice is byte-local + tightly confined (also the net48-persisted text)');
    }
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
      // Describe + preview: the image prop is flagged isImage and carries a valid PNG thumbnail.
      const pcComp = await describeComponent(engine, imageForm, 'pictureBox1');
      const imgP = pcComp?.properties?.find((p) => p.name === 'Image');
      if (!imgP?.isImage) throw new Error('resx: pictureBox1.Image should be flagged isImage');
      if (!imgP.imagePreview || !isPng(Buffer.from(imgP.imagePreview, 'base64'))) throw new Error('resx: pictureBox1.Image has no valid preview thumbnail');
      console.log(`e2e: resx image resolution verified — ImageForm ${desc.representable}/${desc.totalStatements} representable, rendered ${rl.png.length}B, pictureBox1 ${pic.width}x${pic.height}, preview ${imgP.imagePreview.length}B base64`);
    }

    // ---- 0.11.0 minimal (Collection) routing ----
    // A ListView exposes several inline-serialized IList collections. `Columns` has a bespoke editor (isCollection,
    // the "…" editor, item=ColumnHeader). The ones we DON'T bespoke-edit — Items / Groups / DataBindings — must be
    // surfaced as READ-ONLY "(Collection)" (VS parity: visible; fail-closed: no edit path, no data-loss, no broken
    // editor), NOT dropped and NOT shown as a raw ToString.
    {
      const lvForm = path.join(repo, 'engine', 'samples', 'ListViewForm.Designer.cs');
      const lv = await describeComponent(engine, lvForm, 'listView1');
      if (!lv) throw new Error('collection-routing: listView1 not described');
      const prop = (n: string) => lv.properties?.find((p) => p.name === n);
      const columns = prop('Columns');
      if (!columns?.isCollection) throw new Error('collection-routing: Columns must be an editable (bespoke) collection');
      if (columns.collectionItemType !== 'System.Windows.Forms.ColumnHeader') throw new Error(`collection-routing: Columns itemType ${columns.collectionItemType}`);
      for (const name of ['Items', 'Groups']) {
        const p = prop(name);
        if (!p) throw new Error(`collection-routing: ${name} must be surfaced (not dropped)`);
        if (p.isCollection) throw new Error(`collection-routing: ${name} is unhandled — must NOT be flagged isCollection (no broken "…")`);
        if (p.value !== '(Collection)') throw new Error(`collection-routing: ${name} must show "(Collection)" (got ${JSON.stringify(p.value)})`);
        if (!p.readOnly) throw new Error(`collection-routing: ${name} must be read-only (no edit path)`);
      }
      // a plain scalar prop is unaffected (regression guard): Name is editable text, not "(Collection)".
      const nameP = prop('Name');
      if (nameP && (nameP.value === '(Collection)' || nameP.readOnly)) throw new Error('collection-routing: a scalar (Name) must not be mis-flagged as a read-only collection');
      console.log('e2e: 0.11.0 minimal (Collection) routing verified — Columns editable (item=ColumnHeader); Items/Groups surfaced READ-ONLY "(Collection)" (not dropped, not ToString, not a broken editor); scalar Name unaffected');
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
    const customDll = path.join(repo, 'samples', 'CustomControls', 'bin', 'Release', 'net10.0-windows', 'CustomControls.dll');
    if (fs.existsSync(customForm) && fs.existsSync(customDll)) {
      const autoSer = await serializeDesigner(engine, customForm); // 1-arg → auto-discover
      const explicitSer = await serializeDesigner(engine, customForm, customDll); // 2-arg → explicit override
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
      // project controls: the project assembly's own control appears in the toolbox under "Project Controls"
      const tbProj = await listToolboxItems(engine, customForm, customDll);
      const gaugeItem = tbProj.find((t) => t.name === 'GaugeControl');
      if (!gaugeItem || !gaugeItem.fromProject || gaugeItem.category !== 'Project Controls') {
        throw new Error('GaugeControl should appear as a Project Control: ' + JSON.stringify(tbProj.filter((t) => t.fromProject)));
      }
      if (gaugeItem.fqn !== 'CustomControls.GaugeControl') throw new Error('GaugeControl fqn wrong: ' + gaugeItem.fqn);
      if (!tbProj.some((t) => t.name === 'Button' && !t.fromProject)) throw new Error('framework controls must still be present alongside project controls');
      // a project control adds via its fqn (validated against the enumerated set), framework path unaffected
      const addGauge = await addControl(engine, customForm, 'this', 'CustomControls.GaugeControl', fs.readFileSync(customForm, 'utf8'), undefined, undefined, customDll);
      if (!addGauge.safe || addGauge.newText === null) throw new Error('AddControl(GaugeControl) rejected: ' + addGauge.reason);
      if (addGauge.newText.indexOf('new CustomControls.GaugeControl()') < 0) throw new Error('AddControl(GaugeControl) did not emit the project type ctor');
      const addBogus = await addControl(engine, customForm, 'this', 'CustomControls.NotAThing', fs.readFileSync(customForm, 'utf8'), undefined, undefined, customDll);
      if (addBogus.safe) throw new Error('AddControl must reject a project type that is not in the enumerated set');
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
      // component tray: SampleForm has no non-visual components → empty tray
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

      // ---- on-canvas "Type Here" per-item geometry on a STRIP form ----
      // SampleForm has no strip, so the leg above never exercised BuildToolStripItems (which forces a per-strip
      // PerformLayout AFTER the PNG capture). Pin that ordering here: on MenuForm (a MenuStrip with 2 top-level
      // items) the combined PNG must STILL be byte-identical to renderDesigner (the post-capture layout-force can't
      // perturb pixels), the strip host is flagged, per-item rects are emitted with a trailing Type-Here slot after
      // the last item, and DescribeLayout emits the identical item geometry (the two RPCs must not drift).
      const menuForm = path.join(repo, 'engine', 'samples', 'MenuForm.Designer.cs');
      const menuPng = await renderDesigner(engine, menuForm);
      const menuCombined = await renderWithLayout(engine, menuForm);
      if (!menuCombined.png.equals(menuPng)) {
        throw new Error(`strip geometry: MenuForm renderWithLayout png (${menuCombined.png.length}B) != renderDesigner (${menuPng.length}B) — the post-capture strip PerformLayout must NOT perturb pixels`);
      }
      const stripHost = menuCombined.controls.find((c) => c.isStripHost);
      if (!stripHost) throw new Error('strip geometry: no control flagged isStripHost on MenuForm');
      const tsItems = menuCombined.toolStripItems;
      const realItems = tsItems.filter((it) => !it.isTypeHere);
      const slots = tsItems.filter((it) => it.isTypeHere);
      if (realItems.length < 2) throw new Error(`strip geometry: expected ≥2 top-level items, got ${realItems.length}`);
      if (slots.length !== 1) throw new Error(`strip geometry: expected exactly one Type-Here slot, got ${slots.length}`);
      if (realItems.some((it) => it.ownerId !== stripHost.id || it.itemId.length === 0 || it.width <= 0 || it.height <= 0)) {
        throw new Error('strip geometry: an item has the wrong owner, an empty id, or a degenerate rect');
      }
      // each real item carries its live caption
      // assert the EMISSION order directly (NOT sorted): the flyout draws items in this order, so a reorder regression
      // (menuStrip1.Items.AddRange sequence) must fail here rather than be normalized away.
      const captions = realItems.map((it) => it.text);
      if (JSON.stringify(captions) !== JSON.stringify(['File', 'Edit'])) {
        throw new Error(`strip geometry: item captions [${captions.join(', ')}] != [File, Edit] — the Text field must round-trip in emission order`);
      }
      // nested submenu items ride along BOUNDS-LESS in `children` so the canvas can draw a synthetic flyout and reach a
      // nested item's Properties (the tray no longer surfaces strip items). MenuForm: File → {Open, Save}; Edit → none.
      const fileItem = realItems.find((it) => it.text === 'File');
      const editItem = realItems.find((it) => it.text === 'Edit');
      if (!fileItem || !editItem) throw new Error('strip geometry: MenuForm is missing the File/Edit top-level items');
      const fileKids = fileItem.children ?? [];
      const kidCaptions = fileKids.map((k) => k.text); // emission order (DropDownItems.AddRange): Open, Save — asserted directly, not sorted
      if (JSON.stringify(kidCaptions) !== JSON.stringify(['Open', 'Save'])) {
        throw new Error(`strip geometry: File submenu children [${kidCaptions.join(', ')}] != [Open, Save] — nested items must be emitted in order`);
      }
      if (fileKids.some((k) => k.itemId.length === 0 || k.ownerId !== stripHost.id)) {
        throw new Error('strip geometry: a File submenu child has an empty id or the wrong owner (must be the top-level strip id)');
      }
      if ((editItem.children ?? []).length !== 0) throw new Error('strip geometry: Edit has no submenu → its children must be empty');
      // the slot sits after the rightmost item (contentEnd + gap) on this horizontal strip
      const rightmost = Math.max(...realItems.map((it) => it.x + it.width));
      if (slots[0].x < rightmost) throw new Error(`strip geometry: Type-Here slot x=${slots[0].x} is not past the last item (right edge ${rightmost})`);
      // DescribeLayout must emit byte-identical item geometry (no cross-RPC drift between the two layout sources)
      const menuLayout = await describeLayout(engine, menuForm);
      const dItems = menuLayout.toolStripItems;
      if (dItems.length !== tsItems.length) throw new Error(`strip geometry: describeLayout ${dItems.length} items != renderWithLayout ${tsItems.length}`);
      // field-by-field equality, recursing into `children` so the nested submenu forest can't drift between the two RPCs
      const sameItem = (a: ToolStripItemBounds, b: ToolStripItemBounds): boolean =>
        a.ownerId === b.ownerId && a.itemId === b.itemId && a.text === b.text && a.x === b.x && a.y === b.y &&
        a.width === b.width && a.height === b.height && a.isTypeHere === b.isTypeHere &&
        (a.children ?? []).length === (b.children ?? []).length &&
        (a.children ?? []).every((c, j) => sameItem(c, (b.children ?? [])[j]));
      for (let i = 0; i < tsItems.length; i++) {
        const a = tsItems[i], b = dItems[i];
        if (!sameItem(a, b)) {
          throw new Error(`strip geometry: item[${i}] renderWithLayout != describeLayout ("${a.itemId}" "${a.text}" ${a.x},${a.y} vs "${b.itemId}" "${b.text}" ${b.x},${b.y}) — geometry or nested children drifted`);
        }
      }
      console.log(`e2e: strip item geometry verified — MenuForm png byte-identical, ${realItems.length} items (${captions.join(', ')}) + File submenu [${kidCaptions.join(', ')}] + 1 Type-Here slot on "${stripHost.id}", renderWithLayout == describeLayout geometry+captions+children`);

      // ---- off-tree ContextMenuStrip → the TRAY, never a phantom control rect (hit-test-theft fix) ----
      // A ContextMenuStrip is a sited Control field that is never added to any Controls collection (Parent==null):
      // Visual Studio edits it from the component tray and shows it as a popup, never on the form. Keeping it in the
      // visual/hit-test map dropped a PHANTOM rect at the chrome origin that — being smaller than the menu bar —
      // sorted first and STOLE the click over the menu's left region. The fix skips off-tree controls in the layout
      // and surfaces them in the tray (both engines; net48's Collect(root) already never reached one). This leg pins
      // all of it on a Form with a MenuStrip + a ContextMenuStrip: no phantom, present in the tray, menu-bar hit-test
      // restored, and the skipped off-tree control must not perturb the rendered pixels (it was never painted).
      const ctxForm = path.join(repo, 'engine', 'samples', 'ContextMenuForm.Designer.cs');
      const overflowForm = path.join(repo, 'engine', 'samples', 'ToolStripOverflowForm.Designer.cs');
      const imageListForm = path.join(repo, 'engine', 'samples', 'ImageListForm.Designer.cs');
      const compRefForm48 = path.join(repo, 'engine', 'samples', 'ComponentRefForm.Designer.cs');

      // ---- 0.10.0 trust-floor S2: net9 inherited/unresolved-base detection → honest banner signal ----
      // The net9 interpreter targets a framework surface and replays ONLY the derived .Designer.cs, so a form whose
      // REAL base is an inherited/vendor type renders best-effort with the base's controls silently DROPPED. S2 flags
      // it (renderWithLayout → inheritedBase + baseTypeName) so the host shows an honest "preview may be incomplete"
      // banner instead of a silent mis-render. No built assembly here → the syntactic EXACT-match fallback classifier.
      const derivedForm = path.join(repo, 'engine', 'samples', 'DerivedForm.Designer.cs');
      const inheritedBaseDes = path.join(repo, 'engine', 'samples', 'InheritedBaseForm.Designer.cs');
      const vendorForm = path.join(repo, 'engine', 'samples', 'VendorForm.Designer.cs');
      const qualifiedForm = path.join(repo, 'engine', 'samples', 'QualifiedForm.Designer.cs');
      const aliasedUcForm = path.join(repo, 'engine', 'samples', 'AliasedUcForm.Designer.cs');
      const nsCollisionForm = path.join(repo, 'engine', 'samples', 'NsCollisionForm.Designer.cs');
      if (!fs.existsSync(derivedForm)) {
        console.log('e2e: SKIPPED 0.10.0 S2 inherited-base detection — DerivedForm fixture absent (untracked on a fresh checkout)');
      } else {
        // the base fixture must ACTUALLY declare baseButton — else "baseButton dropped from the render" would be a
        // vacuous absence. This makes the drop a proof of a REAL base control being lost by net9.
        if (!fs.existsSync(inheritedBaseDes)) throw new Error('S2: InheritedBaseForm.Designer.cs fixture missing — the base-drop assertion would be vacuous');
        if (!/\bbaseButton\b/.test(fs.readFileSync(inheritedBaseDes, 'utf8'))) throw new Error('S2: InheritedBaseForm.Designer.cs must declare baseButton (the control net9 must be shown to drop)');
        // visual inheritance: DerivedForm : InheritedBaseForm (a USER base) → flagged, and the base's control IS dropped.
        const der = await renderWithLayout(engine, derivedForm);
        if (der.inheritedBase !== true) throw new Error("S2: DerivedForm (: InheritedBaseForm) must flag inheritedBase=true — a user base the net9 interpreter can't reproduce");
        if (!/InheritedBaseForm/.test(der.baseTypeName)) throw new Error(`S2: DerivedForm baseTypeName must name the base, got ${JSON.stringify(der.baseTypeName)}`);
        const derIds = der.controls.map((c) => c.id);
        if (!derIds.includes('derivedButton')) throw new Error('S2: DerivedForm must still render its OWN control (derivedButton) on the best-effort surface');
        if (derIds.includes('baseButton')) throw new Error('S2: DerivedForm must DROP the base control (baseButton) on net9 — that silent loss is exactly what the banner warns about');
        // vendor base (: DevExpress...XtraForm) → flagged, base named by its simple identifier (the classic mis-render).
        const ven = await renderWithLayout(engine, vendorForm);
        if (ven.inheritedBase !== true) throw new Error('S2: VendorForm (: XtraForm) must flag inheritedBase=true');
        if (ven.baseTypeName !== 'XtraForm') throw new Error(`S2: VendorForm baseTypeName must be the simple base name "XtraForm", got ${JSON.stringify(ven.baseTypeName)}`);
        // NEGATIVE: a fully-qualified framework base must normalize → NOT flagged (no over-banner).
        const qual = await renderWithLayout(engine, qualifiedForm);
        if (qual.inheritedBase !== false) throw new Error('S2: QualifiedForm (: System.Windows.Forms.Form) must NOT flag — an FQN framework base is resolved');
        // NEGATIVE: a plain `: Form` sample must stay unflagged (no regression on the common case).
        const plain = await renderWithLayout(engine, path.join(repo, 'engine', 'samples', 'SampleForm.Designer.cs'));
        if (plain.inheritedBase !== false || plain.baseTypeName !== '') throw new Error('S2: a plain : Form sample must not flag inheritedBase');
        // A SAME-FILE alias of a framework root (`using U = ...UserControl; : U`) must RESOLVE (no banner)
        // AND render on the UserControl surface (its own control present), not a mis-typed Form.
        if (fs.existsSync(aliasedUcForm)) {
          const uc = await renderWithLayout(engine, aliasedUcForm);
          if (uc.inheritedBase !== false) throw new Error('S2: an aliased framework base (using U = ...UserControl) must NOT flag inherited — the alias resolves to UserControl');
          if (!/UserControl/.test(uc.rootType)) throw new Error(`S2: aliased UserControl must render on the UserControl surface, got rootType ${JSON.stringify(uc.rootType)}`);
          if (!uc.controls.map((c) => c.id).includes('ucButton')) throw new Error('S2: aliased UserControl must render its own control (ucButton)');
        }
        // A same-SHORT-name decoy class in ANOTHER namespace must not steal the classification — the
        // sibling lookup matches the fully-qualified name, so SampleApp.NsCollisionForm resolves to its REAL base.
        if (fs.existsSync(nsCollisionForm)) {
          const coll = await renderWithLayout(engine, nsCollisionForm);
          if (coll.inheritedBase !== true) throw new Error('S2: NsCollisionForm must flag inherited — a Decoy.NsCollisionForm(:Form) in the sibling must NOT be matched over SampleApp.NsCollisionForm(:InheritedBaseForm)');
          if (!/InheritedBaseForm/.test(coll.baseTypeName)) throw new Error(`S2: NsCollisionForm base must be InheritedBaseForm (correct-namespace match), got ${JSON.stringify(coll.baseTypeName)}`);
        }
        console.log(`e2e: 0.10.0 S2 inherited-base detection verified — DerivedForm flagged (base=${der.baseTypeName}, baseButton dropped, derivedButton kept), VendorForm flagged (base=XtraForm), QualifiedForm(FQN)+SampleForm not flagged, aliased-UserControl resolved on UC surface, namespace-collision matched by FQN`);
      }

      // ---- 0.10.0 trust-floor S3: binary/ImageStream resx → honest banner signal + upsert-preserves invariant ----
      // A form whose sibling .resx holds a BinaryFormatter/ImageStream node can't render that resource on net9, so
      // the render DTO reports unrenderableResxCount>0 (drives the banner). And the ONLY .resx writer (image import)
      // is a scoped XML upsert — PIN that it preserves the binary node byte-faithfully when importing a DIFFERENT key.
      const binaryResxForm = path.join(repo, 'engine', 'samples', 'BinaryResxForm.Designer.cs');
      if (!fs.existsSync(binaryResxForm)) {
        console.log('e2e: SKIPPED 0.10.0 S3 binary-resx render-signal — BinaryResxForm fixture absent (untracked on a fresh checkout)');
      } else {
        const bin = await renderWithLayout(engine, binaryResxForm);
        // the fixture .resx exercises ALL THREE load-time gates: an ImageStream binary node, an external FileRef, and a
        // non-allowlisted value type (Cursor) — so the count must span them (FileRef/non-allowlisted must count,
        // not just binary). A string node is renderable and must NOT count.
        if (bin.unrenderableResxCount !== 3) throw new Error(`S3: BinaryResxForm must report 3 unrenderable (binary ImageStream + FileRef + non-allowlisted Cursor), got ${bin.unrenderableResxCount}`);
        if (!bin.controls.map((c) => c.id).includes('okButton')) throw new Error('S3: BinaryResxForm must still RENDER (the refused binary resource must not abort the render)');
        // NEGATIVE: a plain form (no resx) and a bytearray-image form must report 0 (no over-banner).
        const plainResx = await renderWithLayout(engine, path.join(repo, 'engine', 'samples', 'SampleForm.Designer.cs'));
        if (plainResx.unrenderableResxCount !== 0) throw new Error('S3: a form with no .resx must report 0 unrenderable');
        const imgResx = await renderWithLayout(engine, path.join(repo, 'engine', 'samples', 'ImageForm.Designer.cs'));
        if (imgResx.unrenderableResxCount !== 0) throw new Error('S3: a bytearray-image (Bitmap) resx must report 0 unrenderable (it renders fine)');

        // PIN the no-regenerate invariant: import a NEW image into a DIFFERENT key and assert the pre-existing
        // ImageStream binary node SURVIVES with the same base64 value (the upsert preserves all non-target nodes).
        const resxBefore = fs.readFileSync(path.join(repo, 'engine', 'samples', 'BinaryResxForm.resx'), 'utf8');
        const streamVal = /<data name="imageList1\.ImageStream"[^>]*>\s*<value>([^<]*)<\/value>/.exec(resxBefore)?.[1];
        if (!streamVal) throw new Error('S3: could not read the ImageStream base64 from the fixture — the PIN would be vacuous');
        const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
        const up = await setImageResource(engine, binaryResxForm, 'okButton', 'Image', 'System.Drawing.Image', tinyPng, resxBefore, fs.readFileSync(binaryResxForm, 'utf8'));
        if (!up.safe || up.resxText == null) throw new Error(`S3: importing into a new key must succeed on a binary-resx form (upsert preserves), got safe=${up.safe}`);
        if (!new RegExp('<data name="imageList1\\.ImageStream"').test(up.resxText)) throw new Error('S3 REGRESSION: the image upsert DROPPED the ImageStream binary node — data loss!');
        if (!up.resxText.includes(streamVal)) throw new Error('S3 REGRESSION: the ImageStream base64 value was altered by the upsert');
        if (binaryResxKeys(up.resxText).size !== binaryResxKeys(resxBefore).size) throw new Error('S3: the set of binary resx keys must be unchanged by an image upsert');
        if (binaryResxCount(up.resxText) !== binaryResxCount(resxBefore)) throw new Error('S3: the binary resx COUNT (the tripwire signal) must be unchanged by an image upsert — else the guard would refuse a legit import');
        // NEGATIVE: an unparseable .resx is refused (never clobbered).
        const bad = await setImageResource(engine, binaryResxForm, 'okButton', 'Image', 'System.Drawing.Image', tinyPng, '<root><not-closed>', fs.readFileSync(binaryResxForm, 'utf8'));
        // must be REFUSED (safe===false — the host gates its .resx write on !res.safe) AND carry no writable payload
        // (resxText null/empty). Rejecting EITHER a true safe OR a non-empty resxText (the old `&&` assertion
        // passed for either wrong field; `|| bad.resxText` tolerates the engine's null-or-"" "no resx" representation).
        if (bad.safe || bad.resxText) throw new Error('S3: an unparseable existing .resx must be REFUSED (safe===false, no writable resxText), never clobbered');
        console.log(`e2e: 0.10.0 S3 binary-resx verified — BinaryResxForm reports ${bin.unrenderableResxCount} unrenderable (renders okButton), no-resx/bytearray report 0; image upsert PRESERVES the ImageStream binary node byte-faithfully; unparseable .resx refused`);
      }

      if (fs.existsSync(ctxForm)) {
        const ctxLayout = await describeLayout(engine, ctxForm);
        if (ctxLayout.controls.some((c) => c.type.endsWith('ContextMenuStrip'))) {
          throw new Error('ctx tray: a ContextMenuStrip leaked into the control layout (phantom rect — it must be tray-only)');
        }
        const ctxChip = ctxLayout.tray.find((t) => t.id === 'contextMenuStrip1');
        if (!ctxChip) throw new Error(`ctx tray: contextMenuStrip1 missing from the tray (got [${ctxLayout.tray.map((t) => t.id).join(', ')}])`);
        if (!ctxChip.type.endsWith('ContextMenuStrip')) throw new Error(`ctx tray: contextMenuStrip1 wrong type ${ctxChip.type}`);
        // VS never trays strip ITEMS — a field-backed ToolStripItem is a sited Component, but it is edited on the strip
        // itself (on-canvas Type Here / the item editor), not from the tray. The tray must hold ONLY non-visual
        // components + off-tree Controls: contextMenuStrip1 (an off-tree Control) and timer1 (a non-visual component)
        // stay; the four menu/context items must be gone. Pins that the item-skip is item-specific (timer1 survives).
        const ctxItemIds = ['fileMenu', 'editMenu', 'cutItem', 'pasteItem', 'pasteSpecialItem', 'undoItem', 'redoItem'];
        const ctxLeaked = ctxLayout.tray.filter((t) => ctxItemIds.includes(t.id)).map((t) => t.id);
        if (ctxLeaked.length) throw new Error(`ctx tray: ToolStripItem(s) leaked into the tray [${ctxLeaked.join(', ')}] — VS never trays strip items (including nested ones)`);
        if (!ctxLayout.tray.some((t) => t.id === 'timer1')) throw new Error('ctx tray: timer1 (a non-visual component) must stay in the tray — the strip-item skip must not drop non-item components');
        // the chip is genuinely selectable: describing it drives the property panel (VS edits a ContextMenuStrip's
        // Items from the tray), so a tray chip that can't be described would be a dead click.
        const ctxDesc = await describeComponent(engine, ctxForm, 'contextMenuStrip1');
        if (!ctxDesc?.properties?.length) throw new Error('ctx tray: contextMenuStrip1 is not describable — the tray chip would select nothing');
        const ctxItems = ctxDesc.properties.find((p) => p.name === 'Items');
        if (ctxItems?.collectionItemType !== 'System.Windows.Forms.ToolStripItem')
          throw new Error('ctx tray: contextMenuStrip1.Items must be a ToolStripItem collection (item editor reachable), got ' + JSON.stringify(ctxItems?.collectionItemType));
        const menu = ctxLayout.controls.find((c) => c.id === 'menuStrip1');
        if (!menu) throw new Error('ctx tray: menuStrip1 missing from the layout');
        // hit-test over the menu bar's left region (where the phantom used to overlap) must return the menu bar
        const ctxHit = (px: number, py: number): string | undefined =>
          ctxLayout.controls.find((c) => px >= c.x && px < c.x + c.width && py >= c.y && py < c.y + c.height)?.id;
        const menuHit = ctxHit(menu.x + 20, menu.y + Math.floor(menu.height / 2));
        if (menuHit !== 'menuStrip1') throw new Error(`ctx tray: menu-bar hit-test → ${menuHit} (expected menuStrip1 — a phantom ContextMenuStrip must not steal it)`);
        // skipping the off-tree control cannot change the pixels, and the combined RPC must agree with describeLayout
        const ctxPng = await renderDesigner(engine, ctxForm);
        const ctxCombined = await renderWithLayout(engine, ctxForm);
        if (!ctxCombined.png.equals(ctxPng)) {
          throw new Error(`ctx tray: ContextMenuForm renderWithLayout png (${ctxCombined.png.length}B) != renderDesigner (${ctxPng.length}B) — skipping an off-tree control must not perturb pixels`);
        }
        if (ctxCombined.controls.some((c) => c.type.endsWith('ContextMenuStrip'))) {
          throw new Error('ctx tray: renderWithLayout leaked a ContextMenuStrip into the control layout');
        }
        if (!ctxCombined.tray.some((t) => t.id === 'contextMenuStrip1')) {
          throw new Error('ctx tray: renderWithLayout dropped contextMenuStrip1 from the tray');
        }
        console.log(`e2e: off-tree ContextMenuStrip verified — no phantom control rect, contextMenuStrip1 in tray (tray = [${ctxLayout.tray.map((t) => t.id).join(', ')}], no strip items), menu-bar hit-test → menuStrip1, png byte-identical (describeLayout == renderWithLayout)`);

        // ---- off-tree ContextMenuStrip → its Items reachable via a synthetic flyout from the TRAY chip (net9) ----
        // The tray chip now carries the strip's top-level Items (a BOUNDS-LESS forest: id/text/type + recursive children)
        // so the canvas opens a synthetic flyout from the chip — the on-canvas reach into a ContextMenuStrip's items
        // (Properties / rename / delete / add), the tray-chip counterpart of a menu-bar item's dropdown. Assert on both
        // describeLayout and the combined RPC (they must agree), that a non-strip chip carries none, and that each item's
        // OwnerId is the strip (the host splice key for add/rename/delete).
        const ctxTrayItems = (chip: any): string => // eslint-disable-line @typescript-eslint/no-explicit-any
          (chip?.items ?? []).map((it: any) => `${it.itemId}:${it.text}:${it.itemType.split('.').pop()}`).join('|'); // eslint-disable-line @typescript-eslint/no-explicit-any
        const dChipItems = ctxTrayItems(ctxLayout.tray.find((t) => t.id === 'contextMenuStrip1'));
        const cChipItems = ctxTrayItems(ctxCombined.tray.find((t) => t.id === 'contextMenuStrip1'));
        const wantCtxItems = 'cutItem:Cut:ToolStripMenuItem|pasteItem:Paste:ToolStripMenuItem';
        if (dChipItems !== wantCtxItems) throw new Error(`ctx tray items: describeLayout chip.items [${dChipItems}] != [${wantCtxItems}] — the tray flyout would have nothing to draw`);
        if (cChipItems !== wantCtxItems) throw new Error(`ctx tray items: renderWithLayout chip.items [${cChipItems}] != describeLayout [${dChipItems}]`);
        const ctxChipItems = (ctxLayout.tray.find((t) => t.id === 'contextMenuStrip1') as any)?.items ?? []; // eslint-disable-line @typescript-eslint/no-explicit-any
        if (ctxChipItems.some((it: any) => it.ownerId !== 'contextMenuStrip1')) throw new Error('ctx tray items: each item must carry the strip as its OwnerId (the host splice key)'); // eslint-disable-line @typescript-eslint/no-explicit-any
        if (ctxTrayItems(ctxLayout.tray.find((t) => t.id === 'timer1')).length) throw new Error('ctx tray items: a non-strip tray component (timer1) must carry no items — the canvas opens no flyout for it');
        // IsStrip distinguishes an off-tree ToolStrip (the canvas opens its flyout — even when EMPTY) from a non-strip
        // component whose empty Items is byte-identical. The canvas gates the flyout on this flag, NOT items.length, so a
        // ContextMenuStrip with zero items still gets an add-first-item "Type Here" flyout. Assert both net9 paths emit it.
        if ((ctxLayout.tray.find((t) => t.id === 'contextMenuStrip1') as any)?.isStrip !== true) throw new Error('ctx tray: describeLayout contextMenuStrip1 must report isStrip=true (an off-tree strip opens a flyout, even empty)'); // eslint-disable-line @typescript-eslint/no-explicit-any
        if ((ctxCombined.tray.find((t) => t.id === 'contextMenuStrip1') as any)?.isStrip !== true) throw new Error('ctx tray: renderWithLayout contextMenuStrip1 must report isStrip=true (net9 combined RPC parity)'); // eslint-disable-line @typescript-eslint/no-explicit-any
        if ((ctxLayout.tray.find((t) => t.id === 'timer1') as any)?.isStrip) throw new Error('ctx tray: timer1 (a non-strip component) must report isStrip falsy — the canvas opens no flyout for it'); // eslint-disable-line @typescript-eslint/no-explicit-any
        // the tray forest is harvested RECURSIVELY (BuildStripItemForest → BuildItemChildren), not just its flat top level:
        // pasteItem carries its nested "Paste Special" child (owner still the top-level strip) so a nested off-tree-strip
        // item is reachable through the synthetic tray flyout — a regression that dropped children would leave it unreachable.
        const ctxPaste = ctxChipItems.find((it: any) => it.itemId === 'pasteItem'); // eslint-disable-line @typescript-eslint/no-explicit-any
        const ctxPasteKids = (ctxPaste?.children ?? []).map((k: any) => `${k.itemId}:${k.text}:${k.ownerId}`); // eslint-disable-line @typescript-eslint/no-explicit-any
        if (JSON.stringify(ctxPasteKids) !== JSON.stringify(['pasteSpecialItem:Paste Special:contextMenuStrip1'])) {
          throw new Error(`ctx tray items: pasteItem nested children [${ctxPasteKids.join(', ')}] != [pasteSpecialItem:Paste Special:contextMenuStrip1] — the tray forest must recurse (owner = the top-level strip)`);
        }
        console.log(`e2e: off-tree ContextMenuStrip items reachable via tray flyout (net9) verified — contextMenuStrip1 chip carries [${dChipItems}] (owner contextMenuStrip1) + pasteItem nested [${ctxPasteKids.join(', ')}], timer1 carries none; describeLayout == renderWithLayout`);

        // ---- nested submenu item → Properties reachability (on-canvas synthetic flyout, net9) ----
        // The tray no longer surfaces strip items, so a nested item's scalar props/events are reached by clicking it in
        // a client-side flyout the canvas draws from the engine's `children`. Pin the two halves of that path on net9:
        // (1) editMenu's geometry carries its nested Undo/Redo (bounds-less, owner = the top-level strip) so the canvas
        // can draw the flyout; (2) the item→Properties channel (selectItem → describeComponent by id) resolves a NESTED
        // field-backed item — exactly what a flyout-row click sends.
        const ctxEdit = ctxCombined.toolStripItems.find((it) => it.itemId === 'editMenu');
        if (!ctxEdit) throw new Error('nested flyout: editMenu missing from ContextMenuForm strip geometry');
        // emission order (editMenu.DropDownItems.AddRange): undoItem then redoItem — asserted directly. A prior `.sort()`
        // here REVERSED this to [redo, undo] and would have hidden a real reorder regression.
        const ctxEditKids = (ctxEdit.children ?? []).map((k) => `${k.itemId}:${k.text}`);
        if (JSON.stringify(ctxEditKids) !== JSON.stringify(['undoItem:Undo', 'redoItem:Redo'])) {
          throw new Error(`nested flyout: editMenu children [${ctxEditKids.join(', ')}] != [undoItem:Undo, redoItem:Redo] — the flyout would have nothing to draw (or drew out of order)`);
        }
        if ((ctxEdit.children ?? []).some((k) => k.ownerId !== 'menuStrip1')) throw new Error('nested flyout: a nested child must carry the top-level strip as its owner (the selectItem host)');
        const nested9 = await describeComponent(engine, ctxForm, 'undoItem');
        if (!nested9) throw new Error('nested flyout: net9 describeComponent(undoItem) returned null — a flyout-row click would select nothing');
        if (!nested9.type.endsWith('ToolStripMenuItem') || nested9.properties?.find((p) => p.name === 'Text')?.value !== 'Undo') {
          throw new Error(`nested flyout: net9 undoItem describe wrong (type ${nested9.type}, Text ${JSON.stringify(nested9.properties?.find((p) => p.name === 'Text')?.value)})`);
        }
        console.log(`e2e: nested submenu item→Properties reachability (net9) verified — editMenu geometry carries [${ctxEditKids.join(', ')}] (owner menuStrip1) + describeComponent(undoItem) resolves the nested field (${nested9.type}, Text "Undo")`);
      } else {
        console.log('e2e: ContextMenuStrip tray SKIPPED — engine/samples/ContextMenuForm.Designer.cs missing');
      }

      // ---- OVERFLOW items (net9): a ToolStrip narrower than its buttons pushes the excess into the overflow dropdown ----
      // The engine emits those (Placement==Overflow) BOUNDS-LESS under the overflow chevron's ToolStripItemBounds
      // (overflow=true, id-less, children = the overflow items) so the canvas opens a synthetic flyout of them, and it
      // suppresses the trailing "Type Here" slot on a full strip. Assert the ROBUST invariants (a chevron with >=1 child,
      // the union of main+overflow item ids == all six buttons, no Type-Here slot) rather than an exact split, which
      // text measurement could pick differently per runtime.
      if (fs.existsSync(overflowForm)) {
        const ovf = await describeLayout(engine, overflowForm);
        const ovfItems = ovf.toolStripItems.filter((it) => it.ownerId === 'toolStrip1');
        const chevron = ovfItems.find((it) => (it as { overflow?: boolean }).overflow === true);
        if (!chevron) throw new Error(`overflow (net9): no overflow chevron emitted — toolStrip1 items [${ovfItems.map((i) => i.itemId || (i.isTypeHere ? '<slot>' : '<chevron?>')).join(', ')}] (the fixture must overflow; is the strip too wide?)`);
        const overflowIds = (chevron.children ?? []).map((c) => c.itemId);
        if (overflowIds.length === 0) throw new Error('overflow (net9): the chevron carries no overflow items');
        if (chevron.itemId !== '') throw new Error(`overflow (net9): the chevron must be id-less, got "${chevron.itemId}"`);
        const mainIds = ovfItems.filter((it) => !it.isTypeHere && !(it as { overflow?: boolean }).overflow).map((it) => it.itemId);
        const allButtons = ['btnOne', 'btnTwo', 'btnThree', 'btnFour', 'btnFive', 'btnSix'];
        const union = [...mainIds, ...overflowIds].filter((id) => id).sort();
        if (union.join(',') !== allButtons.slice().sort().join(',')) throw new Error(`overflow (net9): main+overflow ids [${union.join(', ')}] != all six buttons [${allButtons.join(', ')}] — an item was dropped or duplicated`);
        if (ovfItems.some((it) => it.isTypeHere)) throw new Error('overflow (net9): a full (overflowing) strip must emit NO trailing "Type Here" slot');
        if (!(chevron.width > 0 && chevron.height > 0)) throw new Error('overflow (net9): the chevron must carry real bounds (the canvas hit-tests it)');
        console.log(`e2e: OVERFLOW items (net9) verified — toolStrip1 chevron (id-less, ${chevron.width}x${chevron.height}) carries [${overflowIds.join(', ')}]; main [${mainIds.join(', ')}] + overflow == all six buttons; no Type-Here slot`);
      } else {
        console.log('e2e: OVERFLOW items (net9) SKIPPED — engine/samples/ToolStripOverflowForm.Designer.cs missing (an UNTRACKED sample: git add it, or this coverage silently vanishes on a fresh checkout)');
      }

      // ---- RETYPE mechanism (net9): the host's applyStripRetype re-mints a node (id="" + new type) at the same position ----
      // Retype has no engine changes — it reuses the ToolStrip commit seam: re-minting the forest node (empty id → NEW
      // item) while removing the old id is a remove+add in ONE SetToolStripItems call. Pin that engine behaviour directly
      // (the host glue that builds the mutated forest is webview-proven): read menuStrip1's forest, re-mint the leaf
      // fileMenu as a ToolStripButton, and assert the preview is safe, drops the old field, constructs the new type, and
      // keeps the sibling (editMenu).
      if (fs.existsSync(ctxForm)) {
        const lst = await listToolStripItems(engine, ctxForm, 'menuStrip1');
        const forest = lst.ok ? lst.items.map((it) => ({ ...it })) : [];
        const tgt = forest.find((n) => n.id === 'fileMenu');
        if (tgt) {
          tgt.id = ''; tgt.name = ''; tgt.itemType = 'ToolStripButton'; tgt.text = 'File';
          const rt = await setToolStripItems(engine, ctxForm, 'menuStrip1', forest);
          if (!rt.safe || rt.text == null) throw new Error(`retype mechanism (net9): remove+add in one SetToolStripItems was refused (reason: ${rt.reason || 'unsafe'})`);
          // check `this.fileMenu` (a code reference: construction / Name / Text / AddRange member), NOT a bare "fileMenu"
          // substring — the removal deletes the field's statements + declaration but leaves the `// fileMenu` comment.
          if (/\bthis\.fileMenu\b/.test(rt.text)) throw new Error('retype mechanism (net9): the old field (this.fileMenu) survived the re-mint — the old id was not removed');
          if (!/new System\.Windows\.Forms\.ToolStripButton\(\)/.test(rt.text)) throw new Error('retype mechanism (net9): no ToolStripButton was constructed for the re-minted item');
          if (!rt.text.includes('editMenu')) throw new Error('retype mechanism (net9): the sibling editMenu was lost — a retype must not disturb other items');
          // POSITION preserved: fileMenu was FIRST, so the re-minted button must precede editMenu in menuStrip1's AddRange
          // (guards against a future append-at-end regression — the re-mint must land where the old item was).
          if (!/menuStrip1\.Items\.AddRange\([\s\S]*?toolStripButton1[\s\S]*?editMenu[\s\S]*?\}\)/.test(rt.text)) throw new Error('retype mechanism (net9): the re-minted item did not keep its position (must precede editMenu in the AddRange, as fileMenu did)');
          console.log('e2e: RETYPE mechanism (net9) verified — re-minting fileMenu (id="" + ToolStripButton) in one SetToolStripItems drops the old field, constructs the new type, and preserves editMenu (host applyStripRetype path)');
        } else {
          throw new Error('retype mechanism (net9): fileMenu not found in menuStrip1 forest — listToolStripItems regressed or the fixture changed (a present fixture MUST expose the item, else this data-loss leg silently no-ops)');
        }
      }

      // RETYPE middle-item position: fileMenu is FIRST, so "before editMenu" would also pass a broken index-0 insert.
      // Retype a MIDDLE item of the six-button overflow strip (btnThree) and assert BOTH neighbours stay on their sides
      // (btnTwo before, btnFour after) — a real position-preservation check.
      if (fs.existsSync(overflowForm)) {
        const lstO = await listToolStripItems(engine, overflowForm, 'toolStrip1');
        const forestO = lstO.ok ? lstO.items.map((it) => ({ ...it })) : [];
        const mid = forestO.find((n) => n.id === 'btnThree');
        if (mid && forestO.length >= 4) {
          mid.id = ''; mid.name = ''; mid.itemType = 'ToolStripLabel'; mid.text = 'Third Button';
          const rtO = await setToolStripItems(engine, overflowForm, 'toolStrip1', forestO);
          if (!rtO.safe || rtO.text == null) throw new Error(`retype middle (net9): refused (reason: ${rtO.reason || 'unsafe'})`);
          const ar = /toolStrip1\.Items\.AddRange\(([\s\S]*?)\}\)/.exec(rtO.text);
          if (!ar) throw new Error('retype middle (net9): could not locate the AddRange to verify position');
          const seq = ar[1];
          const iTwo = seq.indexOf('btnTwo'), iNew = seq.indexOf('toolStripLabel1'), iFour = seq.indexOf('btnFour');
          if (iTwo < 0 || iNew < 0 || iFour < 0) throw new Error(`retype middle (net9): AddRange missing an expected member (btnTwo=${iTwo}, new=${iNew}, btnFour=${iFour})`);
          if (!(iTwo < iNew && iNew < iFour)) throw new Error(`retype middle (net9): the re-minted item did not keep its MIDDLE position (order btnTwo(${iTwo}) < new(${iNew}) < btnFour(${iFour}) violated)`);
          if (/\bthis\.btnThree\b/.test(rtO.text)) throw new Error('retype middle (net9): the old field (this.btnThree) survived');
          console.log('e2e: RETYPE middle-item position (net9) verified — btnThree re-minted as toolStripLabel1 stays between btnTwo and btnFour in the AddRange');
        } else {
          throw new Error(`retype middle (net9): btnThree not found (or forest too small: ${forestO.length}) in toolStrip1 — a present overflow fixture MUST expose it, else this position leg silently no-ops`);
        }
      } else {
        console.log('e2e: RETYPE middle-item position (net9) SKIPPED — engine/samples/ToolStripOverflowForm.Designer.cs missing (UNTRACKED sample)');
      }

      // ---- C3 fail-closed: a nested add under a NON-dropdown item is refused ENGINE-side (offer ⇔ accept) ----
      // The UI never offers a nested "Type Here" on a non-dropdown item (a flyout opens only for an item that already
      // has children), but a direct RPC/CLI caller can send a parentItemId pointing at a ToolStripButton — which would
      // emit an invalid `btnOne.DropDownItems.AddRange(...)` (ToolStripButton has no DropDownItems) → non-compiling
      // source. The engine must REFUSE it, not return a safe splice. Pin the guard directly.
      if (fs.existsSync(overflowForm)) {
        const lstC3 = await listToolStripItems(engine, overflowForm, 'toolStrip1');
        const forestC3 = lstC3.ok ? lstC3.items.map((it) => ({ ...it, children: (it.children ?? []).slice() })) : [];
        const btn = forestC3.find((n) => n.id === 'btnOne');
        if (btn) {
          btn.children = [{ id: '', text: 'Nested', name: '', itemType: 'System.Windows.Forms.ToolStripMenuItem', children: [] }];
          const rtC3 = await setToolStripItems(engine, overflowForm, 'toolStrip1', forestC3);
          if (rtC3.safe || rtC3.text != null) throw new Error('C3: adding a child under btnOne (a ToolStripButton, no DropDownItems) must be REFUSED — the engine returned a safe splice (would save non-compiling DropDownItems.AddRange)');
          if (!/DropDownItems/.test(rtC3.reason || '')) throw new Error(`C3: the refusal reason must name the missing DropDownItems collection — got "${rtC3.reason}"`);
          console.log(`e2e: C3 nested-add fail-closed verified — a child under btnOne (ToolStripButton) is refused engine-side (reason: ${rtC3.reason})`);
        } else {
          throw new Error('C3: btnOne not found in toolStrip1 forest — a present overflow fixture MUST expose it');
        }
      } else {
        console.log('e2e: C3 nested-add fail-closed SKIPPED — engine/samples/ToolStripOverflowForm.Designer.cs missing (UNTRACKED sample)');
      }

      // ---- ImageIndex / ImageKey dropdown (Tier-4): describe-time context lets ImageKeyConverter/ImageIndexConverter
      // enumerate the attached ImageList's keys/indices → the grid offers a dropdown instead of a raw text/number field.
      // net9's source interpreter doesn't run ImageList.Images.Add (and a real resx ImageStream can't load on .NET 9), so
      // on net9 the ImageList is empty → the image dropdown is GATED OFF (no regression: ImageKey/ImageIndex stay plain
      // fields). The change is scoped to the image converters, so OTHER dropdowns (enum/bool/Cursor/Color) are unchanged.
      if (fs.existsSync(imageListForm)) {
        const il9 = await describeComponent(engine, imageListForm, 'button1');
        if (!il9) throw new Error('ImageList (net9): button1 failed to describe');
        const imageKey9 = il9.properties?.find((p) => p.name === 'ImageKey');
        const imageIndex9 = il9.properties?.find((p) => p.name === 'ImageIndex');
        if (imageKey9?.standardValues && imageKey9.standardValues.length) throw new Error(`ImageList (net9): ImageKey must NOT offer a dropdown when the ImageList is empty (interpreter can't Images.Add) — got [${imageKey9.standardValues.join(', ')}]`);
        if (imageIndex9?.standardValues && imageIndex9.standardValues.length) throw new Error(`ImageList (net9): ImageIndex must NOT offer a dropdown for an empty ImageList — got [${imageIndex9.standardValues.join(', ')}]`);
        // regression: the scoping must leave a NORMAL enum dropdown intact (FlatStyle is a browsable enum on a Button).
        const flat9 = il9.properties?.find((p) => p.name === 'FlatStyle');
        if (!(flat9?.standardValues && flat9.standardValues.length >= 2)) throw new Error(`ImageList (net9): a normal enum dropdown (Button.FlatStyle) regressed — the image-scoped context change must not affect other converters (got ${JSON.stringify(flat9?.standardValues)})`);
        console.log(`e2e: ImageIndex/ImageKey (net9) verified — an empty (interpreter-unpopulated) ImageList offers NO image dropdown (plain field, no regression); a normal enum dropdown (FlatStyle: ${flat9!.standardValues!.join(', ')}) is unaffected by the scoped context change`);
      } else {
        console.log('e2e: ImageIndex/ImageKey (net9) SKIPPED — engine/samples/ImageListForm.Designer.cs missing (UNTRACKED sample)');
      }

      // ---- selection-retention across a full re-render (regression for the tray-partition fix) ----
      // The host's currentId is authoritative — after postLayout+tray it pushSelect()s the retained id, overriding
      // the canvas — so pin the exact predicate (retainSelectionId): a tray component whose Items were just edited
      // (a ContextMenuStrip) stays selected, NOT snapped to the form; a vanished id falls back to 'this'. Before the
      // fix consulted the tray, editing a tray ctx-menu's Items dropped the selection to the form.
      {
        const rc = [{ id: 'menuStrip1' }, { id: 'panel1' }, { id: 'this' }];
        const rt = [{ id: 'contextMenuStrip1' }, { id: 'cutItem' }, { id: 'pasteItem' }];
        if (retainSelectionId('contextMenuStrip1', rc, rt) !== 'contextMenuStrip1') throw new Error('retention: a selected tray ContextMenuStrip must survive a full re-render (must not snap to the form)');
        if (retainSelectionId('panel1', rc, rt) !== 'panel1') throw new Error('retention: a selected visual control must survive a full re-render');
        if (retainSelectionId('this', rc, rt) !== 'this') throw new Error('retention: the root selection must survive');
        if (retainSelectionId('deletedItem', rc, rt) !== 'this') throw new Error('retention: a vanished selection must fall back to the form (this)');
        if (retainSelectionId('cutItem', rc, []) !== 'this') throw new Error('retention: a former tray id absent from an empty tray must fall back to the form');
        console.log('e2e: selection-retention verified — a tray ContextMenuStrip (whose Items were edited) and visual controls survive a full re-render; a vanished id falls back to the form (this)');
      }

      // ---- net48 mirror: the compiled engine must AGREE on the off-tree-ContextMenuStrip partition ----
      // The net9 leg above proved the source-interpreted partition; this compiles the SAME sample into a net48
      // assembly and drives the net48 engine's RenderCompiledWithLayout, asserting BOTH engines put the
      // ContextMenuStrip in the tray (never a phantom control) and agree on the visual-control id set. Skips
      // gracefully when the net48 engine exe or its build toolchain isn't available (keeps the net9-only e2e green).
      const net48Exe = process.env.WFD_ENGINE_NET48 || path.join(repo, 'engine-net48', 'bin', 'Release', 'net48', 'WinFormsDesigner.Engine.Net48.exe');
      const ctxFixtureDir = path.join(repo, 'fixtures', 'Net48CtxFixture');
      const ctxFixtureDll = path.join(ctxFixtureDir, 'bin', 'Release', 'net48', 'Net48CtxFixture.dll');
      const inheritedBaseFormDes = path.join(repo, 'engine', 'samples', 'InheritedBaseForm.Designer.cs');
      const inheritedBaseFormCs = path.join(repo, 'engine', 'samples', 'InheritedBaseForm.cs');
      const derivedFormCs = path.join(repo, 'engine', 'samples', 'DerivedForm.cs');
      // Every LINKED sample must be a staleness input (ensureNet48Fixture covers the csproj + fixture-local companions
      // itself). NotifyIconForm.Designer.cs was linked but missing here, so editing it could serve a stale fixture DLL
      // on a local on-demand run (CI's unconditional build masked it).
      const notifyIconFormDes = path.join(repo, 'engine', 'samples', 'NotifyIconForm.Designer.cs');
      const treeFormDes = path.join(repo, 'engine', 'samples', 'TreeForm.Designer.cs');
      const treeFormCs = path.join(repo, 'engine', 'samples', 'TreeForm.cs');
      const tabFormDes = path.join(repo, 'engine', 'samples', 'TabForm.Designer.cs');
      const tabFormCs = path.join(repo, 'engine', 'samples', 'TabForm.cs');
      // Make an unavailable net48 environment a VISIBLE skip (a coverage gap, not a silent pass) so the
      // cross-runtime legs — including the S2 inherited-form parity proof — are never mistaken for having run. A fixture
      // COMPILE failure is separately logged to stderr by ensureNet48Fixture (a bad <Compile> link surfaces there).
      const net48FixtureReady = fs.existsSync(ctxForm) && fs.existsSync(net48Exe)
        && ensureNet48Fixture(ctxFixtureDir, ctxFixtureDll, [ctxForm, overflowForm, imageListForm, compRefForm48, notifyIconFormDes, derivedForm, derivedFormCs, inheritedBaseFormDes, inheritedBaseFormCs, treeFormDes, treeFormCs, tabFormDes, tabFormCs]);
      if (!net48FixtureReady) {
        const message = 'net48 cross-runtime legs unavailable: build engine-net48 and install the .NET Framework 4.8 targeting toolchain';
        if (process.env.WFD_REQUIRE_NET48 === '1') throw new Error(message);
        console.log(`e2e: SKIPPED ${message}`);
      }
      if (net48FixtureReady) {
        const n48 = await startEngine(net48Exe, { onLog: (l) => console.error(l) });
        try {
          // ---- 0.10.0 S2 cross-runtime: net48 renders the inherited form CORRECTLY (no banner) ----
          // net48 instantiates the real compiled DerivedForm, so the base ctor runs and baseButton is present
          // ALONGSIDE derivedButton — the very control net9 silently drops. This is why S2's banner is net9-only:
          // net48 has no inherited-form gap. The MEANINGFUL proof is control PRESENCE (baseButton + derivedButton);
          // the inheritedBase=false check is secondary (the net48 adapter hardcodes it — so it's a
          // documentation assert, not an engine test). NOTE: reaching this requires the net48 toolchain AND a clean
          // fixture build; a compile failure or absent toolchain SKIPS this leg (a coverage gap, not a pass.
          const derived48 = await renderCompiledWithLayout(n48, derivedForm, ctxFixtureDll, 'SampleApp.DerivedForm');
          const derived48Ids = derived48.controls.map((c) => c.id).sort();
          if (!derived48Ids.includes('baseButton')) throw new Error(`S2 net48: the base control (baseButton) must render via real inheritance — got [${derived48Ids.join(', ')}]`);
          if (!derived48Ids.includes('derivedButton')) throw new Error(`S2 net48: the derived control (derivedButton) must render — got [${derived48Ids.join(', ')}]`);
          if (derived48.inheritedBase) throw new Error('S2 net48: the compiled engine must NOT flag inheritedBase — it renders the real base, so the banner is net9-only');
          console.log(`e2e: 0.10.0 S2 net48 inherited-form parity verified — compiled DerivedForm renders BOTH baseButton + derivedButton (no gap), inheritedBase=false (net9 drops baseButton, so the banner is net9-only)`);

          // ---- INTERPRETED render (VS model) — the net48 engine renders the LIVE .Designer.cs source
          // by instantiating the BASE type and replaying the parsed IR onto it, instead of the compiled last build.
          // DerivedForm is the strongest proof: visual inheritance. The interpreter must surface baseButton (inherited,
          // from the compiled base instance) AND derivedButton (current source), matching the compiled control set.
          const derivedSrc = fs.readFileSync(derivedForm, 'utf8');
          const di = await renderInterpretedWithLayout(n48, derivedForm, ctxFixtureDll, derivedSrc, 'SampleApp.DerivedForm');
          if (di.renderMode !== 'interpreted') throw new Error(`net48: DerivedForm must render INTERPRETED — got ${di.renderMode} (${di.fallbackReason})`);
          if (di.png.length === 0) throw new Error('net48: interpreted render produced no PNG');
          const diIds = di.controls.map((c) => c.id).sort();
          if (!diIds.includes('baseButton')) throw new Error(`net48: interpreted DerivedForm must surface the INHERITED baseButton — got [${diIds.join(', ')}]`);
          if (!diIds.includes('derivedButton')) throw new Error(`net48: interpreted DerivedForm must render the current-source derivedButton — got [${diIds.join(', ')}]`);
          // geometry parity with the compiled render (the differential-comparator contract): same field-backed rects.
          for (const c of derived48.controls.filter((x) => !x.isRoot && diIds.includes(x.id))) {
            const b = di.controls.find((x) => x.id === c.id)!;
            if (Math.abs(c.x - b.x) > 2 || Math.abs(c.y - b.y) > 2 || Math.abs(c.width - b.width) > 2 || Math.abs(c.height - b.height) > 2)
              throw new Error(`net48: interpreted geometry diverges for ${c.id} — compiled (${c.x},${c.y},${c.width}x${c.height}) vs interpreted (${b.x},${b.y},${b.width}x${b.height})`);
          }
          // and a form whose IC uses constructs the v1 IR doesn't cover FALLS BACK with a named reason (never silent).
          const ilSrc = fs.readFileSync(imageListForm, 'utf8');
          const ilInterp = await renderInterpretedWithLayout(n48, imageListForm, ctxFixtureDll, ilSrc, 'SampleApp.ImageListForm');
          if (ilInterp.renderMode !== 'compiledFallback') throw new Error(`net48: ImageListForm (ImageList images) must FALL BACK — got ${ilInterp.renderMode}`);
          if (!ilInterp.fallbackReason) throw new Error('net48: a fallback must carry a named reason (never silent)');
          if (ilInterp.png.length === 0) throw new Error('net48: a compiled fallback still renders a picture');
          console.log(`e2e: net48 INTERPRETED render verified — DerivedForm renders via the IR interpreter (base instantiated, VS model) surfacing inherited baseButton + current-source derivedButton with geometry parity to compiled; ImageListForm falls back (${ilInterp.fallbackReason}) with a picture + reason, never silent`);

          // ---- IR coverage: TreeView (nodes are LOCAL variables, bottom-up) — the TreeNode interpreter subsystem must
          // render TreeForm interpreted (not fall back), proving local-variable node construction + Nodes.AddRange.
          const treeSrc = fs.readFileSync(treeFormDes, 'utf8');
          const treeI = await renderInterpretedWithLayout(n48, treeFormDes, ctxFixtureDll, treeSrc, 'SampleApp.TreeForm');
          if (treeI.renderMode !== 'interpreted') throw new Error(`TreeNode: TreeForm must render INTERPRETED — got ${treeI.renderMode} (${treeI.fallbackReason})`);
          if (!treeI.controls.some((c) => c.id === 'treeView1')) throw new Error('TreeNode: the TreeView control must render');
          console.log('e2e: TreeNode subsystem verified — TreeForm (nodes serialized as local variables, nested via ctor arrays + Nodes.AddRange) renders INTERPRETED, not fallback');

          // ---- interpreted DESCRIBE parity. The property panel must read the INTERPRETED
          // live-source instance, not the compiled build. Edit okButton.Text in an IN-MEMORY buffer (not the build),
          // then assert the interpreted describe reflects the edit while the compiled describe (of the unmodified build)
          // shows the built value — proving the panel matches the interpreted canvas on an unsaved edit. Also assert the
          // LOGICAL root identity (name + child.parent = the derived form, not the base 'Form') and that reference
          // candidates come from the interpreter's identity model, and that an unknown id is fail-closed (null, never a
          // compiled substitute).
          {
            const crBase = fs.readFileSync(compRefForm48, 'utf8');
            const crEdited = crBase.replace('this.okButton.Text = "OK";', 'this.okButton.Text = "OK-EDITED";');
            if (crEdited === crBase) throw new Error('could not stage the okButton.Text edit');
            const crType = 'WinFormsDesigner.Samples.ComponentRefForm';

            const iOk = await describeInterpretedComponent(n48, compRefForm48, ctxFixtureDll, crEdited, 'okButton', crType);
            if (!iOk) throw new Error('interpreted describe of okButton returned null (must interpret)');
            const iText = iOk.properties.find((p) => p.name === 'Text')?.value;
            if (iText !== 'OK-EDITED') throw new Error(`interpreted describe must read the LIVE edited Text — got "${iText}"`);

            const cOk = await describeCompiledComponent(n48, compRefForm48, ctxFixtureDll, 'okButton', crType);
            const cText = cOk?.properties.find((p) => p.name === 'Text')?.value;
            if (cText !== 'OK') throw new Error(`compiled describe must read the BUILT Text — got "${cText}"`);

            const iRoot = await describeInterpretedComponent(n48, compRefForm48, ctxFixtureDll, crBase, 'this', crType);
            if (iRoot?.name !== 'ComponentRefForm') throw new Error(`interpreted root name must be the LOGICAL type — got "${iRoot?.name}"`);
            if (iOk.parent !== 'ComponentRefForm') throw new Error(`interpreted child parent must be the LOGICAL root — got "${iOk.parent}"`);
            const acceptCand = iRoot.properties.find((p) => p.name === 'AcceptButton')?.standardValues ?? [];
            if (!acceptCand.includes('okButton') || !acceptCand.includes('cancelButton'))
              throw new Error(`interpreted reference candidates must come from the identity model — got [${acceptCand.join(', ')}]`);

            const iBogus = await describeInterpretedComponent(n48, compRefForm48, ctxFixtureDll, crBase, 'no_such_field', crType);
            if (iBogus !== null) throw new Error('interpreted describe of an unknown id must be null (panel unavailable, never a compiled substitute)');

            console.log('e2e:  interpreted-describe RPC verified — the interpreted describe reads the LIVE source (okButton.Text "OK-EDITED" while the build says "OK"), reports the logical root identity (name + child.parent = ComponentRefForm, not the base Form), draws reference candidates from the interpreter identity model (okButton, cancelButton), and returns null (fail-closed) for an unknown id; the host loadProps/loadItemProps/describeFor route to this endpoint when the canvas is interpreted');
          }

          // ---- interpreted TAB view-state. TabForm interprets (SelectedIndex=0 → page 1's
          // pageButton1); a transient selected-tab override renders the OTHER page's content STAYING interpreted — the
          // engine foundation for a tab-click that switches pages without flipping the canvas to the compiled build.
          {
            const tabSrc = fs.readFileSync(tabFormDes, 'utf8');
            const tabDefault = await renderInterpretedWithLayout(n48, tabFormDes, ctxFixtureDll, tabSrc, 'SampleApp.TabForm');
            if (tabDefault.renderMode !== 'interpreted') throw new Error(`tabs: TabForm must interpret — got ${tabDefault.renderMode} (${tabDefault.fallbackReason})`);
            if (!tabDefault.controls.some((c) => c.id === 'pageButton1')) throw new Error('tabs: default view (SelectedIndex=0) must show page 1 (pageButton1)');
            const tabP2 = await renderInterpretedWithLayout(n48, tabFormDes, ctxFixtureDll, tabSrc, 'SampleApp.TabForm', undefined, 0, 0, ['tabControl1=tabPage2']);
            if (tabP2.renderMode !== 'interpreted') throw new Error(`tabs: the view-state render must STAY interpreted — got ${tabP2.renderMode}`);
            if (!tabP2.controls.some((c) => c.id === 'pageLabel2')) throw new Error('tabs: the selected-tab override must render page 2 (pageLabel2)');
            if (tabP2.controls.some((c) => c.id === 'pageButton1')) throw new Error('tabs: the page-2 view must NOT still show page-1 content (pageButton1)');
            // a foreign/unresolvable override is a safe no-op (narrow adapter) — stays on the source-selected page 1
            const tabBogus = await renderInterpretedWithLayout(n48, tabFormDes, ctxFixtureDll, tabSrc, 'SampleApp.TabForm', undefined, 0, 0, ['tabControl1=no_such_page']);
            if (!tabBogus.controls.some((c) => c.id === 'pageButton1')) throw new Error('tabs: a bogus tab override must be a no-op (stay on the source-selected page)');
            console.log('e2e:  interpreted tab view-state verified — TabForm interprets (default page 1 = pageButton1); a "tabControl1=tabPage2" override renders page 2 (pageLabel2) STAYING interpreted (never the compiled build); a bogus override is a safe no-op');
          }

          // ---- FakeVendor corpus — the interpreter must reproduce DEVEXPRESS-LIKE patterns without a
          // real vendor install (legally uncommittable). FakeVendorForm uses a control with an Appearance SUB-OBJECT
          // (property-chain assignment) and an ISupportInitialize control (real Begin/EndInit replay). It must render
          // INTERPRETED with geometry parity to the compiled truth. Built by CI ('Build sample fixtures'); on a local
          // box without it, WFD_REQUIRE_NET48 makes the absence a visible failure, else a skip.
          const fakeVendorDll = path.join(repo, 'fixtures', 'FakeVendor', 'bin', 'Release', 'net48', 'FakeVendor.dll');
          const fakeVendorSrc = path.join(repo, 'fixtures', 'FakeVendor', 'FakeVendorForm.Designer.cs');
          if (!fs.existsSync(fakeVendorDll)) {
            const built = spawnSync('dotnet', ['build', path.join(repo, 'fixtures', 'FakeVendor'), '-c', 'Release', '-p:PlatformTarget=x64', '--nologo', '-v', 'q'], { encoding: 'utf8' });
            if (built.status !== 0 && process.env.WFD_REQUIRE_NET48 === '1') throw new Error('FakeVendor fixture failed to build: ' + ((built.stderr || built.stdout || '').trim().split('\n').slice(-3).join(' | ')));
          }
          if (fs.existsSync(fakeVendorDll)) {
            const fvSrc = fs.readFileSync(fakeVendorSrc, 'utf8');
            const fvType = 'FakeVendor.FakeVendorForm';
            const fvI = await renderInterpretedWithLayout(n48, fakeVendorSrc, fakeVendorDll, fvSrc, fvType);
            if (fvI.renderMode !== 'interpreted') throw new Error(`FakeVendor: vendor-pattern form must render INTERPRETED — got ${fvI.renderMode} (${fvI.fallbackReason})`);
            const fvIds = fvI.controls.filter((c) => !c.isRoot).map((c) => c.id).sort();
            if (!fvIds.includes('fancyButton1') || !fvIds.includes('dataPanel1')) throw new Error(`FakeVendor: both vendor controls must render — got [${fvIds.join(', ')}]`);
            const fvC = await renderCompiledWithLayout(n48, fakeVendorSrc, fakeVendorDll, fvType);
            for (const c of fvC.controls.filter((x) => !x.isRoot && fvIds.includes(x.id))) {
              const b = fvI.controls.find((x) => x.id === c.id)!;
              if (Math.abs(c.x - b.x) > 2 || Math.abs(c.y - b.y) > 2 || Math.abs(c.width - b.width) > 2 || Math.abs(c.height - b.height) > 2)
                throw new Error(`FakeVendor: interpreted geometry diverges for ${c.id} — compiled (${c.x},${c.y},${c.width}x${c.height}) vs interpreted (${b.x},${b.y},${b.width}x${b.height})`);
            }
            console.log('e2e: FakeVendor corpus verified — a DevExpress-like form (Appearance sub-object property-chain + ISupportInitialize control) renders INTERPRETED with geometry parity to compiled, proving vendor-pattern interpretation without a real vendor install');
          } else {
            console.log('e2e: SKIPPED FakeVendor (fixture not built; set WFD_REQUIRE_NET48=1 to require it)');
          }

          // ---- 0.11.0 ImageList editor: net48 ImageStream serialize primitive (the binary WRITE linchpin) ----
          // Serialize two real 16x16 PNGs into a VS-format ImageListStreamer blob. The engine self-round-trips the blob
          // (deserialize → count) so a corrupt/empty payload can never reach a .resx; assert Ok, the binary mimetype,
          // the key order, and count==2. No compiled assembly is touched — the primitive builds a fresh ImageList from
          // raw bytes, which is why the host may route it through net48 even for a pure .NET project.
          const RED16 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAdSURBVDhPY/jPwPCfEsyALkAqHjVg1IBRAwaLAQAwxP4Q7zYsrwAAAABJRU5ErkJggg==';
          const BLUE16 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAzSURBVDhPpcihEQAwEASh67/pTwGrmAgM2+7+JFRCJVRCJVRCJVRCJVRCJVRCJVRCJcwDMqb+ELsBUIUAAAAASUVORK5CYII=';
          const ilRes = await serializeImageList(n48, { width: 16, height: 16, colorDepth: 'Depth32Bit', transparentColor: 'Transparent', images: [{ dataBase64: RED16, key: 'red' }, { dataBase64: BLUE16, key: 'blue' }] });
          if (!ilRes.ok) throw new Error('ImageList serialize: net48 primitive failed — ' + ilRes.reason);
          if (ilRes.mimeType !== 'application/x-microsoft.net.object.binary.base64') throw new Error('ImageList serialize: wrong mimetype ' + ilRes.mimeType);
          if (ilRes.count !== 2) throw new Error('ImageList serialize: self round-trip count ' + ilRes.count + ' (expected 2)');
          if (ilRes.keys.join(',') !== 'red,blue') throw new Error('ImageList serialize: key order [' + ilRes.keys.join(',') + '] (expected red,blue)');
          if (!ilRes.base64 || ilRes.base64.length < 1000 || /\s/.test(ilRes.base64)) throw new Error('ImageList serialize: blank/whitespaced base64 payload (len ' + ilRes.base64.length + ')');
          // NEGATIVE: non-image bytes must be refused before anything is serialized (fed UI-supplied bytes).
          const ilBad = await serializeImageList(n48, { width: 16, height: 16, colorDepth: '', transparentColor: '', images: [{ dataBase64: Buffer.from('not an image').toString('base64'), key: 'x' }] });
          if (ilBad.ok) throw new Error('ImageList serialize: non-image bytes must be refused');
          console.log(`e2e: 0.11.0 ImageList serialize primitive (net48) verified — 2 PNGs → ${ilRes.base64.length}-char binary.base64 ImageStream blob, self round-trips to 2 images, keys [${ilRes.keys.join(',')}]; non-image bytes refused`);

          // ---- 0.11.0 ImageList editor: net48 DESERIALIZE (READ side — show current images before editing) ----
          const ilRead = await deserializeImageList(n48, ilRes.base64);
          if (!ilRead.ok) throw new Error('ImageList deserialize: failed — ' + ilRead.reason);
          if (ilRead.images.length !== 2) throw new Error('ImageList deserialize: got ' + ilRead.images.length + ' images (expected 2)');
          if (!ilRead.images.every((i) => isPng(Buffer.from(i.dataBase64, 'base64')))) throw new Error('ImageList deserialize: an image is not valid PNG');
          if (ilRead.width !== 16 || ilRead.height !== 16) throw new Error('ImageList deserialize: size ' + ilRead.width + 'x' + ilRead.height + ' (expected 16x16)');
          // The ImageStream blob does NOT carry keys — keys are a managed ImageCollection concept the designer restores
          // via SetKeyName (why VS emits them separately). So deserialize returns EMPTY keys; the host pairs images (by
          // index) with the SetKeyName keys parsed from the designer. Pin that: the blob-side keys are blank.
          if (ilRead.images.some((i) => i.key !== '')) throw new Error('ImageList deserialize: the blob must not carry keys (they live in the designer SetKeyName calls)');
          // round-trip: re-serialize the deserialized image bytes (host re-attaches keys) → still 2 images (lossless loop).
          const withKeys = ilRead.images.map((im, i) => ({ dataBase64: im.dataBase64, key: ['red', 'blue'][i] }));
          const ilReSer = await serializeImageList(n48, { width: ilRead.width, height: ilRead.height, colorDepth: ilRead.colorDepth, transparentColor: ilRead.transparentColor, images: withKeys });
          if (!ilReSer.ok || ilReSer.count !== 2 || ilReSer.keys.join(',') !== 'red,blue') throw new Error('ImageList deserialize→serialize round-trip lost images/keys');
          // NEGATIVE: a foreign/garbage blob deserializes to ok=false (never throws).
          const ilReadBad = await deserializeImageList(n48, Buffer.from('not a stream').toString('base64'));
          if (ilReadBad.ok) throw new Error('ImageList deserialize: a foreign blob must return ok=false');

          // 1.0 strengthened parity: committing an ImageList edit must update the already-cached compiled form now,
          // rather than requiring a rebuild/reopen. The dependent button's converter is a useful observable: after
          // replacing [first,second] with [red,blue], its ImageKey dropdown must immediately expose the new keys.
          await setCompiledImageListLive(n48, imageListForm, ctxFixtureDll, 'imageList1', ilRes.base64, ilRes.keys);
          const ilLiveButton = await describeCompiledComponent(n48, imageListForm, ctxFixtureDll, 'button1');
          const liveKeys = ilLiveButton?.properties?.find((p) => p.name === 'ImageKey')?.standardValues ?? [];
          if (!(liveKeys.includes('red') && liveKeys.includes('blue')) || liveKeys.includes('first') || liveKeys.includes('second')) {
            throw new Error(`ImageList live reconcile (net48): expected new keys [red, blue] immediately, got [${liveKeys.join(', ')}]`);
          }

          // The same compiled describe path now surfaces source-derived design-time pseudo-properties. These are not
          // runtime TypeDescriptor properties, so their presence proves SourceMetadata parity with the modern engine.
          const mod48 = ilLiveButton?.properties?.find((p) => p.name === 'Modifiers');
          const gen48 = ilLiveButton?.properties?.find((p) => p.name === 'GenerateMember');
          if (mod48?.designTime !== true || mod48.value !== 'Private' || mod48.readOnly) {
            throw new Error(`Modifiers (net48): expected editable design-time Private, got ${JSON.stringify(mod48)}`);
          }
          if (gen48?.designTime !== true || gen48.value !== 'true' || !gen48.readOnly) {
            throw new Error(`GenerateMember (net48): expected read-only design-time true, got ${JSON.stringify(gen48)}`);
          }
          console.log('e2e: 1.0 net48 parity verified — ImageList live reconciliation updates dependent key choices immediately; Modifiers=Private and GenerateMember=true surface through compiled describe');
          await setCompiledImageListLive(n48, imageListForm, ctxFixtureDll, 'imageList1', ilRes.base64, ['first', 'second']);
          console.log(`e2e: 0.11.0 ImageList deserialize (net48 READ) verified — blob → 2 valid-PNG images (16x16, blob carries no keys — designer-side), read→re-attach-keys→serialize round-trips to 2 (keys red,blue); foreign blob → ok=false`);

          // ---- 0.11.0 ImageList editor: net9 SetImageList (embed blob + rewrite designer) ----
          // Take the net48 blob and embed it into ImageListForm's designer + a fresh .resx: the in-code Images.Add
          // lines must be REMOVED, an ImageStream = resources.GetObject(...) assignment inserted, SetKeyName(i,key)
          // emitted per image, the ComponentResourceManager local ensured, and the .resx gain the binary ImageStream
          // node. This is the write path the images editor drives (host then persists both texts atomically+undoably).
          const ilSet = await setImageList(engine, imageListForm, 'imageList1', ilRes.base64, ilRes.keys, null, null);
          if (!ilSet.safe || ilSet.designerText === null || ilSet.resxText === null) throw new Error('ImageList SetImageList: rejected — ' + ilSet.reason);
          if (/imageList1\.Images\.Add\s*\(/.test(ilSet.designerText)) throw new Error('ImageList SetImageList: in-code Images.Add must be removed');
          if (!/imageList1\.ImageStream\s*=\s*\(\(System\.Windows\.Forms\.ImageListStreamer\)\(resources\.GetObject\("imageList1\.ImageStream"\)\)\)/.test(ilSet.designerText)) throw new Error('ImageList SetImageList: ImageStream assignment not emitted');
          if (!/imageList1\.Images\.SetKeyName\(0, "red"\)/.test(ilSet.designerText) || !/imageList1\.Images\.SetKeyName\(1, "blue"\)/.test(ilSet.designerText)) throw new Error('ImageList SetImageList: SetKeyName(i,key) not emitted in order');
          if (!/ComponentResourceManager resources = new/.test(ilSet.designerText)) throw new Error('ImageList SetImageList: resources local not ensured');
          if (ilSet.resxKey !== 'imageList1.ImageStream') throw new Error('ImageList SetImageList: wrong resx key ' + ilSet.resxKey);
          if (!/name="imageList1\.ImageStream"/.test(ilSet.resxText) || !/application\/x-microsoft\.net\.object\.binary\.base64/.test(ilSet.resxText)) throw new Error('ImageList SetImageList: resx missing the binary ImageStream node');
          if (!/imageList1\.ImageSize = new System\.Drawing\.Size\(16, 16\)/.test(ilSet.designerText)) throw new Error('ImageList SetImageList: an unrelated statement (ImageSize) must be preserved');
          // NEGATIVE: an invalid component id must be refused (no injection into the LHS / resx key).
          const ilBadId = await setImageList(engine, imageListForm, 'bad id"; evil', ilRes.base64, ilRes.keys, null, null);
          if (ilBadId.safe) throw new Error('ImageList SetImageList: an invalid component id must be refused');
          // NEGATIVE: an arbitrary binary payload (valid base64, but NOT a serialized ImageListStreamer) must
          // be refused — net9 must not be a confused deputy that embeds any BinaryFormatter blob as an object resource.
          const ilBadBlob = await setImageList(engine, imageListForm, 'imageList1', Buffer.from('this is not an ImageList stream').toString('base64'), ['x'], null, null);
          if (ilBadBlob.safe) throw new Error('ImageList SetImageList: a non-ImageListStreamer blob must be refused');
          console.log(`e2e: 0.11.0 ImageList editor SetImageList (net9) verified — in-code Images.Add removed, ImageStream=GetObject + SetKeyName(0,"red")/(1,"blue") + resources local emitted, .resx gains the binary node, ImageSize preserved; invalid id refused`);

          // ---- 0.11.0 net48 undo reconcile: discardCompiledLive drops the STALE live instance ----
          // Render (populates the live cache), live-mutate a control's Location (shows on the compiled INSTANCE), then
          // discardCompiledLive → the next render re-instantiates from the compiled BASELINE, so the mutation is GONE.
          // This is exactly what the host does on undo/redo/revert (net48 renders the instance, not the reverted text),
          // so a reverted edit no longer lingers in the preview.
          // Use derivedForm's free-positioned Button (a docked control's Location can't move) as the probe.
          const reconType = 'SampleApp.DerivedForm';
          const reconBase = await renderCompiledWithLayout(n48, derivedForm, ctxFixtureDll, reconType);
          const probe = reconBase.controls.find((c) => c.id === 'derivedButton') || reconBase.controls.find((c) => c.id !== 'this' && c.type.endsWith('Button'));
          if (probe) {
            const baseX = probe.x;
            const moved = await setCompiledPropertyLive(n48, derivedForm, ctxFixtureDll, probe.id, 'Location', `${probe.x + 41}, ${probe.y + 23}`, reconType);
            const movedCtl = moved.controls.find((c) => c.id === probe.id);
            if (!movedCtl || movedCtl.x === baseX) throw new Error(`net48 reconcile: a live Location edit must change the rendered x (baseline ${baseX}, got ${movedCtl?.x})`);
            const dropped = await discardCompiledLive(n48, derivedForm, ctxFixtureDll, reconType);
            if (!dropped) throw new Error('net48 reconcile: discardCompiledLive must report it dropped the cached instance');
            const afterDrop = await renderCompiledWithLayout(n48, derivedForm, ctxFixtureDll, reconType);
            const revertedCtl = afterDrop.controls.find((c) => c.id === probe.id);
            if (!revertedCtl || revertedCtl.x !== baseX) throw new Error(`net48 reconcile: after discard the control must revert to baseline x=${baseX} (got ${revertedCtl?.x}) — the undone live edit lingered`);
            console.log(`e2e: 0.11.0 net48 undo reconcile verified — live Location edit on ${probe.id} moved x ${baseX}→${movedCtl.x}; discardCompiledLive drops the stale instance; next render reverts to baseline x=${baseX}`);

            // ---- 1.0.0: liveInstanceId / liveBuildId are DIAGNOSTIC lifecycle facts (the divergence lock they once
            // fed was descoped — but the ids are still reported for diagnostics + the release proof
            // below depends on the build id advancing on a real rebuild). Pin the engine contract on the real engine:
            // (1) every response carries an instance id;
            // (2) it is STABLE while the engine reuses its cached instance (a live edit and a plain re-render are the
            // same instance);
            // (3) it CHANGES once the instance is actually dropped (discard / crash / release reload).
            // liveBuildId is STABLE across an edit and a discard (same build) and advances ONLY on a real rebuild.
            if (!reconBase.liveInstanceId) throw new Error('1.0.0: a net48 render must report a liveInstanceId (diagnostics + lifecycle)');
            if (moved.liveInstanceId !== reconBase.liveInstanceId)
              throw new Error(`1.0.0: a live edit reuses the cached instance, so liveInstanceId must be STABLE (${reconBase.liveInstanceId} → ${moved.liveInstanceId})`);
            if (afterDrop.liveInstanceId === reconBase.liveInstanceId)
              throw new Error(`1.0.0: after discardCompiledLive the next render re-instantiates, so liveInstanceId MUST change (still ${afterDrop.liveInstanceId})`);
            if (!afterDrop.liveInstanceId) throw new Error('1.0.0: the post-discard render must still report a liveInstanceId');
            if (!reconBase.liveBuildId) throw new Error('1.0.0: a net48 render must report a liveBuildId');
            if (moved.liveBuildId !== reconBase.liveBuildId || afterDrop.liveBuildId !== reconBase.liveBuildId)
              throw new Error(`1.0.0: liveBuildId must be STABLE across a live edit and a discard (no rebuild happened): ${reconBase.liveBuildId} → edit ${moved.liveBuildId} → discard ${afterDrop.liveBuildId}`);
            console.log(`e2e: 1.0.0 net48 lifecycle ids verified — liveInstanceId reported on every render, STABLE across a live edit (${reconBase.liveInstanceId.slice(0, 8)}…) and CHANGED after discard (→ ${afterDrop.liveInstanceId.slice(0, 8)}…); liveBuildId STABLE (${reconBase.liveBuildId}) across both (a rebuild below advances it)`);

            // ---- 1.0.0: releaseCompiledAssembly actually lets the user REBUILD their own project ----
            // The preview loads the user's dlls in place (ShadowCopyFiles must stay off for delay-signed vendor
            // graphs), which PINS them: with a net48 designer live, the user's own build failed outright with
            // MSB3027 "The file is locked by: WinFormsDesigner.Engine.Net48". Nothing released them — so every
            // "rebuild to refresh the preview" instruction in the product was unfollowable, and the mtime-reload
            // in DomainManager could never fire because the mtime could never change. Prove BOTH halves against a
            // real MSBuild, since a mocked handle proves nothing about a file lock:
            // (1) while the assembly is loaded, a rebuild FAILS (the bug is real, and this test would rot silently
            // if it ever stopped reproducing);
            // (2) after releaseCompiledAssembly, the SAME rebuild SUCCEEDS (the fix is real);
            // (3) rendering still works afterwards, from a freshly loaded domain with a new instance id.
            const ctxFixtureProj = path.join(ctxFixtureDir, 'Net48CtxFixture.csproj');
            const rebuild = () => spawnSync('dotnet', ['build', ctxFixtureProj, '-c', 'Release', '-t:Rebuild', '--nologo', '-v:quiet'],
              { encoding: 'utf8', shell: true });
            const lockedBuild = rebuild();
            if (lockedBuild.status === 0)
              throw new Error('1.0.0 release-for-rebuild: expected the build to FAIL while the assembly is loaded (the lock this fix exists for). If the engine no longer pins the output, delete this half of the test — but verify why first.');
            if (!/MSB3027|MSB3021|being used by another process/i.test((lockedBuild.stdout || '') + (lockedBuild.stderr || '')))
              throw new Error(`1.0.0 release-for-rebuild: the build failed, but not with a file-lock error — this test is no longer proving what it claims. Output: ${(lockedBuild.stdout || '').slice(-400)}`);

            const released = await releaseCompiledAssembly(n48, ctxFixtureDll);
            if (released.released !== 1 || released.failed !== 0) throw new Error(`1.0.0 release-for-rebuild: releaseCompiledAssembly must report it unloaded the domain (got ${JSON.stringify(released)})`);
            const freeBuild = rebuild();
            if (freeBuild.status !== 0)
              throw new Error(`1.0.0 release-for-rebuild: after releasing the assembly the user's rebuild MUST succeed — the handles were not returned. Output: ${((freeBuild.stdout || '') + (freeBuild.stderr || '')).slice(-600)}`);

            const afterRebuild = await renderCompiledWithLayout(n48, derivedForm, ctxFixtureDll, reconType);
            if (!afterRebuild.liveInstanceId) throw new Error('1.0.0 release-for-rebuild: the post-rebuild render must still report a liveInstanceId');
            if (afterRebuild.liveInstanceId === afterDrop.liveInstanceId)
              throw new Error('1.0.0 release-for-rebuild: the rebuilt assembly must load into a NEW instance');
            // 1.0.0 — the rebuild MUST advance liveBuildId (a different assembly on disk); the release-for-rebuild
            // proof depends on that, and it is the diagnostic signal a rebuild happened.
            if (afterRebuild.liveBuildId === reconBase.liveBuildId)
              throw new Error(`1.0.0: a real rebuild must advance liveBuildId (still ${afterRebuild.liveBuildId})`);
            // Repeated release is idempotent: the first call already unloaded the (rebuilt) domain, so a second finds
            // nothing loaded (attempted 0) and never throws.
            const again = await releaseCompiledAssembly(n48, ctxFixtureDll);
            if (again.failed !== 0) throw new Error(`1.0.0 release-for-rebuild: a repeat release must not report a failure (got ${JSON.stringify(again)})`);
            console.log(`e2e: 1.0.0 net48 release-for-rebuild verified — a real MSBuild rebuild FAILS with a file lock while the preview holds the assembly, SUCCEEDS after releaseCompiledAssembly, loads the fresh build into a new instance (${afterDrop.liveInstanceId.slice(0, 8)}… → ${afterRebuild.liveInstanceId.slice(0, 8)}…) AND advances liveBuildId (${reconBase.liveBuildId} → ${afterRebuild.liveBuildId})`);
          }

          const r48 = await renderCompiledWithLayout(n48, ctxForm, ctxFixtureDll);
          if (r48.controls.some((c) => c.type.endsWith('ContextMenuStrip'))) throw new Error('net48 ctx: a ContextMenuStrip leaked into the compiled control layout (phantom rect)');
          const chip48 = r48.tray.find((t) => t.id === 'contextMenuStrip1');
          if (!chip48) throw new Error(`net48 ctx: contextMenuStrip1 missing from the compiled tray (got [${r48.tray.map((t) => t.id).join(', ')}])`);
          if (!chip48.type.endsWith('ContextMenuStrip')) throw new Error(`net48 ctx: contextMenuStrip1 wrong type ${chip48.type}`);
          // IsStrip parity: the compiled engine must also flag an off-tree strip so the canvas opens its flyout (even
          // when empty) — a non-strip component (timer1) must report it falsy. Mirrors the net9 leg above.
          if (chip48.isStrip !== true) throw new Error('net48 ctx: contextMenuStrip1 must report isStrip=true (compiled parity — the canvas opens its flyout, even for an empty strip)');
          const timer48 = r48.tray.find((t) => t.id === 'timer1');
          if (timer48 && timer48.isStrip) throw new Error('net48 ctx: timer1 (a non-strip component) must report isStrip falsy — no flyout');
          // VS never trays strip items (parity with the net9 leg above): the compiled tray must exclude the four
          // menu/context ToolStripItems but keep timer1 (a non-visual component). Before this the net48 BuildTray
          // FieldNames scan surfaced every field-backed item as a chip.
          const n48Leaked = r48.tray.filter((t) => ['fileMenu', 'editMenu', 'cutItem', 'pasteItem', 'pasteSpecialItem', 'undoItem', 'redoItem'].includes(t.id)).map((t) => t.id);
          if (n48Leaked.length) throw new Error(`net48 ctx: ToolStripItem(s) leaked into the compiled tray [${n48Leaked.join(', ')}] — VS never trays strip items (including nested ones)`);
          if (!r48.tray.some((t) => t.id === 'timer1')) throw new Error('net48 ctx: timer1 (a non-visual component) must stay in the compiled tray — the strip-item skip must not drop non-item components');
          // cross-runtime: the two engines must agree on the VISUAL control id set (net9 = source-interpreted).
          const net9Layout = await describeLayout(engine, ctxForm);
          const net9Ids = net9Layout.controls.map((c) => c.id).sort();
          const net48Ids = r48.controls.map((c) => c.id).sort();
          if (net9Ids.join(',') !== net48Ids.join(',')) throw new Error(`net48 ctx: control partition diverges from net9 — net9 [${net9Ids.join(', ')}] vs net48 [${net48Ids.join(', ')}]`);
          // cross-runtime nested GEOMETRY parity: the flyout draws from `children`, so net48's emitted nested forest for
          // editMenu (ids/order/captions/owner) must equal net9's — a describe-only match wouldn't catch a BuildItemChildren
          // divergence (a stray Available/Placement filter, reordering, or a different id source).
          const editKids = (its: ToolStripItemBounds[]): string =>
            (its.find((i) => i.itemId === 'editMenu')?.children ?? []).map((k) => `${k.itemId}:${k.text}:${k.ownerId}`).join('|');
          const net9Kids = editKids(net9Layout.toolStripItems);
          const net48Kids = editKids(r48.toolStripItems);
          if (net9Kids.length === 0) throw new Error('net48 ctx: net9 editMenu emitted no children — the nested-geometry parity check is vacuous');
          if (net9Kids !== net48Kids) throw new Error(`net48 ctx: nested children geometry diverges from net9 — net9 [${net9Kids}] vs net48 [${net48Kids}]`);
          // cross-runtime TRAY-ITEMS parity: the tray chip's item forest (what the synthetic flyout draws from) must be
          // identical on both engines — RECURSIVELY (net48's BuildStripItemForest calls BuildItemChildren, so a nested
          // divergence in id source / filter / ordering must fail here too). Serialize ids/text/type with children nested
          // in parens; pasteItem's "Paste Special" child makes this non-vacuous for the recursive path.
          const trayItemsOf = (chip: any): string => { // eslint-disable-line @typescript-eslint/no-explicit-any
            const fmt = (its: any[]): string => (its ?? []).map((it: any) => // eslint-disable-line @typescript-eslint/no-explicit-any
              `${it.itemId}:${it.text}:${it.itemType.split('.').pop()}${it.children && it.children.length ? '(' + fmt(it.children) + ')' : ''}`).join('|');
            return fmt(chip?.items ?? []);
          };
          const net9CtxItems = trayItemsOf(net9Layout.tray.find((t) => t.id === 'contextMenuStrip1'));
          const net48CtxItems = trayItemsOf(chip48);
          if (net9CtxItems.length === 0) throw new Error('net48 ctx: net9 contextMenuStrip1 chip emitted no items — the tray-items parity check is vacuous');
          if (net9CtxItems !== net48CtxItems) throw new Error(`net48 ctx: tray chip items diverge from net9 — net9 [${net9CtxItems}] vs net48 [${net48CtxItems}]`);
          console.log(`e2e: net48 off-tree ContextMenuStrip verified — compiled render agrees with net9 (controls [${net48Ids.join(', ')}], contextMenuStrip1 tray-only, tray [${r48.tray.map((t) => t.id).join(', ')}], no strip items; editMenu nested children match net9 [${net48Kids}]; tray chip items match net9 [${net48CtxItems}])`);

          // ---- net48 item→Properties describe parity ----
          // A field-backed ToolStripItem is a Component, not a Control, so previously the net48 engine's
          // DescribeOn (ByField = Control-only) returned null for it and the item→Properties panel showed a
          // placeholder. Now DescribeOn falls back to ByFieldComponent → the item describes. Assert the compiled
          // engine returns the SAME item facts as net9 for a top-level menu item (fileMenu: Text="File", and — per
          // net9 ParentName — a Component reports no Parent). Editing is a later step; this is the read.
          const item9 = await describeComponent(engine, ctxForm, 'fileMenu');
          const item48 = await describeCompiledComponent(n48, ctxForm, ctxFixtureDll, 'fileMenu');
          if (!item9) throw new Error('net9: fileMenu (top-level menu item) failed to describe');
          if (!item48) throw new Error('net48 item describe: fileMenu returned null — DescribeOn did not fall back to ByFieldComponent');
          if (!item48.type.endsWith('ToolStripMenuItem')) throw new Error(`net48 item describe: fileMenu wrong type ${item48.type}`);
          const text9 = item9.properties?.find((p) => p.name === 'Text')?.value;
          const text48 = item48.properties?.find((p) => p.name === 'Text')?.value;
          if (text48 !== 'File') throw new Error(`net48 item describe: fileMenu.Text expected "File", got ${JSON.stringify(text48)}`);
          if (text48 !== text9) throw new Error(`net48 item describe diverges from net9: Text net9=${JSON.stringify(text9)} net48=${JSON.stringify(text48)}`);
          if (item48.parent != null) throw new Error(`net48 item describe: a Component item must report no Parent (net9 parity), got ${JSON.stringify(item48.parent)}`);
          if (item48.type !== item9.type) throw new Error(`net48 item describe: type diverges from net9 — net9 ${item9.type} vs net48 ${item48.type}`);
          console.log(`e2e: net48 item→Properties describe parity verified — fileMenu describes on both engines (type ${item48.type}, Text "${text48}", ${item48.properties?.length} props, no Parent), matching net9`);

          // reference dropdowns are CONTROL-only: a ToolStripItem's ReferenceConverter prop (ToolStripMenuItem.DropDown)
          // must NOT become a reference dropdown — the item-edit channel doesn't translate a pick (would half-wire a
          // mis-write). Pin it on both engines (fileMenu.DropDown is a real ReferenceConverter prop → [(none), ...]).
          for (const [d, en] of [[item9, 'net9'], [item48, 'net48']] as const) {
            const dd = d?.properties?.find((p) => p.name === 'DropDown');
            if (dd && (dd.referenceValues === true || (dd.standardValues && dd.standardValues.length)))
              throw new Error(`component-ref (${en}): a ToolStripItem's DropDown must NOT get a reference dropdown (item edits don't translate refEdit) — got referenceValues=${dd.referenceValues}, [${(dd.standardValues ?? []).join(', ')}]`);
          }
          // WRITE-side mirror of the item exclusion: describe never offers a reference dropdown on
          // a ToolStripItem, so a direct RPC/CLI write of a reference onto one must be REFUSED too (offer ⇔ accept) — even
          // when it is otherwise assignable. fileMenu.DropDown is a ReferenceConverter typed ToolStripDropDown, and
          // contextMenuStrip1 (a ContextMenuStrip) IS a ToolStripDropDown → assignable, so only the item-exclusion guard
          // stops it. This closes both a sibling reference and the "(this)" root token on an item (a direct-RPC bypass of
          // the host's referenceValues re-validation). A non-reference item edit (fileMenu.Text below) still applies.
          const itemRefWrite = await setCompiledPropertyLive(n48, ctxForm, ctxFixtureDll, 'fileMenu', 'DropDown', 'contextMenuStrip1');
          if (itemRefWrite.applied) throw new Error('component-ref (net48): fileMenu.DropDown=contextMenuStrip1 (an assignable reference on a ToolStripItem) was APPLIED — the write side must mirror describe and refuse a reference edit on an item');

          // ---- component-reference dropdown, COMPONENT ref (both engines — the FieldNames reverse-scan path) ----
          // ContextMenuForm's panel1.ContextMenuStrip points at contextMenuStrip1, a non-Control tray Component. Its
          // dropdown lists "(none)"+the compatible ContextMenuStrip field names and pre-selects the current one, on
          // BOTH engines. The net48 live-set resolves the picked NAME back to the component via the FieldNames reverse-
          // scan (ByField holds controls only), and "(none)" clears — the paths a control reference (ByField) doesn't
          // exercise. contextMenuStrip1's BinaryFormatter resx keeps this off the round-trip-safe serialize path.
          const cmsCheck = (d: any, engineName: string): string => { // eslint-disable-line @typescript-eslint/no-explicit-any
            const p = d?.properties?.find((x: any) => x.name === 'ContextMenuStrip'); // eslint-disable-line @typescript-eslint/no-explicit-any
            const vals: string[] = p?.standardValues ?? [];
            if (!(vals.includes('(none)') && vals.includes('contextMenuStrip1'))) throw new Error(`component-ref (${engineName}): panel1.ContextMenuStrip dropdown must include [(none), contextMenuStrip1] — got [${vals.join(', ')}]`);
            if (p?.referenceValues !== true) throw new Error(`component-ref (${engineName}): panel1.ContextMenuStrip must carry referenceValues=true`);
            if (p?.value !== 'contextMenuStrip1') throw new Error(`component-ref (${engineName}): panel1.ContextMenuStrip must pre-select "contextMenuStrip1" — got ${JSON.stringify(p?.value)}`);
            return vals.join(', ');
          };
          const cms9 = cmsCheck(await describeComponent(engine, ctxForm, 'panel1'), 'net9');
          cmsCheck(await describeCompiledComponent(n48, ctxForm, ctxFixtureDll, 'panel1'), 'net48');
          const setCmp = await setCompiledPropertyLive(n48, ctxForm, ctxFixtureDll, 'panel1', 'ContextMenuStrip', 'contextMenuStrip1');
          if (!setCmp.applied) throw new Error(`component-ref (net48): panel1.ContextMenuStrip=contextMenuStrip1 (component reverse-scan resolve) must apply live (diag: ${setCmp.diagnostics || 'none'})`);
          const setCmpNone = await setCompiledPropertyLive(n48, ctxForm, ctxFixtureDll, 'panel1', 'ContextMenuStrip', '(none)');
          if (!setCmpNone.applied) throw new Error(`component-ref (net48): panel1.ContextMenuStrip=(none) (clear) must apply live (diag: ${setCmpNone.diagnostics || 'none'})`);
          // a RESOLVABLE but WRONG-TYPE reference (menuStrip1 is a MenuStrip, not a ContextMenuStrip) must be rejected by
          // the net48 assignability contract — not silently mis-assigned or left to SetValue to throw.
          const setCmpBadType = await setCompiledPropertyLive(n48, ctxForm, ctxFixtureDll, 'panel1', 'ContextMenuStrip', 'menuStrip1');
          if (setCmpBadType.applied) throw new Error('component-ref (net48): panel1.ContextMenuStrip=menuStrip1 (a MenuStrip, not assignable) must be rejected by the assignability check');
          console.log(`e2e: component-ref dropdown COMPONENT ref verified — panel1.ContextMenuStrip [${cms9}] pre-selecting "contextMenuStrip1" on both engines; net48 live-set resolves the component via the FieldNames reverse-scan, "(none)" clears, an incompatible-type sibling is rejected`);

          // ---- net48 dirty-buffer metadata ----
          // The net48 source-metadata pass (grid bold + wired-handler) previously ALWAYS read the on-disk .Designer.cs, so
          // a just-reset item property stayed bold / a just-wired event showed unwired until Save. Now describe takes the
          // unsaved buffer. Prove it: fileMenu.Text is source-explicit from disk; describe with a buffer whose Text
          // assignment is REMOVED (what a Reset commits in-memory) → Text is no longer source-explicit (the pass parsed the
          // buffer, not the disk). Guards both the new item Reset affordance and item Event wiring on net48.
          const diskBold = item48.properties?.find((p) => p.name === 'Text')?.sourceExplicit;
          if (diskBold !== true) throw new Error('net48 dirty-metadata: fileMenu.Text should be source-explicit when read from disk (baseline)');
          const diskSrc = fs.readFileSync(ctxForm, 'utf8');
          const dirtySrc = diskSrc.replace(/\r?\n\s*this\.fileMenu\.Text = "File";/, '');
          if (dirtySrc === diskSrc) throw new Error('net48 dirty-metadata: could not craft a dirty buffer (fileMenu.Text assignment not found)');
          const dirtyDesc = await describeCompiledComponent(n48, ctxForm, ctxFixtureDll, 'fileMenu', undefined, undefined, dirtySrc);
          const dirtyBold = dirtyDesc?.properties?.find((p) => p.name === 'Text')?.sourceExplicit;
          if (dirtyBold === true) throw new Error('net48 dirty-metadata: describe with an UNSAVED buffer (Text assignment removed) still reported source-explicit — the metadata pass read disk, not the buffer');
          console.log('e2e: net48 dirty-buffer metadata verified — describing fileMenu with an unsaved .Designer.cs (Text assignment removed, as a Reset commits) reports Text NOT source-explicit → item Reset/Events on net48 reflect the dirty edit, not the stale file');

          // ---- net48 NESTED submenu item describe parity (on-canvas flyout reachability) ----
          // A flyout-row click on a nested item posts selectItem → the net48 engine must describe a NESTED field-backed
          // ToolStripItem (undoItem, child of editMenu). The compiled fixture builds its FieldNames map from ALL
          // IComponent fields (nesting-blind), so the SAME reverse-scan that resolves a top-level item resolves a nested
          // one — assert it returns the same facts as net9 (else the net48 flyout would show only the placeholder).
          const nested48 = await describeCompiledComponent(n48, ctxForm, ctxFixtureDll, 'undoItem');
          const nestedNet9 = await describeComponent(engine, ctxForm, 'undoItem');
          if (!nested48) throw new Error('net48 nested describe: undoItem (a nested submenu item) returned null — the FieldNames reverse-scan did not resolve a nested field');
          if (!nested48.type.endsWith('ToolStripMenuItem')) throw new Error(`net48 nested describe: undoItem wrong type ${nested48.type}`);
          const nText48 = nested48.properties?.find((p) => p.name === 'Text')?.value;
          if (nText48 !== 'Undo') throw new Error(`net48 nested describe: undoItem.Text expected "Undo", got ${JSON.stringify(nText48)}`);
          if (nText48 !== nestedNet9?.properties?.find((p) => p.name === 'Text')?.value) throw new Error('net48 nested describe: undoItem.Text diverges from net9');
          if (nested48.parent != null) throw new Error(`net48 nested describe: a nested Component item must report no Parent (net9 parity), got ${JSON.stringify(nested48.parent)}`);
          console.log(`e2e: net48 NESTED submenu item describe parity verified — undoItem (child of editMenu) describes on the compiled engine (type ${nested48.type}, Text "${nText48}"), matching net9 → the on-canvas flyout resolves nested items on net48 too`);

          // ---- net48 item→Properties EDITING ----
          // Widening TryApply (the net48 live-edit primitive) to resolve a non-Control component — the same FieldNames
          // reverse-scan describe uses — makes a designer-originated item edit update the live COMPILED picture, not
          // just the source. Drive the live-edit RPC on the menu item: `applied` MUST be true (previously it came
          // back false — "no control 'fileMenu'"), and the re-rendered item geometry MUST carry the new caption (the
          // picture actually changed on the live instance, so the net48 canvas updates without a rebuild).
          const edit48 = await setCompiledPropertyLive(n48, ctxForm, ctxFixtureDll, 'fileMenu', 'Text', 'Fichier');
          if (!edit48.applied) throw new Error(`net48 item edit: fileMenu.Text was not applied live — TryApply did not resolve the item (diag: ${edit48.diagnostics || 'none'})`);
          const editedItem = edit48.toolStripItems.find((i) => i.itemId === 'fileMenu');
          if (!editedItem) throw new Error('net48 item edit: fileMenu absent from the re-rendered strip geometry');
          if (editedItem.text !== 'Fichier') throw new Error(`net48 item edit: fileMenu caption did not update live — expected "Fichier", got ${JSON.stringify(editedItem.text)}`);
          console.log(`e2e: net48 item→Properties EDITING verified — a live fileMenu.Text edit applied on the compiled instance (caption now "${editedItem.text}"), picture updated without a rebuild`);

          // ---- net48 item editing must NOT live-mutate a non-Control non-item component ----
          // The live-edit widening resolves a field-backed ToolStripItem for a live edit — but ONLY a ToolStripItem. A
          // Timer (a field-backed non-Control component, describable and reachable via the tray→control
          // edit path) must stay INERT: the preview is a real running instance, so live-setting timer1.Enabled=true
          // would Start() it and run the compiled Tick handler inside the design surface. Assert the live edit is
          // refused (applied===false) AND the live instance's Enabled is untouched — proving the timer never started.
          const timerEdit = await setCompiledPropertyLive(n48, ctxForm, ctxFixtureDll, 'timer1', 'Enabled', 'true');
          if (timerEdit.applied) throw new Error('net48 item edit: setting timer1.Enabled live was APPLIED — a non-Control non-item component must not be live-mutated (a design surface must never Start() a timer)');
          const timerDesc = await describeCompiledComponent(n48, ctxForm, ctxFixtureDll, 'timer1');
          const enabledVal = timerDesc?.properties?.find((p) => p.name === 'Enabled')?.value;
          if (enabledVal !== 'False') throw new Error(`net48 item edit: timer1.Enabled changed to ${JSON.stringify(enabledVal)} on the live instance — the refused edit still mutated the timer`);
          console.log('e2e: net48 item-editing safety verified — a Timer (non-Control non-item component) is NOT live-mutable (timer1.Enabled=true refused, live instance still disabled); only ToolStripItems are newly editable');

          // ---- OVERFLOW items (net48 parity) ----
          // The compiled engine's Show pump lays out the same narrow ToolStrip → the excess buttons go to overflow. Assert
          // the SAME robust invariants as the net9 leg (a chevron with >=1 child, union of main+overflow == all six, no
          // Type-Here) and cross-runtime agreement on the OVERFLOW SET (both engines must move the same buttons off-strip,
          // else the on-canvas flyout would differ from what the net9 canvas shows). The fixture form is compiled into the
          // shared Net48CtxFixture assembly (SampleApp.ToolStripOverflowForm).
          if (fs.existsSync(overflowForm)) {
            const r48o = await renderCompiledWithLayout(n48, overflowForm, ctxFixtureDll);
            const items48 = r48o.toolStripItems.filter((it) => it.ownerId === 'toolStrip1');
            const chev48 = items48.find((it) => (it as { overflow?: boolean }).overflow === true);
            if (!chev48) throw new Error(`overflow (net48): no overflow chevron emitted — items [${items48.map((i) => i.itemId || (i.isTypeHere ? '<slot>' : '<chevron?>')).join(', ')}]`);
            const ov48 = (chev48.children ?? []).map((c) => c.itemId).filter((id) => id).sort();
            if (ov48.length === 0) throw new Error('overflow (net48): the chevron carries no overflow items');
            const main48 = items48.filter((it) => !it.isTypeHere && !(it as { overflow?: boolean }).overflow).map((it) => it.itemId).filter((id) => id);
            const allButtons = ['btnOne', 'btnTwo', 'btnThree', 'btnFour', 'btnFive', 'btnSix'];
            const union48 = [...main48, ...ov48].sort();
            if (union48.join(',') !== allButtons.slice().sort().join(',')) throw new Error(`overflow (net48): main+overflow ids [${union48.join(', ')}] != all six buttons — an item was dropped or duplicated`);
            if (items48.some((it) => it.isTypeHere)) throw new Error('overflow (net48): a full strip must emit no Type-Here slot');
            // cross-runtime: both engines must move the SAME buttons off-strip (same overflow set) so the canvas flyout matches.
            const ov9 = ((await describeLayout(engine, overflowForm)).toolStripItems.find((it) => it.ownerId === 'toolStrip1' && (it as { overflow?: boolean }).overflow === true)?.children ?? []).map((c) => c.itemId).filter((id) => id).sort();
            if (ov9.join(',') !== ov48.join(',')) throw new Error(`overflow: the overflow SET diverges across runtimes — net9 [${ov9.join(', ')}] vs net48 [${ov48.join(', ')}] (the on-canvas flyout would differ)`);
            console.log(`e2e: OVERFLOW items (net48 parity) verified — chevron carries [${ov48.join(', ')}]; main+overflow == all six; no Type-Here; overflow set matches net9`);
          }

          // ---- ImageIndex / ImageKey dropdown (net48 — the real feature) ----
          // The compiled ImageListForm's ImageList actually holds its keyed images (Images.Add runs), so describe's
          // context-aware ImageKeyConverter/ImageIndexConverter enumerate the REAL keys/indices → the grid shows a
          // dropdown of them (VS parity). This is the primary target here (net9 can't populate the ImageList).
          if (fs.existsSync(imageListForm)) {
            const il48 = await describeCompiledComponent(n48, imageListForm, ctxFixtureDll, 'button1');
            if (!il48) throw new Error('ImageList (net48): button1 failed to describe on the compiled instance');
            const key48 = il48.properties?.find((p) => p.name === 'ImageKey')?.standardValues ?? [];
            const idx48 = il48.properties?.find((p) => p.name === 'ImageIndex')?.standardValues ?? [];
            if (!(key48.includes('first') && key48.includes('second'))) throw new Error(`ImageList (net48): ImageKey dropdown must list the real ImageList keys [first, second] — got [${key48.join(', ')}]`);
            if (!(idx48.includes('0') && idx48.includes('1'))) throw new Error(`ImageList (net48): ImageIndex dropdown must list the real indices [0, 1] — got [${idx48.join(', ')}]`);
            // The "(none)"/-1 SENTINEL must be filtered out — it doesn't round-trip through the primitive write path
            // (would splice a stale key literally "(none)" / reject the non-numeric int).
            if (key48.includes('(none)')) throw new Error(`ImageList (net48): the ImageKey dropdown must NOT offer the "(none)" sentinel (it doesn't round-trip) — got [${key48.join(', ')}]`);
            if (idx48.includes('(none)') || idx48.includes('-1')) throw new Error(`ImageList (net48): the ImageIndex dropdown must NOT offer the "(none)"/-1 sentinel — got [${idx48.join(', ')}]`);
            // A control whose ImageIndex uses the internal NoneExcludedImageIndexConverter (no sentinel) must still get its
            // dropdown — the old "<2" gate wrongly hid a 1-image list; here the 2-image TreeView must show [0, 1].
            const tv48 = await describeCompiledComponent(n48, imageListForm, ctxFixtureDll, 'treeView1');
            const tvIdx = tv48?.properties?.find((p) => p.name === 'ImageIndex')?.standardValues ?? [];
            if (!(tvIdx.includes('0') && tvIdx.includes('1')) || tvIdx.includes('(none)')) throw new Error(`ImageList (net48): treeView1.ImageIndex (NoneExcludedImageIndexConverter, no sentinel) must show [0, 1] with no "(none)" — got [${tvIdx.join(', ')}]`);
            console.log(`e2e: ImageIndex/ImageKey dropdown (net48) verified — button1 ImageKey [${key48.join(', ')}] / ImageIndex [${idx48.join(', ')}] (sentinel filtered), treeView1.ImageIndex [${tvIdx.join(', ')}] via NoneExcludedImageIndexConverter — real keyed images, VS-style dropdown`);
          }

          // ---- component-reference dropdown, CONTROL ref (net48 — the compiled instance is NOT sited) ----
          // AcceptButton/CancelButton point at Button controls. The un-sited converter can neither list the siblings
          // nor stringify the current value to a field name, so CompiledDescriber self-enumerates the FieldNames map
          // and OVERRIDES value with the referenced field name — verified by the pre-selected value. Live-set resolves
          // a picked name back to the control via ByField; "(none)" clears; a bogus name is rejected (applied=false).
          // (The component (non-Control) reference path — resolved via the FieldNames reverse-scan — is covered by the
          // ContextMenuForm panel1.ContextMenuStrip leg above.)
          if (fs.existsSync(compRefForm48)) {
            const crType = 'WinFormsDesigner.Samples.ComponentRefForm';
            const cr48 = await describeCompiledComponent(n48, compRefForm48, ctxFixtureDll, 'this', crType);
            if (!cr48) throw new Error('component-ref (net48): the form failed to describe on the compiled instance');
            const accept48 = cr48.properties?.find((p) => p.name === 'AcceptButton');
            if (!accept48) throw new Error('component-ref (net48): AcceptButton missing from the describe');
            const acceptVals = accept48.standardValues ?? [];
            if (!(acceptVals.includes('(none)') && acceptVals.includes('okButton') && acceptVals.includes('cancelButton')))
              throw new Error(`component-ref (net48): AcceptButton dropdown must be [(none), cancelButton, okButton] — got [${acceptVals.join(', ')}]`);
            if (accept48.referenceValues !== true) throw new Error('component-ref (net48): AcceptButton must carry referenceValues=true so the host writes this.<name>/null');
            if (accept48.standardValuesExclusive !== true) throw new Error('component-ref (net48): a reference dropdown must be exclusive');
            if (accept48.value !== 'okButton') throw new Error(`component-ref (net48): AcceptButton value must pre-select the referenced FIELD NAME "okButton" (the un-sited converter can't) — got ${JSON.stringify(accept48.value)}`);
            // live-set: control ref (ByField), clear, and a rejected bogus name
            const setCtrl = await setCompiledPropertyLive(n48, compRefForm48, ctxFixtureDll, 'this', 'AcceptButton', 'cancelButton', crType);
            if (!setCtrl.applied) throw new Error(`component-ref (net48): AcceptButton=cancelButton (control ByField) must apply live (diag: ${setCtrl.diagnostics || 'none'})`);
            const setNone = await setCompiledPropertyLive(n48, compRefForm48, ctxFixtureDll, 'this', 'AcceptButton', '(none)', crType);
            if (!setNone.applied) throw new Error(`component-ref (net48): AcceptButton=(none) (clear) must apply live (diag: ${setNone.diagnostics || 'none'})`);
            const setBogus = await setCompiledPropertyLive(n48, compRefForm48, ctxFixtureDll, 'this', 'AcceptButton', 'noSuchField', crType);
            if (setBogus.applied) throw new Error('component-ref (net48): AcceptButton=noSuchField must NOT apply (the name resolves to nothing) — a bogus reference was accepted');
            console.log(`e2e: component-ref dropdown CONTROL ref (net48) verified — AcceptButton/CancelButton [(none), cancelButton, okButton] pre-selecting field name "okButton"; live-set (ByField) applies, "(none)" clears, a bogus name is rejected`);
          }

          // ---- component-reference dropdown on a TRAY-COMPONENT owner (net48 — the compiled instance is NOT sited) ----
          // notifyIcon1.ContextMenuStrip = contextMenuStrip1: a reference whose OWNER is a non-Control tray Component.
          // Describe must self-enumerate the ContextMenuStrip field names (parity with net9), and TryApply's reference
          // branch must resolve a picked name to the live component even though the OWNER is not a Control — the widening
          // that scopes the edit-target relaxation to the assign-only reference branch (a Timer stays inert). The SAFETY
          // leg proves that scoping: a NON-reference edit on the tray component (Text) must remain an inert no-op.
          const notifyIconForm48 = path.join(repo, 'engine', 'samples', 'NotifyIconForm.Designer.cs');
          if (fs.existsSync(notifyIconForm48)) {
            const niType = 'WinFormsDesigner.Samples.NotifyIconForm';
            const ni48 = await describeCompiledComponent(n48, notifyIconForm48, ctxFixtureDll, 'notifyIcon1', niType);
            if (!ni48) throw new Error('tray-ref (net48): notifyIcon1 failed to describe on the compiled instance');
            const cms48 = ni48.properties?.find((p) => p.name === 'ContextMenuStrip');
            const cmsVals48 = cms48?.standardValues ?? [];
            if (!(cmsVals48.includes('(none)') && cmsVals48.includes('contextMenuStrip1')))
              throw new Error(`tray-ref (net48): notifyIcon1.ContextMenuStrip dropdown must be [(none), contextMenuStrip1] — got [${cmsVals48.join(', ')}]`);
            if (cms48?.referenceValues !== true || cms48?.standardValuesExclusive !== true) throw new Error('tray-ref (net48): notifyIcon1.ContextMenuStrip must be an exclusive referenceValues dropdown on a tray owner');
            if (cms48?.value !== 'contextMenuStrip1') throw new Error(`tray-ref (net48): notifyIcon1.ContextMenuStrip must pre-select "contextMenuStrip1" — got ${JSON.stringify(cms48?.value)}`);
            // live-set: the tray-owner reference resolves the picked component (reverse-scan), clears, rejects a bogus name
            const niSet = await setCompiledPropertyLive(n48, notifyIconForm48, ctxFixtureDll, 'notifyIcon1', 'ContextMenuStrip', 'contextMenuStrip1', niType);
            if (!niSet.applied) throw new Error(`tray-ref (net48): notifyIcon1.ContextMenuStrip=contextMenuStrip1 must apply live on a tray owner (diag: ${niSet.diagnostics || 'none'})`);
            const niSetNone = await setCompiledPropertyLive(n48, notifyIconForm48, ctxFixtureDll, 'notifyIcon1', 'ContextMenuStrip', '(none)', niType);
            if (!niSetNone.applied) throw new Error(`tray-ref (net48): notifyIcon1.ContextMenuStrip=(none) (clear) must apply live (diag: ${niSetNone.diagnostics || 'none'})`);
            const niSetBogus = await setCompiledPropertyLive(n48, notifyIconForm48, ctxFixtureDll, 'notifyIcon1', 'ContextMenuStrip', 'noSuchField', niType);
            if (niSetBogus.applied) throw new Error('tray-ref (net48): notifyIcon1.ContextMenuStrip=noSuchField must NOT apply (resolves to nothing)');
            // a RESOLVABLE but WRONG-TYPE reference (button1 is a Button, not a ContextMenuStrip) must be rejected by the assignability contract
            const niSetBadType = await setCompiledPropertyLive(n48, notifyIconForm48, ctxFixtureDll, 'notifyIcon1', 'ContextMenuStrip', 'button1', niType);
            if (niSetBadType.applied) throw new Error('tray-ref (net48): notifyIcon1.ContextMenuStrip=button1 (a Button, not assignable) must be rejected by the assignability check');
            // SAFETY: the tray-owner edit-target relaxation is REFERENCE-SCOPED. A non-reference edit on the tray
            // component (notifyIcon1.Text) must remain an inert no-op (applied=false) AND leave the live value
            // untouched — the same invariant that keeps a Timer from being Start()ed by a live edit.
            const niTextEdit = await setCompiledPropertyLive(n48, notifyIconForm48, ctxFixtureDll, 'notifyIcon1', 'Text', 'Changed', niType);
            if (niTextEdit.applied) throw new Error('tray-ref (net48 SAFETY): notifyIcon1.Text (a NON-reference edit on a tray component) was APPLIED — the widening must be reference-scoped, a plain tray-component edit must stay inert');
            const niAfter = await describeCompiledComponent(n48, notifyIconForm48, ctxFixtureDll, 'notifyIcon1', niType);
            const textAfter = niAfter?.properties?.find((p) => p.name === 'Text')?.value;
            if (textAfter !== 'Tray') throw new Error(`tray-ref (net48 SAFETY): notifyIcon1.Text changed to ${JSON.stringify(textAfter)} on the live instance — the refused non-reference edit still mutated the tray component`);
            // ROOT reference (errorProvider1.ContainerControl = this): the compiled instance holds the root form, which
            // is assignable to ContainerControl, so describe offers the synthetic "(this)" token — parity with net9's
            // [(none), (this)] exclusive dropdown pre-selecting "(this)".
            const ep48 = await describeCompiledComponent(n48, notifyIconForm48, ctxFixtureDll, 'errorProvider1', niType);
            const cc48 = ep48?.properties?.find((p) => p.name === 'ContainerControl');
            const cc48Vals = cc48?.standardValues ?? [];
            if (cc48?.referenceValues !== true || cc48?.standardValuesExclusive !== true) throw new Error('tray-ref (net48): errorProvider1.ContainerControl (a ROOT reference to an assignable form) must be an exclusive referenceValues dropdown, parity with net9');
            if (!(cc48Vals.length === 2 && cc48Vals.includes('(none)') && cc48Vals.includes('(this)'))) throw new Error(`tray-ref (net48): errorProvider1.ContainerControl dropdown must be [(none), (this)] — got [${cc48Vals.join(', ')}]`);
            if (cc48?.value !== '(this)') throw new Error(`tray-ref (net48): errorProvider1.ContainerControl must pre-select "(this)" — got ${JSON.stringify(cc48?.value)}`);
            // ROOT-ACCEPT: the net48 live-write now RESOLVES the "(this)" token to the live root form (it is an offered
            // candidate — the write's assignability gate mirrors the describe offer). "(none)" clears. The root-reject
            // guard was lifted in lockstep; only a SELF reference / non-assignable sibling stays refused (see wrong-type
            // leg above). A bare "this" string resolves to root too (the shared resolver), so both forms apply.
            const rootTok = await setCompiledPropertyLive(n48, notifyIconForm48, ctxFixtureDll, 'errorProvider1', 'ContainerControl', '(this)', niType);
            if (!rootTok.applied) throw new Error(`tray-ref (net48 ROOT-ACCEPT): errorProvider1.ContainerControl=(this) must resolve to the live root and apply (diag: ${rootTok.diagnostics || 'none'})`);
            const rootClr = await setCompiledPropertyLive(n48, notifyIconForm48, ctxFixtureDll, 'errorProvider1', 'ContainerControl', '(none)', niType);
            if (!rootClr.applied) throw new Error(`tray-ref (net48 ROOT-ACCEPT): errorProvider1.ContainerControl=(none) (clear) must apply (diag: ${rootClr.diagnostics || 'none'})`);
            const rootWrong = await setCompiledPropertyLive(n48, notifyIconForm48, ctxFixtureDll, 'errorProvider1', 'ContainerControl', 'contextMenuStrip1', niType);
            if (rootWrong.applied) throw new Error('tray-ref (net48): errorProvider1.ContainerControl=contextMenuStrip1 (a ContextMenuStrip, not assignable to ContainerControl) must be rejected by the assignability check');
            console.log(`e2e: tray-component reference dropdown (net48) verified — notifyIcon1.ContextMenuStrip [(none), contextMenuStrip1] pre-selecting "contextMenuStrip1"; live-set resolves the tray-owner reference, "(none)" clears, bogus/wrong-type rejected; a non-reference tray edit (Text) stays inert (Timer invariant); errorProvider1.ContainerControl (ROOT ref) is a [(none), (this)] dropdown pre-selecting "(this)", "(this)" resolves live to the root and applies, "(none)" clears, a wrong-type sibling is refused`);
          }
        } finally {
          n48.dispose();
        }
      }

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
      // ColumnStyles/RowStyles applied: col0 = ColumnStyle(Percent, 25) and row0 = RowStyle(Absolute, 40),
      // so the col0/col1 boundary (cellButton.x) sits well left of center and the row0/row1 boundary (cellText.y)
      // well above the middle — both ≈25-27%, not the ≈50% they'd be if the styles were dropped (equal-sized cells).
      const tlp = tl.controls.find((c) => c.id === 'tableLayoutPanel1');
      if (!tlp) throw new Error('TLP: tableLayoutPanel1 missing from layout');
      const colFrac = (btn.x - tlp.x) / tlp.width;
      const rowFrac = (txt.y - tlp.y) / tlp.height;
      if (!(colFrac < 0.4)) throw new Error(`TLP: ColumnStyle(Percent,25) not applied — col0/col1 boundary at ${(colFrac * 100).toFixed(0)}% (equal cells = 50%)`);
      if (!(rowFrac < 0.4)) throw new Error(`TLP: RowStyle(Absolute,40) not applied — row0/row1 boundary at ${(rowFrac * 100).toFixed(0)}% (equal cells = 50%)`);
      console.log(`e2e: TableLayoutPanel cells verified — 3-arg Controls.Add honored (btn right of lbl x ${btn.x}>${lbl.x}, txt below lbl y ${txt.y}>${lbl.y}); ColumnStyle/RowStyle applied (col0 ${(colFrac * 100).toFixed(0)}%, row0 ${(rowFrac * 100).toFixed(0)}% — not equal 50%)`);

      // grid-cell edit: the Column/Row extenders surface for a TLP child, and SetTableCell relocates it.
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
      // safe-save gate: reject a negative cell, and reject an unknown child (no matching 3-arg Add)
      if ((await setTableCell(engine, tlpForm, 'cellLabel', -1, null, diskTlp)).safe) throw new Error('SetTableCell must reject a negative column');
      if ((await setTableCell(engine, tlpForm, 'noSuchChild', 1, null, diskTlp)).safe) throw new Error('SetTableCell must reject an unknown child');
      console.log(`e2e: TableLayoutPanel grid-cell edit verified — Column/Row surfaced (tableCell); SetTableCell moved cellLabel (0,0)→(1,1) [(${lbl.x},${lbl.y})→(${lbl2.x},${lbl2.y})], partial col-only keeps row, negative & unknown rejected`);

      // column/row SIZE-STYLE edit: read the 2 col + 2 row styles, then rewrite one style's args.
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
      // safe-save gate: out-of-range index, bogus size type, negative value — all rejected.
      if ((await setTableStyle(engine, tlpForm, 'tableLayoutPanel1', 'Column', 9, null, 10, diskTlp2)).safe) throw new Error('SetTableStyle must reject an out-of-range index');
      if ((await setTableStyle(engine, tlpForm, 'tableLayoutPanel1', 'Column', 0, 'Bogus', 10, diskTlp2)).safe) throw new Error('SetTableStyle must reject an invalid size type');
      if ((await setTableStyle(engine, tlpForm, 'tableLayoutPanel1', 'Column', 0, null, -5, diskTlp2)).safe) throw new Error('SetTableStyle must reject a negative value');
      console.log('e2e: TableLayoutPanel style edit verified — 4 styles read (col0 Percent/25, row0 Absolute/40); col0→60% rewrites only that ctor (sibling 75F intact) and re-flows the boundary right; row1→AutoSize drops the value arg; out-of-range/bad-type/negative rejected');
    } else {
      console.log('e2e: TableLayoutPanel cells SKIPPED — engine/samples/TableLayoutForm.Designer.cs missing');
    }

    // ---- String Collection editor (ComboBox/ListBox/CheckedListBox.Items) ----
    // ListForm has comboBox1.Items = [Alpha,Beta,Gamma] and listBox1.Items = [One,Two] via AddRange. Assert:
    // describe flags Items as a string collection; the interpreter now honors string elements (the AddRange is
    // representable, not dropped to read-only); ListCollectionItems reads them; SetCollectionItems rewrites /
    // clears / re-inserts them and round-trips escaped values; a non-literal collection reads ok:false.
    const listForm = path.join(repo, 'engine', 'samples', 'ListForm.Designer.cs');
    if (fs.existsSync(listForm)) {
      // describe flags Items as an editable string collection
      const cbc = await describeComponent(engine, listForm, 'comboBox1');
      const itemsProp = cbc?.properties.find((p) => p.name === 'Items');
      if (!itemsProp) throw new Error('collection: comboBox1.Items not surfaced in describe');
      if (!itemsProp.isCollection || itemsProp.collectionItemType !== 'System.String') throw new Error('collection: Items must be flagged isCollection/System.String');

      // interpreter fix: the string-literal AddRange is now representable (was previously dropped to read-only)
      const listDesc = await describeDesigner(engine, listForm);
      if (listDesc.unrepresentable.some((u) => /Items\.AddRange/.test(u))) throw new Error('collection: Items.AddRange should be representable (interpreter must honor string elements)');

      // list current items
      const disk = fs.readFileSync(listForm, 'utf8');
      const l0 = await listCollectionItems(engine, listForm, 'comboBox1', 'Items', disk);
      if (!l0.ok || l0.items.join(',') !== 'Alpha,Beta,Gamma') throw new Error('collection: list did not read [Alpha,Beta,Gamma], got ' + JSON.stringify(l0));

      // set: rewrite to a new list, incl. a value with a quote (must round-trip via an escaped literal)
      const s1 = await setCollectionItems(engine, listForm, 'comboBox1', 'Items', ['First', 'Se"cond', 'Third'], disk);
      if (!s1.safe || s1.text === null) throw new Error('collection: set rejected: ' + s1.reason);
      const l1 = await listCollectionItems(engine, listForm, 'comboBox1', 'Items', s1.text);
      if (!l1.ok || l1.items.join('|') !== 'First|Se"cond|Third') throw new Error('collection: re-read after set wrong, got ' + JSON.stringify(l1.items));
      if (!/this\.listBox1\.Items\.AddRange/.test(s1.text)) throw new Error('collection: set over-touched — listBox1.Items must be untouched');

      // clear: empty list removes the AddRange
      const s2 = await setCollectionItems(engine, listForm, 'listBox1', 'Items', [], disk);
      if (!s2.safe || s2.text === null) throw new Error('collection: clear rejected: ' + s2.reason);
      if (/this\.listBox1\.Items\.Add/.test(s2.text)) throw new Error('collection: clear must remove all listBox1.Items.Add(Range) calls');
      const l2 = await listCollectionItems(engine, listForm, 'listBox1', 'Items', s2.text);
      if (!l2.ok || l2.items.length !== 0) throw new Error('collection: listBox1 should be empty after clear');

      // insert-when-none: after clearing, setting items again inserts a fresh AddRange (anchored in the owner block)
      const s3 = await setCollectionItems(engine, listForm, 'listBox1', 'Items', ['X', 'Y'], s2.text);
      if (!s3.safe || s3.text === null) throw new Error('collection: re-insert rejected: ' + s3.reason);
      const l3 = await listCollectionItems(engine, listForm, 'listBox1', 'Items', s3.text);
      if (!l3.ok || l3.items.join(',') !== 'X,Y') throw new Error('collection: re-insert did not restore [X,Y], got ' + JSON.stringify(l3.items));

      // a non-literal (bound/complex) collection reads ok:false → the webview keeps it read-only (no data loss)
      const bound = disk.replace('"Gamma"});', '"Gamma", someVar});');
      const lb = await listCollectionItems(engine, listForm, 'comboBox1', 'Items', bound);
      if (lb.ok) throw new Error('collection: a non-literal element must make the collection read-only (ok:false)');

      // adversarial guard: a comment attached to a dropped collection statement must NOT be silently
      // lost — consolidating two Add calls would drop the comment, so the safe-save gate must REFUSE (safe:false).
      const commented = 'namespace S{partial class F{private System.Windows.Forms.ComboBox comboBox1;' +
        'private void InitializeComponent(){this.comboBox1=new System.Windows.Forms.ComboBox();\n' +
        'this.comboBox1.Items.Add("A");\n// KEEP-THIS-NOTE-do-not-drop\nthis.comboBox1.Items.Add("B");\n' +
        'this.comboBox1.Name="comboBox1";}}}';
      const cmt = await setCollectionItems(engine, listForm, 'comboBox1', 'Items', ['A', 'B'], commented);
      if (cmt.safe) throw new Error('collection: editing a collection with a comment between Add calls must be refused (comment-loss guard)');
      console.log('e2e: string collection editor verified — Items flagged isCollection; AddRange representable; list [Alpha,Beta,Gamma]; set (quote round-trips) leaves listBox1 intact; clear empties; re-insert restores [X,Y]; non-literal → ok:false; comment-between-Adds refused');
    } else {
      console.log('e2e: string collection editor SKIPPED — engine/samples/ListForm.Designer.cs missing');
    }

    // ---- Generic string[] editor (TextBox/RichTextBox.Lines) + Cursor picker ----
    // LinesForm has notesBox.Cursor = Cursors.Hand and its multi-line content serialized as Text (the VS-canonical
    // form — Lines is DesignerSerializationVisibility.Hidden, so VS never emits `Lines =`). Assert: describe flags
    // Lines with the distinct "System.String[]" sentinel and surfaces Cursor's dropdown; the interpreter honors the
    // Cursors.Hand static read; the "…" editor reads the multi-line content FROM Text and WRITES it back to Text
    // (never a competing Lines= assignment — the review's HIGH data-loss guard); a hand-written Lines= array still
    // round-trips; a resx/Rtf-backed value reads ok:false; Cursor converts to the idiomatic Cursors.<name>.
    const linesForm = path.join(repo, 'engine', 'samples', 'LinesForm.Designer.cs');
    if (fs.existsSync(linesForm)) {
      const disk = fs.readFileSync(linesForm, 'utf8');

      // describe: Lines flagged as a string[] collection (distinct sentinel); Cursor editable with standard values
      const nb = await describeComponent(engine, linesForm, 'notesBox');
      const linesProp = nb?.properties.find((p) => p.name === 'Lines');
      if (!linesProp) throw new Error('stringArray: notesBox.Lines not surfaced in describe');
      if (!linesProp.isCollection || linesProp.collectionItemType !== 'System.String[]') throw new Error('stringArray: Lines must be flagged isCollection/System.String[] (distinct sentinel), got ' + JSON.stringify({ c: linesProp.isCollection, t: linesProp.collectionItemType }));
      const cursorProp = nb?.properties.find((p) => p.name === 'Cursor');
      if (!cursorProp || !cursorProp.standardValues || !cursorProp.standardValues.length) throw new Error('cursor: notesBox.Cursor must surface CursorConverter standard values');
      if (cursorProp.readOnly) throw new Error('cursor: a STANDARD cursor (Hand) must stay editable, not read-only');

      // interpreter: the Cursors.Hand static read is not dropped to unrepresentable (array-creation is exercised by the array-form case below)
      const linesDesc = await describeDesigner(engine, linesForm);
      if (linesDesc.unrepresentable.some((u) => /Cursor/.test(u))) throw new Error('cursor: Cursors.Hand static read must be representable, got ' + JSON.stringify(linesDesc.unrepresentable));

      // read: the multi-line content is stored in Text — the editor reads it FROM Text (the review's empty-read bug)
      const l0 = await listStringArray(engine, linesForm, 'notesBox', 'Lines', disk);
      if (!l0.ok || l0.items.join('|') !== 'First line|Second line|Third line') throw new Error('stringArray: list did not read the 3 lines from Text, got ' + JSON.stringify(l0));

      // set: writes the joined value back to TEXT (never a competing Lines= that would overwrite it), quote escaped
      const s1 = await setStringArray(engine, linesForm, 'notesBox', 'Lines', ['Alpha', 'Be"ta', 'Gamma'], disk);
      if (!s1.safe || s1.text === null) throw new Error('stringArray: set rejected: ' + s1.reason);
      if (!/this\.notesBox\.Text = "Alpha\\r\\nBe\\"ta\\r\\nGamma";/.test(s1.text)) throw new Error('stringArray: set must rewrite the Text assignment (join, escaped), not introduce a Lines= array');
      if (/notesBox\.Lines =/.test(s1.text)) throw new Error('stringArray: set must NOT introduce a competing Lines= assignment (data-loss guard)');
      const l1 = await listStringArray(engine, linesForm, 'notesBox', 'Lines', s1.text);
      if (!l1.ok || l1.items.join('|') !== 'Alpha|Be"ta|Gamma') throw new Error('stringArray: re-read after set wrong, got ' + JSON.stringify(l1.items));

      // clear: empty list writes Text = "" and reads back ok:true / empty
      const s2 = await setStringArray(engine, linesForm, 'notesBox', 'Lines', [], disk);
      if (!s2.safe || s2.text === null) throw new Error('stringArray: clear rejected: ' + s2.reason);
      if (!/this\.notesBox\.Text = "";/.test(s2.text)) throw new Error('stringArray: clear must set Text = ""');
      const l2 = await listStringArray(engine, linesForm, 'notesBox', 'Lines', s2.text);
      if (!l2.ok || l2.items.length !== 0) throw new Error('stringArray: cleared Lines should read ok:true empty, got ' + JSON.stringify(l2));

      // a resx-backed Text value reads ok:false → the field stays read-only (no silent overwrite)
      const resx = disk.replace(/this\.notesBox\.Text = "[^"]*";/, 'this.notesBox.Text = resources.GetString("notesBox.Text");');
      const lr = await listStringArray(engine, linesForm, 'notesBox', 'Lines', resx);
      if (lr.ok) throw new Error('stringArray: a non-literal (resx) Text must make Lines read-only (ok:false)');

      // a RichTextBox whose content is Rtf reads ok:false → plain-text editing can't discard the formatting
      const rtf = 'namespace S{partial class F{private System.Windows.Forms.RichTextBox rtb;private void InitializeComponent(){this.rtb=new System.Windows.Forms.RichTextBox();this.rtb.Name="rtb";this.rtb.Rtf="{\\\\rtf1 hi}";}}}';
      const lrtf = await listStringArray(engine, linesForm, 'rtb', 'Lines', rtf);
      if (lrtf.ok) throw new Error('stringArray: a Rtf-backed RichTextBox must make Lines read-only (ok:false)');

      // a hand-written Lines= array still round-trips (it is the effective assignment) and edits stay in array form
      const arrSrc = 'namespace S{partial class F{private System.Windows.Forms.TextBox tb;private void InitializeComponent(){this.tb=new System.Windows.Forms.TextBox();this.tb.Location=new System.Drawing.Point(1,1);this.tb.Name="tb";this.tb.Lines = new string[] { "aa", "bb" };}}}';
      const la = await listStringArray(engine, linesForm, 'tb', 'Lines', arrSrc);
      if (!la.ok || la.items.join('|') !== 'aa|bb') throw new Error('stringArray: hand-written Lines= array must read back, got ' + JSON.stringify(la));
      const sa = await setStringArray(engine, linesForm, 'tb', 'Lines', ['cc'], arrSrc);
      if (!sa.safe || sa.text === null || !/tb\.Lines = new string\[\] \{ "cc" \};/.test(sa.text) || /tb\.Text =/.test(sa.text)) throw new Error('stringArray: editing an existing Lines= array must stay in array form (not switch to Text=), got ' + (sa.text || sa.reason));

      // Cursor converts to the idiomatic static-property expression (identical shape to a named Color/SystemColors)
      const cur = await convertValue(engine, 'System.Windows.Forms.Cursor', 'Hand');
      if (cur !== 'System.Windows.Forms.Cursors.Hand') throw new Error('cursor: convert should yield System.Windows.Forms.Cursors.Hand, got ' + cur);
      // a custom/non-standard cursor has no Cursors.* member → not convertible → stays read-only (no data loss)
      if (await convertValue(engine, 'System.Windows.Forms.Cursor', 'NoSuchCursorXYZ') !== null) throw new Error('cursor: an unknown cursor name must be rejected (null)');
      console.log('e2e: string[] editor + Cursor verified — Lines flagged System.String[] sentinel; content read/written via the effective Text assignment (no competing Lines=, data-loss guard); clear → Text=""; resx/Rtf → ok:false; hand-written Lines= array round-trips in array form; Cursor editable→Cursors.Hand, custom cursor read-only, unknown→null');
    } else {
      console.log('e2e: string[] editor + Cursor SKIPPED — engine/samples/LinesForm.Designer.cs missing');
    }

    // ---- Typed collection editor (ListView.Columns) ----
    // ListViewForm has listView1 with colName ("Name"/220) + colSize ("Size"/120) as named ColumnHeader fields.
    // Assert: describe flags Columns as a typed collection (ColumnHeader item type); ListColumns reads the rows;
    // SetColumns edits / reorders / removes / adds / clears them, round-trips, and refuses unsafe collections.
    const lvForm = path.join(repo, 'engine', 'samples', 'ListViewForm.Designer.cs');
    if (fs.existsSync(lvForm)) {
      const disk = fs.readFileSync(lvForm, 'utf8');

      // describe flags Columns as a TYPED collection (not string) so the webview opens the grid editor
      const lvc = await describeComponent(engine, lvForm, 'listView1');
      const colProp = lvc?.properties.find((p) => p.name === 'Columns');
      if (!colProp) throw new Error('columns: listView1.Columns not surfaced in describe');
      if (!colProp.isCollection || colProp.collectionItemType !== 'System.Windows.Forms.ColumnHeader')
        throw new Error('columns: Columns must be flagged isCollection/ColumnHeader, got ' + JSON.stringify(colProp));

      // read the current columns
      const c0 = await listColumns(engine, lvForm, 'listView1', disk);
      if (!c0.ok || c0.columns.length !== 2) throw new Error('columns: list did not read 2 columns, got ' + JSON.stringify(c0));
      if (c0.columns[0].id !== 'colName' || c0.columns[0].text !== 'Name' || c0.columns[0].width !== 220 || c0.columns[0].textAlign !== 'Left')
        throw new Error('columns: colName row wrong: ' + JSON.stringify(c0.columns[0]));

      // EDIT: widen colName, right-align colSize — keep ids so nothing is added/removed
      const e1 = await setColumns(engine, lvForm, 'listView1', [
        { id: 'colName', text: 'Name', width: 260, textAlign: 'Left' },
        { id: 'colSize', text: 'Size', width: 120, textAlign: 'Right' },
      ], disk);
      if (!e1.safe || e1.text === null) throw new Error('columns: edit rejected: ' + e1.reason);
      const r1 = await listColumns(engine, lvForm, 'listView1', e1.text);
      if (r1.columns[0].width !== 260 || r1.columns[1].textAlign !== 'Right') throw new Error('columns: edit did not round-trip, got ' + JSON.stringify(r1.columns));
      if (!/HorizontalAlignment\.Right/.test(e1.text)) throw new Error('columns: Right align must emit a HorizontalAlignment.Right assignment');

      // REORDER: colSize first
      const e2 = await setColumns(engine, lvForm, 'listView1', [
        { id: 'colSize', text: 'Size', width: 120, textAlign: 'Left' },
        { id: 'colName', text: 'Name', width: 220, textAlign: 'Left' },
      ], disk);
      const r2 = await listColumns(engine, lvForm, 'listView1', e2.text!);
      if (r2.columns[0].id !== 'colSize' || r2.columns[1].id !== 'colName') throw new Error('columns: reorder failed, got ' + JSON.stringify(r2.columns.map((c) => c.id)));

      // REMOVE: drop colSize — its field declaration must go too (no dangling field)
      const e3 = await setColumns(engine, lvForm, 'listView1', [{ id: 'colName', text: 'Name', width: 220, textAlign: 'Left' }], disk);
      if (!e3.safe || e3.text === null) throw new Error('columns: remove rejected: ' + e3.reason);
      if (/\bcolSize\b/.test(e3.text)) throw new Error('columns: remove must delete every colSize reference (field + statements)');
      const r3 = await listColumns(engine, lvForm, 'listView1', e3.text);
      if (r3.columns.length !== 1 || r3.columns[0].id !== 'colName') throw new Error('columns: remove wrong result: ' + JSON.stringify(r3.columns));

      // ADD: a new column (empty id → engine names it) — must gain a field decl + construction + AddRange element
      const e4 = await setColumns(engine, lvForm, 'listView1', [
        { id: 'colName', text: 'Name', width: 220, textAlign: 'Left' },
        { id: 'colSize', text: 'Size', width: 120, textAlign: 'Left' },
        { id: '', text: 'Extra', width: 90, textAlign: 'Center' },
      ], disk);
      if (!e4.safe || e4.text === null) throw new Error('columns: add rejected: ' + e4.reason);
      const r4 = await listColumns(engine, lvForm, 'listView1', e4.text);
      if (r4.columns.length !== 3 || r4.columns[2].text !== 'Extra' || r4.columns[2].textAlign !== 'Center') throw new Error('columns: add wrong result: ' + JSON.stringify(r4.columns));
      if (!/private System\.Windows\.Forms\.ColumnHeader columnHeader1;/.test(e4.text)) throw new Error('columns: add must declare a new ColumnHeader field');

      // CLEAR: no columns removes every ColumnHeader field + the AddRange
      const e5 = await setColumns(engine, lvForm, 'listView1', [], disk);
      if (!e5.safe || e5.text === null) throw new Error('columns: clear rejected: ' + e5.reason);
      if (/Columns\.AddRange/.test(e5.text) || /new System\.Windows\.Forms\.ColumnHeader\(\)/.test(e5.text)) throw new Error('columns: clear must remove all columns');
      const r5 = await listColumns(engine, lvForm, 'listView1', e5.text);
      if (!r5.ok || r5.columns.length !== 0) throw new Error('columns: cleared list should be empty');

      // SAFETY — a column with an unmanaged property (ImageIndex) reads ok:false AND the edit is refused (no clobber)
      const unmanaged = disk.replace('this.colName.Width = 220;', 'this.colName.Width = 220;\n            this.colName.ImageIndex = 1;');
      const u0 = await listColumns(engine, lvForm, 'listView1', unmanaged);
      if (u0.ok) throw new Error('columns: an unmanaged column property must make the collection read-only (ok:false)');
      const u1 = await setColumns(engine, lvForm, 'listView1', [{ id: 'colName', text: 'Name', width: 220, textAlign: 'Left' }], unmanaged);
      if (u1.safe) throw new Error('columns: editing a collection with an unmanaged column property must be refused');

      // SAFETY — an unknown column id is refused (can't retarget an arbitrary field)
      const uk = await setColumns(engine, lvForm, 'listView1', [{ id: 'colBOGUS', text: 'X', width: 60, textAlign: 'Left' }], disk);
      if (uk.safe) throw new Error('columns: an unknown column id must be refused');

      // SAFETY (1.0) — the ListView editor carries the DataGridView editor's split-partial fault independently:
      // this edit rewrites only the InitializeComponent-bearing declaration, so a column whose field lives in the
      // form's OTHER partial can't be removed atomically (construction deleted, declaration stranded → a field that
      // compiles and is forever null, reported safe), and a cls-only reference scan can't see a helper using it.
      const splitList = `namespace WinFormsDesigner.Samples
{
    partial class ListViewForm
    {
        private void InitializeComponent()
        {
            this.listView1 = new System.Windows.Forms.ListView();
            this.colName = new System.Windows.Forms.ColumnHeader();
            this.listView1.Columns.AddRange(new System.Windows.Forms.ColumnHeader[] { this.colName });
            this.colName.Text = "Name";
            this.Controls.Add(this.listView1);
            this.ClientSize = new System.Drawing.Size(400, 300);
            this.Name = "ListViewForm";
        }
    }

    partial class ListViewForm
    {
        private System.Windows.Forms.ListView listView1;
        private System.Windows.Forms.ColumnHeader colName;
    }
}
`;
      if ((await setColumns(engine, lvForm, 'listView1', [], splitList)).safe)
        throw new Error('columns: removing a column whose field is declared in ANOTHER partial must refuse — the declaration would survive with its construction deleted');
      const splitListUsed = splitList.replace('        private System.Windows.Forms.ColumnHeader colName;',
        '        private System.Windows.Forms.ColumnHeader colName;\n\n        private void ApplyBusinessCaption() { this.colName.Text = "Customer"; }');
      if ((await setColumns(engine, lvForm, 'listView1', [], splitListUsed)).safe)
        throw new Error('columns: removing a column used by a helper in the form\'s OTHER partial must refuse — the reference scan must span every partial');

      // SAFETY — a comment attached to a column statement must not be silently dropped (comment-loss guard → refuse)
      const commented = disk.replace('this.colName.Text = "Name";', '// KEEP-THIS-COLUMN-NOTE\n this.colName.Text = "Name";');
      const cm = await setColumns(engine, lvForm, 'listView1', [
        { id: 'colName', text: 'Name', width: 300, textAlign: 'Left' },
        { id: 'colSize', text: 'Size', width: 120, textAlign: 'Left' },
      ], commented);
      if (cm.safe) throw new Error('columns: editing a collection with a comment in the column block must be refused (comment-loss guard)');

      // SAFETY — an object-initializer construction (new ColumnHeader { Tag = … }) carries unmodeled
      // state; it must read ok:false AND the edit must be refused, not silently drop the initializer.
      const initz = disk.replace('this.colName = new System.Windows.Forms.ColumnHeader();', 'this.colName = new System.Windows.Forms.ColumnHeader() { Tag = "keep-me" };');
      if ((await listColumns(engine, lvForm, 'listView1', initz)).ok) throw new Error('columns: an object-initializer construction must make the collection read-only');
      if ((await setColumns(engine, lvForm, 'listView1', [{ id: 'colName', text: 'Name', width: 60, textAlign: 'Left' }], initz)).safe)
        throw new Error('columns: editing a collection with an object-initializer construction must be refused (silent-clobber guard)');

      // SAFETY — a comment on a REMOVED column's FIELD DECLARATION (outside the IC body) must not be
      // silently dropped; removing that column must be refused (whole-class comment-loss guard).
      const declCmt = disk.replace('private System.Windows.Forms.ColumnHeader colSize;', '// colSize is the size column\n private System.Windows.Forms.ColumnHeader colSize;');
      if ((await setColumns(engine, lvForm, 'listView1', [{ id: 'colName', text: 'Name', width: 220, textAlign: 'Left' }], declCmt)).safe)
        throw new Error('columns: removing a column whose field declaration carries a comment must be refused (field-decl comment-loss guard)');

      console.log('e2e: typed collection editor (ListView.Columns) verified — Columns flagged ColumnHeader; list [colName/220,colSize/120]; edit (width+Right align round-trips); reorder; remove (field+refs gone); add (new field decl); clear (all removed); unmanaged prop → ok:false + refused; unknown id refused; comment-loss refused; initializer-construction refused; field-decl comment-loss refused');
    } else {
      console.log('e2e: typed collection editor SKIPPED — engine/samples/ListViewForm.Designer.cs missing');
    }

    // ---- Hierarchical collection editor (TreeView.Nodes) ----
    // TreeForm has treeView1 with Fruits[Apple,Banana] + Vegetables[Carrot] as TreeNode LOCAL variables (not fields).
    // Assert: the interpreter renders it; describe flags Nodes as a TreeNode collection; ListNodes reads the
    // recursive forest; SetNodes edits/reparents/removes/clears, round-trips, and refuses an unmanaged tree.
    const treeForm = path.join(repo, 'engine', 'samples', 'TreeForm.Designer.cs');
    if (fs.existsSync(treeForm)) {
      const disk = fs.readFileSync(treeForm, 'utf8');

      // A TreeView populated via TreeNode locals + Nodes.AddRange renders (previously the nodes dropped)
      const treePng = await renderDesigner(engine, treeForm);
      if (!isPng(treePng)) throw new Error('treenodes: TreeForm did not render');

      // describe flags Nodes as a TYPED (TreeNode) collection so the webview opens the tree editor
      const tvc = await describeComponent(engine, treeForm, 'treeView1');
      const nodesProp = tvc?.properties.find((p) => p.name === 'Nodes');
      if (!nodesProp) throw new Error('treenodes: treeView1.Nodes not surfaced in describe');
      if (!nodesProp.isCollection || nodesProp.collectionItemType !== 'System.Windows.Forms.TreeNode')
        throw new Error('treenodes: Nodes must be flagged isCollection/TreeNode, got ' + JSON.stringify(nodesProp));

      // read the recursive forest: 2 roots; Fruits has 2 children
      const n0 = await listTreeNodes(engine, treeForm, 'treeView1', disk);
      if (!n0.ok || n0.nodes.length !== 2) throw new Error('treenodes: list did not read 2 roots, got ' + JSON.stringify(n0));
      if (n0.nodes[0].text !== 'Fruits' || n0.nodes[0].name !== 'nodeFruits' || n0.nodes[0].children.length !== 2)
        throw new Error('treenodes: Fruits root wrong: ' + JSON.stringify(n0.nodes[0]));
      if (n0.nodes[0].children[0].text !== 'Apple' || n0.nodes[1].children[0].text !== 'Carrot')
        throw new Error('treenodes: nested children wrong: ' + JSON.stringify(n0.nodes));

      // EDIT: rename a node + add a child to Fruits (empty id → the engine names it treeNodeN), round-trip + renders
      const edited = JSON.parse(JSON.stringify(n0.nodes));
      edited[0].text = 'Produce';
      edited[0].children.push({ id: '', text: 'Cherry', name: '', children: [] });
      const e1 = await setTreeNodes(engine, treeForm, 'treeView1', edited, disk);
      if (!e1.safe || e1.text === null) throw new Error('treenodes: edit rejected: ' + e1.reason);
      const r1 = await listTreeNodes(engine, treeForm, 'treeView1', e1.text);
      if (r1.nodes[0].text !== 'Produce' || r1.nodes[0].children.length !== 3 || r1.nodes[0].children[2].text !== 'Cherry')
        throw new Error('treenodes: edit did not round-trip, got ' + JSON.stringify(r1.nodes[0]));

      // REPARENT: move Carrot (child of Vegetables) up to be a root; Vegetables becomes a leaf
      const flat = JSON.parse(JSON.stringify(n0.nodes));
      const carrot = flat[1].children.splice(0, 1)[0];
      flat.push(carrot);
      const e2 = await setTreeNodes(engine, treeForm, 'treeView1', flat, disk);
      if (!e2.safe || e2.text === null) throw new Error('treenodes: reparent rejected: ' + e2.reason);
      const r2 = await listTreeNodes(engine, treeForm, 'treeView1', e2.text);
      if (r2.nodes.length !== 3 || r2.nodes[2].text !== 'Carrot' || r2.nodes[1].children.length !== 0)
        throw new Error('treenodes: reparent wrong: ' + JSON.stringify(r2.nodes.map((n) => n.text + '/' + n.children.length)));

      // CLEAR: no nodes removes every TreeNode declaration + the AddRange
      const e3 = await setTreeNodes(engine, treeForm, 'treeView1', [], disk);
      if (!e3.safe || e3.text === null) throw new Error('treenodes: clear rejected: ' + e3.reason);
      if (/new System\.Windows\.Forms\.TreeNode\(/.test(e3.text) || /Nodes\.AddRange/.test(e3.text))
        throw new Error('treenodes: clear must remove every TreeNode + the AddRange');

      // SAFETY — a node with a STILL-unmanaged property (StateImageKey; Name/images/ToolTipText/Checked are modelled)
      // reads ok:false AND the edit is refused (no clobber)
      const unmanaged = disk.replace('treeNode1.Name = "nodeApple";', 'treeNode1.Name = "nodeApple";\n            treeNode1.StateImageKey = "state";');
      if ((await listTreeNodes(engine, treeForm, 'treeView1', unmanaged)).ok)
        throw new Error('treenodes: an unmanaged node property must make the collection read-only (ok:false)');
      if ((await setTreeNodes(engine, treeForm, 'treeView1', n0.nodes, unmanaged)).safe)
        throw new Error('treenodes: editing a tree with an unmanaged node property must be refused');

      // SAFETY — an unknown node id is refused (can't retarget an arbitrary local)
      if ((await setTreeNodes(engine, treeForm, 'treeView1', [{ id: 'treeNodeBOGUS', text: 'X', name: '', children: [] }], disk)).safe)
        throw new Error('treenodes: an unknown node id must be refused');

      // SAFETY — an all-inline TreeView (Nodes.Add(new TreeNode(...)) with NO locals) must read ok:false,
      // NOT a misleading empty forest that a later commit would then silently drop the inline nodes from.
      const inlineTree = 'namespace S { partial class T { private System.Windows.Forms.TreeView tv;'
        + ' private void InitializeComponent() { this.tv = new System.Windows.Forms.TreeView();'
        + ' this.tv.Nodes.Add(new System.Windows.Forms.TreeNode("Apple")); } } }';
      if ((await listTreeNodes(engine, treeForm, 'tv', inlineTree)).ok)
        throw new Error('treenodes: an all-inline TreeView must read ok:false (no misleading empty forest → silent drop)');

      console.log('e2e: hierarchical collection editor (TreeView.Nodes) verified — renders; Nodes flagged TreeNode; list [Fruits[Apple,Banana],Vegetables[Carrot]]; edit (rename+add child round-trips); reparent (Carrot→root); clear (all removed); unmanaged prop → ok:false + refused; unknown id refused');
    } else {
      console.log('e2e: TreeView.Nodes editor SKIPPED — engine/samples/TreeForm.Designer.cs missing');
    }

    // ---- TreeView node IMAGES (ImageKey/ImageIndex/SelectedImage*) ----
    // TreeImageForm carries nodes with ImageKey/SelectedImageKey (Apple, Fruits) + ImageIndex/SelectedImageIndex
    // (Banana). Assert: an image node is no longer read-only (was ok:false before); read parses all four props;
    // save re-emits them and round-trips exactly (§6.5 gate accepts image assignments); the render is representable.
    const treeImg = path.join(repo, 'engine', 'samples', 'TreeImageForm.Designer.cs');
    if (fs.existsSync(treeImg)) {
      const disk = fs.readFileSync(treeImg, 'utf8');
      const d = await describeDesigner(engine, treeImg);
      if (d.unrepresentable.some((u) => /ImageKey|ImageIndex|Nodes/.test(u))) throw new Error('treenodes-img: image nodes must be representable, got ' + JSON.stringify(d.unrepresentable));

      const n0 = await listTreeNodes(engine, treeImg, 'treeView1', disk);
      if (!n0.ok) throw new Error('treenodes-img: an image tree must now be editable (ok:true), got ' + n0.reason);
      const fruits = n0.nodes.find((n) => n.text === 'Fruits');
      const apple = fruits?.children.find((n) => n.text === 'Apple');
      const banana = fruits?.children.find((n) => n.text === 'Banana');
      if (apple?.imageKey !== 'apple.png' || apple?.selectedImageKey !== 'apple_sel.png') throw new Error('treenodes-img: Apple image keys wrong: ' + JSON.stringify(apple));
      if (banana?.imageIndex !== 1 || banana?.selectedImageIndex !== 2) throw new Error('treenodes-img: Banana image indexes wrong: ' + JSON.stringify(banana));
      if (fruits?.imageKey !== 'folder.png') throw new Error('treenodes-img: Fruits imageKey wrong: ' + JSON.stringify(fruits?.imageKey));

      // round-trip: save the read forest unchanged → images survive + the §6.5 gate accepts the image assignments
      const e1 = await setTreeNodes(engine, treeImg, 'treeView1', n0.nodes, disk);
      if (!e1.safe || e1.text === null) throw new Error('treenodes-img: image round-trip rejected: ' + e1.reason);
      if (!/treeNode\d+\.ImageKey = "apple\.png";/.test(e1.text) || !/treeNode\d+\.ImageIndex = 1;/.test(e1.text) || !/treeNode\d+\.SelectedImageIndex = 2;/.test(e1.text))
        throw new Error('treenodes-img: save must re-emit the image assignments');
      const r1 = await listTreeNodes(engine, treeImg, 'treeView1', e1.text);
      const apple2 = r1.nodes.find((n) => n.text === 'Fruits')?.children.find((n) => n.text === 'Apple');
      if (apple2?.imageKey !== 'apple.png' || apple2?.selectedImageKey !== 'apple_sel.png') throw new Error('treenodes-img: re-read after save lost Apple images: ' + JSON.stringify(apple2));

      // edit an image: change Apple's key → the new key is emitted, the others untouched
      const editedForest = JSON.parse(JSON.stringify(n0.nodes));
      editedForest.find((n: TreeNodeItem) => n.text === 'Fruits').children.find((n: TreeNodeItem) => n.text === 'Apple').imageKey = 'apricot.png';
      const e2 = await setTreeNodes(engine, treeImg, 'treeView1', editedForest, disk);
      if (!e2.safe || e2.text === null || !/ImageKey = "apricot\.png";/.test(e2.text) || /ImageKey = "apple\.png";/.test(e2.text))
        throw new Error('treenodes-img: editing an image key must re-emit the new key: ' + (e2.reason || 'no apricot'));

      // MUTUAL EXCLUSIVITY (ImageKey/ImageIndex are mutually exclusive, last-write-wins at runtime):
      // (a) a hand-written node with index-THEN-key has the KEY effective — the read collapses to the effective member
      // (imageIndex cleared) and the save emits ONLY the key, never a competing ImageIndex that would silently shadow it.
      const bothSrc = 'namespace S{partial class F{private System.Windows.Forms.TreeView tv;private void InitializeComponent(){'
        + 'System.Windows.Forms.TreeNode tn1 = new System.Windows.Forms.TreeNode("A");'
        + 'this.tv = new System.Windows.Forms.TreeView();'
        + 'tn1.ImageIndex = 5;' // index first…
        + 'tn1.ImageKey = "keyWins";' // …then key → KEY is the effective image at runtime
        + 'tn1.Name = "n1";'
        + 'this.tv.Location = new System.Drawing.Point(1, 1);'
        + 'this.tv.Name = "tv";'
        + 'this.tv.Nodes.AddRange(new System.Windows.Forms.TreeNode[] { tn1 });'
        + '}}}';
      const bx = await listTreeNodes(engine, treeImg, 'tv', bothSrc);
      if (!bx.ok) throw new Error('treenodes-img: an index-then-key node must be readable, got ' + bx.reason);
      if (bx.nodes[0].imageKey !== 'keyWins' || bx.nodes[0].imageIndex !== -1)
        throw new Error('treenodes-img: read must collapse index-then-key to the effective KEY (imageKey=keyWins, imageIndex=-1), got ' + JSON.stringify({ k: bx.nodes[0].imageKey, i: bx.nodes[0].imageIndex }));
      const bxe = await setTreeNodes(engine, treeImg, 'tv', bx.nodes, bothSrc);
      if (!bxe.safe || bxe.text === null) throw new Error('treenodes-img: index-then-key round-trip rejected: ' + bxe.reason);
      if (!/tn1\.ImageKey = "keyWins";/.test(bxe.text) || /tn1\.ImageIndex =/.test(bxe.text))
        throw new Error('treenodes-img: save must emit ONLY the effective ImageKey, no shadowing ImageIndex, got ' + bxe.text);

      // (b) a DESIRED node (the popup exposes both editors) that carries BOTH imageKey and imageIndex must persist
      // key-preferred — never both — so the index can't shadow a just-typed key (and net48 key-first agrees).
      const bothForest = JSON.parse(JSON.stringify(n0.nodes));
      const bApple = bothForest.find((n: TreeNodeItem) => n.text === 'Fruits').children.find((n: TreeNodeItem) => n.text === 'Apple');
      bApple.imageKey = 'kept.png'; bApple.imageIndex = 7;
      const be = await setTreeNodes(engine, treeImg, 'treeView1', bothForest, disk);
      if (!be.safe || be.text === null) throw new Error('treenodes-img: both-set desired forest rejected: ' + be.reason);
      if (!/ImageKey = "kept\.png";/.test(be.text) || /ImageIndex = 7;/.test(be.text))
        throw new Error('treenodes-img: a desired node with both key+index must emit key only (key-preferred), got ' + be.text);

      // ToolTipText (string) + Checked (bool) round-trip: parsed, re-emitted; unchecking drops the assignment (default).
      const scSrc = 'namespace S{partial class F{private System.Windows.Forms.TreeView tv;private void InitializeComponent(){'
        + 'System.Windows.Forms.TreeNode tn1 = new System.Windows.Forms.TreeNode("A");'
        + 'this.tv = new System.Windows.Forms.TreeView();'
        + 'tn1.Name = "n1";'
        + 'tn1.ToolTipText = "hover me";'
        + 'tn1.Checked = true;'
        + 'this.tv.Location = new System.Drawing.Point(1, 1);'
        + 'this.tv.Name = "tv";'
        + 'this.tv.Nodes.AddRange(new System.Windows.Forms.TreeNode[] { tn1 });'
        + '}}}';
      const sc = await listTreeNodes(engine, treeImg, 'tv', scSrc);
      if (!sc.ok) throw new Error('treenodes-img: a ToolTipText/Checked node must be readable, got ' + sc.reason);
      if (sc.nodes[0].toolTipText !== 'hover me' || sc.nodes[0].checked !== true)
        throw new Error('treenodes-img: ToolTipText/Checked not parsed, got ' + JSON.stringify({ t: sc.nodes[0].toolTipText, c: sc.nodes[0].checked }));
      const sce = await setTreeNodes(engine, treeImg, 'tv', sc.nodes, scSrc);
      if (!sce.safe || sce.text === null || !/tn1\.ToolTipText = "hover me";/.test(sce.text) || !/tn1\.Checked = true;/.test(sce.text))
        throw new Error('treenodes-img: ToolTipText/Checked round-trip failed, got ' + (sce.text || sce.reason));
      const scOff = JSON.parse(JSON.stringify(sc.nodes)); scOff[0].checked = false; scOff[0].toolTipText = '';
      const sceOff = await setTreeNodes(engine, treeImg, 'tv', scOff, scSrc);
      if (!sceOff.safe || sceOff.text === null || /Checked/.test(sceOff.text) || /ToolTipText/.test(sceOff.text))
        throw new Error('treenodes-img: clearing ToolTipText + unchecking must drop both assignments (defaults), got ' + (sceOff.text || sceOff.reason));

      console.log('e2e: TreeView node images + scalars verified — image nodes editable; ImageKey/ImageIndex/SelectedImage* + ToolTipText/Checked parsed + round-trip (§6.5 accepts); mutual exclusivity: index-then-key collapses to effective key, both-set emits key-preferred (no shadowing index); clearing tooltip/uncheck drops the default assignments');
    } else {
      console.log('e2e: TreeView node images SKIPPED — engine/samples/TreeImageForm.Designer.cs missing');
    }

    // ---- TreeView node STYLE (ForeColor / BackColor / NodeFont) round-trip ----
    // A node with a named color, an ARGB color, and a bold font must be readable (was ok:false before this feature),
    // parse to property-grid INVARIANT strings, and round-trip through the engine's Color/Font converter. A color/font
    // the bounded converter can't represent (a user type, an uninstalled family) keeps the node read-only (no clobber).
    // Uses an inline source (no fixture-file dependency); "Microsoft Sans Serif" is present on every Windows engine host.
    {
      const styleSrc = 'namespace S{partial class F{private System.Windows.Forms.TreeView tv;private void InitializeComponent(){'
        + 'System.Windows.Forms.TreeNode tn1 = new System.Windows.Forms.TreeNode("A");'
        + 'this.tv = new System.Windows.Forms.TreeView();'
        + 'tn1.ForeColor = System.Drawing.Color.Red;'
        + 'tn1.BackColor = System.Drawing.Color.FromArgb(255, 224, 192);'
        + 'tn1.NodeFont = new System.Drawing.Font("Microsoft Sans Serif", 9F, System.Drawing.FontStyle.Bold);'
        + 'tn1.Name = "n1";'
        + 'this.tv.Location = new System.Drawing.Point(1, 1);'
        + 'this.tv.Name = "tv";'
        + 'this.tv.Nodes.AddRange(new System.Windows.Forms.TreeNode[] { tn1 });'
        + '}}}';
      const st = await listTreeNodes(engine, treeImg, 'tv', styleSrc);
      if (!st.ok) throw new Error('treenodes-style: a styled node must be readable, got ' + st.reason);
      const sn = st.nodes[0];
      if (sn.foreColor !== 'Red') throw new Error('treenodes-style: ForeColor should read "Red", got ' + JSON.stringify(sn.foreColor));
      if (sn.backColor !== '255, 224, 192') throw new Error('treenodes-style: BackColor should read "255, 224, 192", got ' + JSON.stringify(sn.backColor));
      if (!/^Microsoft Sans Serif, 9(\.\d+)?pt, style=Bold$/.test(sn.nodeFont || '')) throw new Error('treenodes-style: NodeFont invariant wrong, got ' + JSON.stringify(sn.nodeFont));

      // round-trip: re-emit the read forest → canonical (fully-qualified) initializers, then re-read is stable
      const se = await setTreeNodes(engine, treeImg, 'tv', st.nodes, styleSrc);
      if (!se.safe || se.text === null) throw new Error('treenodes-style: style round-trip rejected: ' + se.reason);
      if (!/tn1\.ForeColor = System\.Drawing\.Color\.Red;/.test(se.text)) throw new Error('treenodes-style: ForeColor not re-emitted: ' + se.text);
      if (!/tn1\.BackColor = System\.Drawing\.Color\.FromArgb\(255, 224, 192\);/.test(se.text)) throw new Error('treenodes-style: BackColor not re-emitted: ' + se.text);
      if (!/tn1\.NodeFont = new System\.Drawing\.Font\("Microsoft Sans Serif", 9F, System\.Drawing\.FontStyle\.Bold/.test(se.text)) throw new Error('treenodes-style: NodeFont not re-emitted: ' + se.text);
      const re = await listTreeNodes(engine, treeImg, 'tv', se.text);
      if (re.nodes[0].foreColor !== 'Red' || re.nodes[0].backColor !== '255, 224, 192') throw new Error('treenodes-style: re-read after save lost colors: ' + JSON.stringify(re.nodes[0]));

      // edit a color to a SYSTEM color → the system-color initializer is emitted, the old one gone
      const ed = JSON.parse(JSON.stringify(st.nodes)); ed[0].foreColor = 'ControlText';
      const ee = await setTreeNodes(engine, treeImg, 'tv', ed, styleSrc);
      if (!ee.safe || ee.text === null || !/tn1\.ForeColor = System\.Drawing\.SystemColors\.ControlText;/.test(ee.text) || /Color\.Red/.test(ee.text))
        throw new Error('treenodes-style: editing ForeColor to a system color must re-emit it, got ' + (ee.reason || ee.text));

      // clearing a style drops the assignment (matches the default → the §6.5 gate stays minimal)
      const cl = JSON.parse(JSON.stringify(st.nodes)); cl[0].foreColor = ''; cl[0].backColor = ''; cl[0].nodeFont = '';
      const ce = await setTreeNodes(engine, treeImg, 'tv', cl, styleSrc);
      if (!ce.safe || ce.text === null || /ForeColor|BackColor|NodeFont/.test(ce.text))
        throw new Error('treenodes-style: clearing fore/back/font must drop all three assignments, got ' + (ce.text || ce.reason));

      // SAFETY: a color from a USER type (not Color/SystemColors) keeps the whole node read-only (converter refuses)
      const userColorSrc = styleSrc.replace('System.Drawing.Color.Red', 'MyApp.Palette.Brand');
      if ((await listTreeNodes(engine, treeImg, 'tv', userColorSrc)).ok)
        throw new Error('treenodes-style: a user-type color must make the node read-only (no clobber)');
      // SAFETY: an uninstalled font family would be silently substituted by GDI+ → refuse (read-only), no lossy round-trip
      const badFontSrc = styleSrc.replace('Microsoft Sans Serif', 'No Such Font Family 12345');
      if ((await listTreeNodes(engine, treeImg, 'tv', badFontSrc)).ok)
        throw new Error('treenodes-style: an uninstalled font family must make the node read-only (substitution would lose the family)');

      // REGRESSION (HIGH): a non-Point GraphicsUnit must NOT be reinterpreted as a FontStyle
      // (a wrong-overload bug read new Font(f, 12, GraphicsUnit.Pixel) as "12pt, style=Italic" and persisted it).
      const unitSrc = styleSrc.replace('new System.Drawing.Font("Microsoft Sans Serif", 9F, System.Drawing.FontStyle.Bold)',
        'new System.Drawing.Font("Microsoft Sans Serif", 12F, System.Drawing.GraphicsUnit.Pixel)');
      const us = await listTreeNodes(engine, treeImg, 'tv', unitSrc);
      if (!us.ok) throw new Error('treenodes-style: a GraphicsUnit.Pixel font must be readable, got ' + us.reason);
      if (us.nodes[0].nodeFont !== 'Microsoft Sans Serif, 12px')
        throw new Error('treenodes-style: a Pixel font must read as "..., 12px" (unit preserved), got ' + JSON.stringify(us.nodes[0].nodeFont));
      const ue = await setTreeNodes(engine, treeImg, 'tv', us.nodes, unitSrc);
      if (!ue.safe || ue.text === null || !/GraphicsUnit\.Pixel/.test(ue.text) || /FontStyle\.(Italic|Underline)/.test(ue.text))
        throw new Error('treenodes-style: a Pixel font must re-emit GraphicsUnit.Pixel, never a reinterpreted FontStyle, got ' + (ue.reason || ue.text));

      console.log('e2e: TreeView node style verified — ForeColor/BackColor/NodeFont parse to invariant strings + round-trip (named/ARGB/system color, Bold font, fully-qualified re-emit); edit→system color; clearing drops all three; a user-type color and an uninstalled font family both keep the node read-only (no clobber); a non-Point GraphicsUnit (Pixel) is preserved, never reinterpreted as a FontStyle (regression)');
    }

    // ---- TreeView.Nodes owner-scoping — two TreeViews on one form edit INDEPENDENTLY ----
    // Regression guard for the form-global-orphan defect: TwoTreeForm has treeLeft (Left-B[Left-A]) + treeRight (Right-A).
    const twoTree = path.join(repo, 'engine', 'samples', 'TwoTreeForm.Designer.cs');
    if (fs.existsSync(twoTree)) {
      const disk = fs.readFileSync(twoTree, 'utf8');
      // both trees read independently (form-global orphan detection would have refused BOTH)
      const l = await listTreeNodes(engine, twoTree, 'treeLeft', disk);
      const rr = await listTreeNodes(engine, twoTree, 'treeRight', disk);
      if (!l.ok || l.nodes.length !== 1 || l.nodes[0].text !== 'Left-B' || l.nodes[0].children[0].text !== 'Left-A')
        throw new Error('treenodes(2): treeLeft did not read independently: ' + JSON.stringify(l));
      if (!rr.ok || rr.nodes.length !== 1 || rr.nodes[0].text !== 'Right-A')
        throw new Error('treenodes(2): treeRight did not read independently: ' + JSON.stringify(rr));
      // editing treeLeft must NOT touch treeRight's nodes (owner-scoped drop + gate)
      const le = await setTreeNodes(engine, twoTree, 'treeLeft', [{ id: 'treeNode2', text: 'Left-B-EDITED', name: 'leftB', children: l.nodes[0].children }], disk);
      if (!le.safe || le.text === null) throw new Error('treenodes(2): treeLeft edit rejected: ' + le.reason);
      const rr2 = await listTreeNodes(engine, twoTree, 'treeRight', le.text);
      if (!rr2.ok || rr2.nodes.length !== 1 || rr2.nodes[0].text !== 'Right-A' || rr2.nodes[0].name !== 'rightA')
        throw new Error('treenodes(2): editing treeLeft corrupted treeRight: ' + JSON.stringify(rr2));
      if (!/Left-B-EDITED/.test(le.text)) throw new Error('treenodes(2): treeLeft edit did not apply');
      console.log('e2e: TreeView.Nodes owner-scoping verified — two TreeViews on one form read + edit independently (editing one preserves the other)');
    } else {
      console.log('e2e: TreeView.Nodes owner-scoping SKIPPED — engine/samples/TwoTreeForm.Designer.cs missing');
    }

    // ---- ToolStrip / MenuStrip item editor ----
    // MenuForm has menuStrip1 with File[Open,Save] + Edit (ToolStripMenuItem fields via Items/DropDownItems.AddRange).
    // Assert: describe flags Items as ToolStripItem; list reads the recursive tree; a top-level / submenu reorder
    // rewrites ONLY the relevant AddRange (item property blocks + the other collection untouched); add/remove refused.
    const tsMenuForm = path.join(repo, 'engine', 'samples', 'MenuForm.Designer.cs');
    if (fs.existsSync(tsMenuForm)) {
      const disk = fs.readFileSync(tsMenuForm, 'utf8');
      const dc = await describeComponent(engine, tsMenuForm, 'menuStrip1');
      const itemsProp = dc?.properties?.find((p) => p.name === 'Items');
      if (itemsProp?.collectionItemType !== 'System.Windows.Forms.ToolStripItem')
        throw new Error('toolstrip: MenuStrip.Items must be flagged as a ToolStripItem collection, got ' + JSON.stringify(itemsProp?.collectionItemType));

      const t0 = await listToolStripItems(engine, tsMenuForm, 'menuStrip1', disk);
      if (!t0.ok) throw new Error('toolstrip: menu must be readable, got ' + t0.reason);
      const file = t0.items.find((i) => i.text === 'File');
      const edit = t0.items.find((i) => i.text === 'Edit');
      if (!file || !edit) throw new Error('toolstrip: File/Edit items missing: ' + JSON.stringify(t0.items.map((i) => i.text)));
      if (file.itemType !== 'ToolStripMenuItem') throw new Error('toolstrip: File itemType wrong: ' + file.itemType);
      if (file.children.map((c) => c.text).join(',') !== 'Open,Save') throw new Error('toolstrip: File submenu wrong: ' + JSON.stringify(file.children.map((c) => c.text)));

      // top-level reorder: Edit before File → only the menuStrip1.Items AddRange element order changes
      const e1 = await setToolStripItems(engine, tsMenuForm, 'menuStrip1', [edit, file], disk);
      if (!e1.safe || e1.text === null) throw new Error('toolstrip: reorder rejected: ' + e1.reason);
      const itemsIdx = e1.text.indexOf('menuStrip1.Items.AddRange');
      const editIdx = e1.text.indexOf('this.editToolStripMenuItem', itemsIdx);
      const fileIdx = e1.text.indexOf('this.fileToolStripMenuItem', itemsIdx);
      if (!(itemsIdx > 0 && editIdx > 0 && fileIdx > editIdx)) throw new Error('toolstrip: Items AddRange must list Edit before File after reorder');
      if (!/this\.fileToolStripMenuItem\.Text = "File";/.test(e1.text)) throw new Error('toolstrip: item property blocks must be preserved (File.Text)');
      const r1 = await listToolStripItems(engine, tsMenuForm, 'menuStrip1', e1.text);
      if (r1.items.map((i) => i.text).join(',') !== 'Edit,File') throw new Error('toolstrip: re-read after reorder wrong: ' + JSON.stringify(r1.items.map((i) => i.text)));
      if (r1.items.find((i) => i.text === 'File')?.children.map((c) => c.text).join(',') !== 'Open,Save') throw new Error('toolstrip: a top-level reorder must not touch the submenu order');

      // submenu reorder: Save before Open under File → only File.DropDownItems AddRange changes (top-level untouched)
      const file2: ToolStripItemModel = { ...file, children: [file.children[1], file.children[0]] };
      const e2 = await setToolStripItems(engine, tsMenuForm, 'menuStrip1', [file2, edit], disk);
      if (!e2.safe || e2.text === null) throw new Error('toolstrip: submenu reorder rejected: ' + e2.reason);
      const ddIdx = e2.text.indexOf('fileToolStripMenuItem.DropDownItems.AddRange');
      const saveIdx = e2.text.indexOf('this.saveToolStripMenuItem', ddIdx);
      const openIdx = e2.text.indexOf('this.openToolStripMenuItem', ddIdx);
      if (!(ddIdx > 0 && saveIdx > 0 && openIdx > saveIdx)) throw new Error('toolstrip: DropDownItems must list Save before Open after submenu reorder');

      // ---- ADD ("Type Here") ----
      // a NEW item is an empty-id node: the engine synthesizes a field + construction + Name/Text and appends the id
      // into the Items AddRange; existing items stay byte-identical and the new item round-trips on re-read.
      const newHelp: ToolStripItemModel = { id: '', text: 'Help', name: '', itemType: 'ToolStripMenuItem', children: [] };
      const addTop = await setToolStripItems(engine, tsMenuForm, 'menuStrip1', [file, edit, newHelp], disk);
      if (!addTop.safe || addTop.text === null) throw new Error('toolstrip: adding a top-level item must be allowed: ' + addTop.reason);
      if (!/private System\.Windows\.Forms\.ToolStripMenuItem toolStripMenuItem1;/.test(addTop.text)) throw new Error('toolstrip: add must synthesize a new field decl');
      if (!/this\.toolStripMenuItem1 = new System\.Windows\.Forms\.ToolStripMenuItem\(\);/.test(addTop.text)) throw new Error('toolstrip: add must synthesize a construction');
      if (!/this\.toolStripMenuItem1\.Text = "Help";/.test(addTop.text)) throw new Error('toolstrip: add must synthesize the Text');
      if (!/this\.fileToolStripMenuItem\.Text = "File";/.test(addTop.text)) throw new Error('toolstrip: add must leave existing item property blocks intact');
      // the construction MUST precede the Items AddRange that references the new id (else a runtime null-ref)
      const atLines = addTop.text.split(/\r?\n/);
      const ctorLine = atLines.findIndex((l) => /this\.toolStripMenuItem1 = new /.test(l));
      const arLine2 = atLines.findIndex((l) => l.includes('menuStrip1.Items.AddRange'));
      if (ctorLine < 0 || arLine2 < 0 || ctorLine > arLine2) throw new Error('toolstrip: a new item construction must precede the AddRange that references it');
      const addRt = await listToolStripItems(engine, tsMenuForm, 'menuStrip1', addTop.text);
      if (addRt.items.map((i) => i.text).join(',') !== 'File,Edit,Help') throw new Error('toolstrip: added item must round-trip: ' + JSON.stringify(addRt.items.map((i) => i.text)));

      // a FIRST child under a childless existing item (Edit) CREATES its DropDownItems AddRange
      const addFirst = await setToolStripItems(engine, tsMenuForm, 'menuStrip1', [file, { ...edit, children: [{ id: '', text: 'Undo', name: '', itemType: 'ToolStripMenuItem', children: [] }] }], disk);
      if (!addFirst.safe || addFirst.text === null) throw new Error('toolstrip: adding a first child (create AddRange) must be allowed: ' + addFirst.reason);
      if (!/this\.editToolStripMenuItem\.DropDownItems\.AddRange\(/.test(addFirst.text)) throw new Error('toolstrip: a first child must create the DropDownItems AddRange');
      const afRt = await listToolStripItems(engine, tsMenuForm, 'menuStrip1', addFirst.text);
      if (afRt.items.find((i) => i.text === 'Edit')?.children.map((c) => c.text).join(',') !== 'Undo') throw new Error('toolstrip: the created submenu must round-trip');

      // GROW an EXISTING submenu with a new child (File already has Open,Save) — the engine path the on-canvas NESTED
      // "Type Here" gesture reaches (the flyout only opens for a submenu that already has ≥1 child → always a GROW into
      // the owner's existing DropDownItems AddRange, never a first-child CREATE). Open/Save + the sibling Edit stay intact.
      const addNested = await setToolStripItems(engine, tsMenuForm, 'menuStrip1',
        [{ ...file, children: [...file.children, { id: '', text: 'Close', name: '', itemType: 'ToolStripMenuItem', children: [] }] }, edit], disk);
      if (!addNested.safe || addNested.text === null) throw new Error('toolstrip: growing an existing submenu (nested add) must be allowed: ' + addNested.reason);
      if (!/this\.toolStripMenuItem1\.Text = "Close";/.test(addNested.text)) throw new Error('toolstrip: nested add must synthesize the new child construction + Text');
      if (!/this\.saveToolStripMenuItem\.Text = "Save";/.test(addNested.text) || !/this\.openToolStripMenuItem\.Text = "Open";/.test(addNested.text)) throw new Error('toolstrip: nested add must leave the existing submenu children byte-intact');
      const anRt = await listToolStripItems(engine, tsMenuForm, 'menuStrip1', addNested.text);
      if (anRt.items.find((i) => i.text === 'File')?.children.map((c) => c.text).join(',') !== 'Open,Save,Close') throw new Error('toolstrip: nested add must round-trip the grown submenu (Open,Save,Close): ' + JSON.stringify(anRt.items.find((i) => i.text === 'File')?.children.map((c) => c.text)));
      if (anRt.items.find((i) => i.text === 'Edit')?.children.length !== 0) throw new Error('toolstrip: nested add must not touch a sibling top-level item');

      // ADD + REORDER in one edit (Help added, Edit moved before File)
      const addReo = await setToolStripItems(engine, tsMenuForm, 'menuStrip1', [edit, file, newHelp], disk);
      if (!addReo.safe || addReo.text === null) throw new Error('toolstrip: add + reorder in one edit must be allowed');
      const arRt = await listToolStripItems(engine, tsMenuForm, 'menuStrip1', addReo.text);
      if (arRt.items.map((i) => i.text).join(',') !== 'Edit,File,Help') throw new Error('toolstrip: add + reorder must round-trip Edit,File,Help');

      // a new item whose Text literal happens to contain "this.<existingField>" must NOT false-trip the gate — the
      // added-statement field-reference check reads the AST, not the source text, so string content is never code.
      const tricky = await setToolStripItems(engine, tsMenuForm, 'menuStrip1', [file, edit, { id: '', text: 'goto this.fileToolStripMenuItem', name: '', itemType: 'ToolStripMenuItem', children: [] }], disk);
      if (!tricky.safe) throw new Error('toolstrip: an item Text containing "this.<field>" must not false-trip the gate (AST field-ref check)');

      // ---- REGRESSION ----
      // #HIGH: rooting the editor on a MENU ITEM (its DropDownItems) and creating a first child must synthesize a
      // DropDownItems AddRange, NOT Items (a ToolStripMenuItem has no Items property → would not compile).
      const rootedOnItem = await setToolStripItems(engine, tsMenuForm, 'editToolStripMenuItem', [{ id: '', text: 'Undo', name: '', itemType: 'ToolStripMenuItem', children: [] }], disk);
      if (!rootedOnItem.safe || rootedOnItem.text === null) throw new Error('toolstrip: adding to a menu item’s DropDownItems must be allowed: ' + rootedOnItem.reason);
      if (!/editToolStripMenuItem\.DropDownItems\.AddRange\(/.test(rootedOnItem.text) || /editToolStripMenuItem\.Items\.AddRange\(/.test(rootedOnItem.text))
        throw new Error('toolstrip: a menu-item-rooted create must use DropDownItems, never Items');
      // #LOW: a leading comment on the first AddRange element must not be DUPLICATED onto the appended new element
      // (which would false-reject the add via the comment-multiset gate).
      const cmtSrc = disk.replace('this.fileToolStripMenuItem,', '// first item\n this.fileToolStripMenuItem,');
      const cmtAdd = await setToolStripItems(engine, tsMenuForm, 'menuStrip1', [file, edit, { id: '', text: 'Help', name: '', itemType: 'ToolStripMenuItem', children: [] }], cmtSrc);
      if (!cmtAdd.safe || cmtAdd.text === null) throw new Error('toolstrip: adding to a menu whose first element has a leading comment must be allowed (comment not duplicated): ' + cmtAdd.reason);
      if ((cmtAdd.text.match(/\/\/ first item/g) || []).length !== 1) throw new Error('toolstrip: the leading comment must not be duplicated by an append');
      // #MEDIUM: a receiver whose construction is INTERLEAVED after the layout block must refuse a first-child create
      // (else the synthesized AddRange would reference a not-yet-constructed field → runtime null-ref).
      const lateSrc = [
        'namespace S { partial class F {',
        '  private System.Windows.Forms.MenuStrip menuStrip1;',
        '  private System.Windows.Forms.ToolStripMenuItem fileToolStripMenuItem;',
        '  private System.Windows.Forms.ToolStripMenuItem editToolStripMenuItem;',
        '  private void InitializeComponent() {',
        '    this.menuStrip1 = new System.Windows.Forms.MenuStrip();',
        '    this.fileToolStripMenuItem = new System.Windows.Forms.ToolStripMenuItem();',
        '    this.menuStrip1.SuspendLayout();',
        '    this.editToolStripMenuItem = new System.Windows.Forms.ToolStripMenuItem();',
        '    this.menuStrip1.Items.AddRange(new System.Windows.Forms.ToolStripItem[] { this.fileToolStripMenuItem, this.editToolStripMenuItem });',
        '    this.fileToolStripMenuItem.Text = "File"; this.editToolStripMenuItem.Text = "Edit";',
        '  } } }',
      ].join('\n');
      const lateAdd = await setToolStripItems(engine, tsMenuForm, 'menuStrip1', [{ id: 'fileToolStripMenuItem', text: 'File', name: '', itemType: 'ToolStripMenuItem', children: [] }, { id: 'editToolStripMenuItem', text: 'Edit', name: '', itemType: 'ToolStripMenuItem', children: [{ id: '', text: 'Undo', name: '', itemType: 'ToolStripMenuItem', children: [] }] }], lateSrc);
      if (lateAdd.safe) throw new Error('toolstrip: a first-child create under a late/interleaved-construction receiver must be refused (runtime null-ref guard)');

      // ---- REMOVE ----
      // removing a top-level item deletes its field decl + construction + property block and strips it from the Items
      // AddRange; every surviving item (and the other submenu) stays byte-identical and round-trips.
      const rmEdit = await setToolStripItems(engine, tsMenuForm, 'menuStrip1', [file], disk);
      if (!rmEdit.safe || rmEdit.text === null) throw new Error('toolstrip: removing a top-level item must be allowed: ' + rmEdit.reason);
      if (/this\.editToolStripMenuItem\b/.test(rmEdit.text) || /editToolStripMenuItem;/.test(rmEdit.text))
        throw new Error('toolstrip: a removed item must leave no code trace (field decl / construction / property / AddRange)');
      if (!/this\.fileToolStripMenuItem\.Text = "File";/.test(rmEdit.text) || !/this\.openToolStripMenuItem\.Text = "Open";/.test(rmEdit.text))
        throw new Error('toolstrip: removal must leave every surviving item’s property block byte-identical');
      const rmRt = await listToolStripItems(engine, tsMenuForm, 'menuStrip1', rmEdit.text);
      if (rmRt.items.map((i) => i.text).join(',') !== 'File') throw new Error('toolstrip: after removing Edit the menu must round-trip File only: ' + JSON.stringify(rmRt.items.map((i) => i.text)));
      if (rmRt.items[0]?.children.map((c) => c.text).join(',') !== 'Open,Save') throw new Error('toolstrip: removing a sibling must not touch the other item’s submenu');

      // removing a SUBMENU PARENT deletes its WHOLE subtree (File + Open + Save) — no dangling child field/construction.
      const rmFile = await setToolStripItems(engine, tsMenuForm, 'menuStrip1', [edit], disk);
      if (!rmFile.safe || rmFile.text === null) throw new Error('toolstrip: removing a submenu parent (whole subtree) must be allowed: ' + rmFile.reason);
      for (const gone of ['fileToolStripMenuItem', 'openToolStripMenuItem', 'saveToolStripMenuItem'])
        if (rmFile.text.includes('this.' + gone) || rmFile.text.includes(' ' + gone + ';')) throw new Error('toolstrip: removing a submenu parent must delete its whole subtree — found ' + gone);
      if (!/private System\.Windows\.Forms\.ToolStripMenuItem editToolStripMenuItem;/.test(rmFile.text)) throw new Error('toolstrip: subtree removal must keep the surviving item’s field decl');

      // removing all of a submenu’s children leaves it childless → its DropDownItems AddRange is DELETED (not empty).
      const rmKids = await setToolStripItems(engine, tsMenuForm, 'menuStrip1', [{ ...file, children: [] }, edit], disk);
      if (!rmKids.safe || rmKids.text === null) throw new Error('toolstrip: removing all of a submenu’s children must be allowed: ' + rmKids.reason);
      if (/DropDownItems\.AddRange/.test(rmKids.text)) throw new Error('toolstrip: a submenu emptied by removal must have its DropDownItems AddRange deleted, not left empty');
      const rkRt = await listToolStripItems(engine, tsMenuForm, 'menuStrip1', rmKids.text);
      if (rkRt.items.find((i) => i.text === 'File')?.children.length !== 0) throw new Error('toolstrip: File must round-trip childless after its children are removed');

      // removing ONE nested child while KEEPING its sibling — the exact edit the on-canvas synthetic flyout's "Delete
      // Item" posts for a nested row (host omits the node from the owner strip's forest via removeToolStripItem). File →
      // {Open, Save}: drop Open, keep Save. Open must leave no trace; Save + File's DropDownItems AddRange survive intact.
      const rmOneKid = await setToolStripItems(engine, tsMenuForm, 'menuStrip1', [{ ...file, children: [file.children[1]] }, edit], disk);
      if (!rmOneKid.safe || rmOneKid.text === null) throw new Error('toolstrip: deleting one nested child (keeping a sibling) must be allowed: ' + rmOneKid.reason);
      if (rmOneKid.text.includes('this.openToolStripMenuItem') || rmOneKid.text.includes(' openToolStripMenuItem;'))
        throw new Error('toolstrip: a deleted nested child must leave no code trace (field decl / construction / property / DropDownItems AddRange)');
      if (!/this\.saveToolStripMenuItem\.Text = "Save";/.test(rmOneKid.text) || !/this\.fileToolStripMenuItem\.Text = "File";/.test(rmOneKid.text))
        throw new Error('toolstrip: deleting one nested child must leave the surviving sibling + parent byte-identical');
      const roRt = await listToolStripItems(engine, tsMenuForm, 'menuStrip1', rmOneKid.text);
      if (roRt.items.find((i) => i.text === 'File')?.children.map((c) => c.text).join(',') !== 'Save')
        throw new Error('toolstrip: after deleting the nested Open, File must round-trip with Save alone: ' + JSON.stringify(roRt.items.find((i) => i.text === 'File')?.children.map((c) => c.text)));

      // removing EVERY top-level item deletes the owner Items AddRange (empty menu, still valid).
      const rmAll = await setToolStripItems(engine, tsMenuForm, 'menuStrip1', [], disk);
      if (!rmAll.safe || rmAll.text === null) throw new Error('toolstrip: removing every item must be allowed (empty menu): ' + rmAll.reason);
      if (/menuStrip1\.Items\.AddRange/.test(rmAll.text)) throw new Error('toolstrip: an emptied menu must have its Items AddRange deleted, not left empty');

      // REMOVE + ADD in one edit: drop Edit, add Help.
      const rmAdd = await setToolStripItems(engine, tsMenuForm, 'menuStrip1', [file, newHelp], disk);
      if (!rmAdd.safe || rmAdd.text === null) throw new Error('toolstrip: remove + add in one edit must be allowed: ' + rmAdd.reason);
      if (/this\.editToolStripMenuItem\b/.test(rmAdd.text)) throw new Error('toolstrip: remove+add must still delete the removed item');
      const raRt = await listToolStripItems(engine, tsMenuForm, 'menuStrip1', rmAdd.text);
      if (raRt.items.map((i) => i.text).join(',') !== 'File,Help') throw new Error('toolstrip: remove Edit + add Help must round-trip File,Help: ' + JSON.stringify(raRt.items.map((i) => i.text)));

      // FAIL-SAFE: a remove that would drop a hand-written comment INSIDE the shrunk AddRange is refused, never silent.
      const rcSrc = disk.replace('this.fileToolStripMenuItem,', 'this.fileToolStripMenuItem, // KEEP-INNER');
      const rmCmt = await setToolStripItems(engine, tsMenuForm, 'menuStrip1', [file], rcSrc);
      if (rmCmt.safe && (rmCmt.text === null || !rmCmt.text.includes('// KEEP-INNER')))
        throw new Error('toolstrip: a remove that would drop an in-AddRange comment must be refused, never silently applied');

      // FAIL-SAFE: removing an item still referenced by NON-item code (a survivor reads it) is refused — the engine
      // can’t prove deleting the field won’t break that reference.
      const refSrc = [
        'namespace S { partial class F {',
        '  private System.Windows.Forms.MenuStrip menuStrip1;',
        '  private System.Windows.Forms.ToolStripMenuItem fileToolStripMenuItem;',
        '  private System.Windows.Forms.ToolStripMenuItem editToolStripMenuItem;',
        '  private void InitializeComponent() {',
        '    this.menuStrip1 = new System.Windows.Forms.MenuStrip();',
        '    this.fileToolStripMenuItem = new System.Windows.Forms.ToolStripMenuItem();',
        '    this.editToolStripMenuItem = new System.Windows.Forms.ToolStripMenuItem();',
        '    this.menuStrip1.Items.AddRange(new System.Windows.Forms.ToolStripItem[] { this.fileToolStripMenuItem, this.editToolStripMenuItem });',
        '    this.menuStrip1.MdiWindowListItem = this.editToolStripMenuItem;',
        '    this.fileToolStripMenuItem.Text = "File";',
        '    this.editToolStripMenuItem.Text = "Edit";',
        '  } } }',
      ].join('\n');
      const refRm = await setToolStripItems(engine, tsMenuForm, 'menuStrip1', [{ id: 'fileToolStripMenuItem', text: 'File', name: '', itemType: 'ToolStripMenuItem', children: [] }], refSrc);
      if (refRm.safe) throw new Error('toolstrip: removing an item still referenced by non-item code (MdiWindowListItem = this.edit) must be refused');

      // FAIL-SAFE (HIGH): a removed item whose field decl SHARES a physical line
      // with an unrelated survivor’s decl must be refused — a whole-line splice would collaterally delete the neighbour
      // (its surviving statements then dangle) and the member-count gate would balance, so this must never save.
      const shareSrc = [
        'namespace S { partial class F {',
        '  private System.Windows.Forms.MenuStrip menuStrip1;',
        '  private System.Windows.Forms.ToolStripMenuItem fileToolStripMenuItem;',
        '  private System.Windows.Forms.ToolStripMenuItem editToolStripMenuItem; private System.Windows.Forms.Button saveButton;',
        '  private void InitializeComponent() {',
        '    this.menuStrip1 = new System.Windows.Forms.MenuStrip();',
        '    this.fileToolStripMenuItem = new System.Windows.Forms.ToolStripMenuItem();',
        '    this.editToolStripMenuItem = new System.Windows.Forms.ToolStripMenuItem();',
        '    this.saveButton = new System.Windows.Forms.Button();',
        '    this.menuStrip1.Items.AddRange(new System.Windows.Forms.ToolStripItem[] { this.fileToolStripMenuItem, this.editToolStripMenuItem });',
        '    this.Controls.Add(this.saveButton);',
        '    this.fileToolStripMenuItem.Text = "File";',
        '    this.editToolStripMenuItem.Text = "Edit";',
        '  } } }',
      ].join('\n');
      const shareRm = await setToolStripItems(engine, tsMenuForm, 'menuStrip1', [{ id: 'fileToolStripMenuItem', text: 'File', name: '', itemType: 'ToolStripMenuItem', children: [] }], shareSrc);
      if (shareRm.safe) throw new Error('toolstrip: removing an item whose field decl shares a physical line with a survivor’s decl must be refused (collateral-deletion guard)');

      // FAIL-SAFE (gate backstop): a `this`-less designer file (removed item's
      // statements written as `editItem = …` not `this.editItem = …`) — Phase 0's this.-scan skips those statements so
      // only the field decl is deleted, leaving a dangling bare reference. The gate backstop (any lingering occurrence
      // of a removed id's name) must refuse it, never save uncompilable code.
      const bareSrc = [
        'namespace S { partial class F {',
        '  private System.Windows.Forms.MenuStrip menuStrip1;',
        '  private System.Windows.Forms.ToolStripMenuItem fileItem;',
        '  private System.Windows.Forms.ToolStripMenuItem editItem;',
        '  private void InitializeComponent() {',
        '    menuStrip1 = new System.Windows.Forms.MenuStrip();',
        '    fileItem = new System.Windows.Forms.ToolStripMenuItem();',
        '    editItem = new System.Windows.Forms.ToolStripMenuItem();',
        '    menuStrip1.Items.AddRange(new System.Windows.Forms.ToolStripItem[] { fileItem, editItem });',
        '    editItem.Text = "Edit";',
        '    fileItem.Text = "File";',
        '  } } }',
      ].join('\n');
      const bareRm = await setToolStripItems(engine, tsMenuForm, 'menuStrip1', [{ id: 'fileItem', text: 'File', name: '', itemType: 'ToolStripMenuItem', children: [] }], bareSrc);
      if (bareRm.safe) throw new Error('toolstrip: removing an item from a this-less designer file (dangling bare ref) must be refused (gate backstop)');

      // SAFETY: reparenting an existing item and a submenu under a BRAND-NEW item are still refused.
      const reparent: ToolStripItemModel[] = [{ ...file, children: [file.children[1]] }, { ...edit, children: [file.children[0]] }];
      if ((await setToolStripItems(engine, tsMenuForm, 'menuStrip1', reparent, disk)).safe)
        throw new Error('toolstrip: reparenting an existing item must be refused');
      const nested: ToolStripItemModel[] = [file, edit, { id: '', text: 'Tools', name: '', itemType: 'ToolStripMenuItem', children: [{ id: '', text: 'Opt', name: '', itemType: 'ToolStripMenuItem', children: [] }] }];
      if ((await setToolStripItems(engine, tsMenuForm, 'menuStrip1', nested, disk)).safe)
        throw new Error('toolstrip: a submenu under a brand-new item must be refused (nested-new)');

      // ---- REGRESSION ----
      // Formatting-drift: a reorder must be a pure line-permutation — the rewritten AddRange element lines keep the
      // SAME leading indent as the `.AddRange(` statement line (previously they drifted to statement-indent + 4).
      const e1Lines = e1.text.split(/\r?\n/);
      const indentOf = (s?: string): number => (s ? s.match(/^[ \t]*/)![0].length : -1);
      const arIndent = indentOf(e1Lines.find((l) => l.includes('menuStrip1.Items.AddRange')));
      const elIndent = indentOf(e1Lines.find((l) => /^[ \t]*this\.editToolStripMenuItem,/.test(l)));
      if (elIndent < 0 || arIndent < 0 || elIndent !== arIndent)
        throw new Error(`toolstrip: reorder must not re-indent AddRange elements (AddRange indent ${arIndent} vs element ${elIndent})`);

      // Data-loss: a hand-written comment INSIDE an Items/DropDownItems AddRange initializer must never be silently
      // dropped by a reorder. The gate guarantees this — the comment is preserved (safe), or the edit is refused;
      // it is NEVER lost with safe:true. (VS never emits such comments, but a hand-edited file may carry one.)
      const cSrc = disk.replace('this.fileToolStripMenuItem,', 'this.fileToolStripMenuItem, // KEEP-THIS-COMMENT');
      const cEdit = await setToolStripItems(engine, tsMenuForm, 'menuStrip1', [edit, file], cSrc);
      if (cEdit.safe && (cEdit.text === null || !cEdit.text.includes('// KEEP-THIS-COMMENT')))
        throw new Error('toolstrip: a comment inside an AddRange was silently dropped by a reorder (reported safe)');

      // Read-scope: a menu populated ONLY by an unmodelled Add shape (the 3-arg Items.Add(string, Image,
      // EventHandler) overload) must be refused read-only (ok:false), not silently presented as an empty collection.
      const addSrc = [
        'namespace S {', '  partial class F {',
        '    private System.Windows.Forms.MenuStrip ms;',
        '    private void InitializeComponent() {',
        '      this.ms = new System.Windows.Forms.MenuStrip();',
        '      this.ms.Items.Add("File", null, this.OnFile);',
        '      this.ms.Items.Add("Edit", null, this.OnEdit);',
        '      this.ms.Name = "ms";',
        '    }',
        '    private void OnFile(object s, System.EventArgs e) { }',
        '    private void OnEdit(object s, System.EventArgs e) { }',
        '  }', '}',
      ].join('\n');
      const addRead = await listToolStripItems(engine, tsMenuForm, 'ms', addSrc);
      if (addRead.ok)
        throw new Error('toolstrip: a menu built only via the 3-arg Items.Add overload must be refused read-only, not read as empty');

      // ---- RENAME an existing item's Text ----
      // Top-level rename File → "Datei": ONLY the one `.Text = "…"` literal changes — the edited text is byte-for-byte the
      // disk text with just that substitution (AddRange order, sibling items, every other statement untouched).
      const rnFile = await setToolStripItems(engine, tsMenuForm, 'menuStrip1', [{ ...file, text: 'Datei' }, edit], disk);
      if (!rnFile.safe || rnFile.text === null) throw new Error('toolstrip: rename rejected: ' + rnFile.reason);
      if (rnFile.text !== disk.replace('this.fileToolStripMenuItem.Text = "File";', 'this.fileToolStripMenuItem.Text = "Datei";'))
        throw new Error('toolstrip: rename must change ONLY the Text literal, leaving every other byte identical');
      const rnRt = await listToolStripItems(engine, tsMenuForm, 'menuStrip1', rnFile.text);
      if (rnRt.items.find((i) => i.id === 'fileToolStripMenuItem')?.text !== 'Datei') throw new Error('toolstrip: rename must round-trip (File→Datei)');
      if (rnRt.items.find((i) => i.id === 'editToolStripMenuItem')?.text !== 'Edit') throw new Error('toolstrip: rename must not touch a sibling’s Text');

      // Submenu-child rename Open → "Opened" (a nested item's literal); every other Text literal intact.
      const fileOpened: ToolStripItemModel = { ...file, children: [{ ...file.children[0], text: 'Opened' }, file.children[1]] };
      const rnKid = await setToolStripItems(engine, tsMenuForm, 'menuStrip1', [fileOpened, edit], disk);
      if (!rnKid.safe || rnKid.text === null) throw new Error('toolstrip: submenu-child rename rejected: ' + rnKid.reason);
      if (!/this\.openToolStripMenuItem\.Text = "Opened";/.test(rnKid.text) || !/this\.saveToolStripMenuItem\.Text = "Save";/.test(rnKid.text) || !/this\.fileToolStripMenuItem\.Text = "File";/.test(rnKid.text))
        throw new Error('toolstrip: submenu-child rename must rewrite only the child’s Text literal');

      // Rename COMBINED with remove + submenu reorder in one edit: keep only File (renamed "Files"), removing Edit and
      // ordering its submenu Save-before-Open.
      const rnCombo = await setToolStripItems(engine, tsMenuForm, 'menuStrip1', [{ ...file, text: 'Files', children: [file.children[1], file.children[0]] }], disk);
      if (!rnCombo.safe || rnCombo.text === null) throw new Error('toolstrip: rename+remove+reorder combo rejected: ' + rnCombo.reason);
      if (!/this\.fileToolStripMenuItem\.Text = "Files";/.test(rnCombo.text)) throw new Error('toolstrip: combo must rename File→Files');
      if (/this\.editToolStripMenuItem\b/.test(rnCombo.text)) throw new Error('toolstrip: combo must still remove Edit');
      const rcRt = await listToolStripItems(engine, tsMenuForm, 'menuStrip1', rnCombo.text);
      if (rcRt.items.map((i) => i.text).join(',') !== 'Files') throw new Error('toolstrip: combo re-read top wrong: ' + JSON.stringify(rcRt.items.map((i) => i.text)));
      if (rcRt.items[0].children.map((c) => c.text).join(',') !== 'Save,Open') throw new Error('toolstrip: combo must reorder the surviving submenu (Save,Open)');

      // An empty desired Text must NOT wipe an existing literal — a caller omitting Text is a reorder, never a clear.
      const rnEmpty = await setToolStripItems(engine, tsMenuForm, 'menuStrip1', [{ ...file, text: '' }, edit], disk);
      if (!rnEmpty.safe || rnEmpty.text === null) throw new Error('toolstrip: empty-Text edit rejected: ' + rnEmpty.reason);
      if (!/this\.fileToolStripMenuItem\.Text = "File";/.test(rnEmpty.text)) throw new Error('toolstrip: an empty desired Text must leave the existing literal unchanged, never clear it');

      // REFUSE: renaming an item that has no simple `.Text = "…"` literal (adding a Text property is a follow-up).
      const noTextSrc = [
        'namespace S { partial class F {',
        '  private System.Windows.Forms.MenuStrip menuStrip1;',
        '  private System.Windows.Forms.ToolStripMenuItem fileItem;',
        '  private System.Windows.Forms.ToolStripMenuItem editItem;',
        '  private void InitializeComponent() {',
        '    this.menuStrip1 = new System.Windows.Forms.MenuStrip();',
        '    this.fileItem = new System.Windows.Forms.ToolStripMenuItem();',
        '    this.editItem = new System.Windows.Forms.ToolStripMenuItem();',
        '    this.menuStrip1.Items.AddRange(new System.Windows.Forms.ToolStripItem[] { this.fileItem, this.editItem });',
        '    this.fileItem.Text = "File";',
        '  } } }',
      ].join('\n');
      const noTextRn = await setToolStripItems(engine, tsMenuForm, 'menuStrip1', [{ id: 'fileItem', text: 'File', name: '', itemType: 'ToolStripMenuItem', children: [] }, { id: 'editItem', text: 'Renamed', name: '', itemType: 'ToolStripMenuItem', children: [] }], noTextSrc);
      if (noTextRn.safe) throw new Error('toolstrip: renaming an item with no `.Text = "…"` literal must be refused (adding a Text property is a follow-up)');

      // ---- item-TYPE picker ----
      // A NEW item may be any allowlisted ToolStrip type (not only ToolStripMenuItem): the engine mints the right
      // `new <Type>()` and skips Text for a separator. Add a separator + a button + a combobox in one edit.
      const addTyped = await setToolStripItems(engine, tsMenuForm, 'menuStrip1', [
        file, edit,
        { id: '', text: '', name: '', itemType: 'ToolStripSeparator', children: [] },
        { id: '', text: 'Run', name: '', itemType: 'ToolStripButton', children: [] },
        { id: '', text: 'Filter', name: '', itemType: 'ToolStripComboBox', children: [] },
      ], disk);
      if (!addTyped.safe || addTyped.text === null) throw new Error('toolstrip: typed ADD rejected: ' + addTyped.reason);
      if (!/new System\.Windows\.Forms\.ToolStripSeparator\(\);/.test(addTyped.text)) throw new Error('toolstrip: typed ADD must construct a ToolStripSeparator');
      if (!/new System\.Windows\.Forms\.ToolStripButton\(\);/.test(addTyped.text) || !/this\.toolStripButton1\.Text = "Run";/.test(addTyped.text)) throw new Error('toolstrip: typed ADD must construct a ToolStripButton carrying its Text');
      if (!/new System\.Windows\.Forms\.ToolStripComboBox\(\);/.test(addTyped.text)) throw new Error('toolstrip: typed ADD must construct a ToolStripComboBox');
      if (/toolStripSeparator1\.Text =/.test(addTyped.text)) throw new Error('toolstrip: a separator must NOT emit a Text assignment');
      const atRt = await listToolStripItems(engine, tsMenuForm, 'menuStrip1', addTyped.text);
      if (atRt.items.map((i) => i.itemType).join(',') !== 'ToolStripMenuItem,ToolStripMenuItem,ToolStripSeparator,ToolStripButton,ToolStripComboBox')
        throw new Error('toolstrip: typed ADD round-trip types wrong: ' + JSON.stringify(atRt.items.map((i) => i.itemType)));
      if (atRt.items.find((i) => i.itemType === 'ToolStripSeparator')?.text !== '') throw new Error('toolstrip: an added separator must round-trip with an empty Text');
      // an UNKNOWN / non-allowlisted new item type is refused (no arbitrary type injection)
      const addBad = await setToolStripItems(engine, tsMenuForm, 'menuStrip1', [file, edit, { id: '', text: 'X', name: '', itemType: 'System.Evil.Type', children: [] }], disk);
      if (addBad.safe) throw new Error('toolstrip: a non-allowlisted new item type must be refused (no arbitrary type injection)');

      console.log('e2e: ToolStrip/MenuStrip item editor verified — Items flagged ToolStripItem; recursive read; reorder rewrites ONLY the AddRange as a pure indent-preserving permutation; ADD (Type Here) synthesizes a new field+ctor+Name/Text and grows/creates the AddRange (construction precedes it), round-trips, and combines with reorder; REMOVE deletes an item’s field+ctor+property block+AddRange membership (whole subtree for a parent; empties delete the AddRange; combines with add), leaves survivors byte-identical, and refuses when it would drop an in-AddRange comment or an item still referenced by non-item code; reparent/nested-new refused; intra-AddRange comment never silently dropped; a 3-arg Items.Add menu refused read-only; RENAME rewrites an existing item’s `.Text = "…"` literal in place (byte-identical elsewhere), round-trips, nests, combines with remove+reorder, never clears on an empty desired Text, and refuses an item with no Text literal; TYPE picker adds any allowlisted item type (separator/button/combobox, separator carries no Text) and refuses a non-allowlisted type');
    } else {
      console.log('e2e: ToolStrip item editor SKIPPED — engine/samples/MenuForm.Designer.cs missing');
    }

    // ---- Typed collection editor (DataGridView.Columns) ----
    // GridForm has dataGridView1 with nameColumn/valueColumn (DataGridViewTextBoxColumn) — a REAL VS shape with
    // ISupportInitialize BeginInit/EndInit + `//\n// <name>\n//` component-separator comments. Assert: describe flags
    // Columns as DataGridViewColumn; list/edit/reorder/remove/add/clear; VS separators tolerated but real notes refused.
    const gridColForm = path.join(repo, 'engine', 'samples', 'GridForm.Designer.cs');
    if (fs.existsSync(gridColForm)) {
      const disk = fs.readFileSync(gridColForm, 'utf8');

      const gdc = await describeComponent(engine, gridColForm, 'dataGridView1');
      const gcProp = gdc?.properties.find((p) => p.name === 'Columns');
      if (!gcProp) throw new Error('gridcolumns: dataGridView1.Columns not surfaced in describe');
      if (!gcProp.isCollection || gcProp.collectionItemType !== 'System.Windows.Forms.DataGridViewColumn')
        throw new Error('gridcolumns: Columns must be flagged isCollection/DataGridViewColumn, got ' + JSON.stringify(gcProp));

      const g0 = await listGridColumns(engine, gridColForm, 'dataGridView1', disk);
      if (!g0.ok || g0.columns.length !== 2) throw new Error('gridcolumns: list did not read 2 columns, got ' + JSON.stringify(g0));
      if (g0.columns[0].id !== 'nameColumn' || g0.columns[0].headerText !== 'Name') throw new Error('gridcolumns: nameColumn row wrong: ' + JSON.stringify(g0.columns[0]));

      // EDIT — the fixture carries VS `// nameColumn` separators; the edit must still pass (separators tolerated),
      // and HeaderText/Width/ReadOnly must round-trip
      const ge1 = await setGridColumns(engine, gridColForm, 'dataGridView1', [
        { id: 'nameColumn', headerText: 'Full Name', width: 150, readOnly: false, visible: true },
        { id: 'valueColumn', headerText: 'Value', width: 100, readOnly: true, visible: true },
      ], disk);
      if (!ge1.safe || ge1.text === null) throw new Error('gridcolumns: edit rejected (VS separators must be tolerated): ' + ge1.reason);
      const gr1 = await listGridColumns(engine, gridColForm, 'dataGridView1', ge1.text);
      if (gr1.columns[0].headerText !== 'Full Name' || gr1.columns[0].width !== 150 || gr1.columns[1].readOnly !== true)
        throw new Error('gridcolumns: edit did not round-trip, got ' + JSON.stringify(gr1.columns));
      if (!/this\.valueColumn\.ReadOnly = true;/.test(ge1.text)) throw new Error('gridcolumns: ReadOnly=true must emit an assignment');
      if (!/this\.nameColumn\.Name = "nameColumn";/.test(ge1.text)) throw new Error('gridcolumns: Name must always be emitted (kept in sync with the field id)');

      // REORDER
      const ge2 = await setGridColumns(engine, gridColForm, 'dataGridView1', [
        { id: 'valueColumn', headerText: 'Value', width: 100, readOnly: false, visible: true },
        { id: 'nameColumn', headerText: 'Name', width: 100, readOnly: false, visible: true },
      ], disk);
      const gr2 = await listGridColumns(engine, gridColForm, 'dataGridView1', ge2.text!);
      if (gr2.columns[0].id !== 'valueColumn' || gr2.columns[1].id !== 'nameColumn') throw new Error('gridcolumns: reorder failed');

      // REMOVE valueColumn — field decl + refs must go
      const ge3 = await setGridColumns(engine, gridColForm, 'dataGridView1', [{ id: 'nameColumn', headerText: 'Name', width: 100, readOnly: false, visible: true }], disk);
      if (!ge3.safe || ge3.text === null) throw new Error('gridcolumns: remove rejected: ' + ge3.reason);
      if (/\bvalueColumn\b/.test(ge3.text)) throw new Error('gridcolumns: remove must delete every valueColumn reference');

      // ADD (new DataGridViewTextBoxColumn) — new field decl of the concrete type
      const ge4 = await setGridColumns(engine, gridColForm, 'dataGridView1', [
        { id: 'nameColumn', headerText: 'Name', width: 100, readOnly: false, visible: true },
        { id: 'valueColumn', headerText: 'Value', width: 100, readOnly: false, visible: true },
        { id: '', headerText: 'Extra', width: 80, readOnly: false, visible: false },
      ], disk);
      if (!ge4.safe || ge4.text === null) throw new Error('gridcolumns: add rejected: ' + ge4.reason);
      const gr4 = await listGridColumns(engine, gridColForm, 'dataGridView1', ge4.text);
      if (gr4.columns.length !== 3 || gr4.columns[2].headerText !== 'Extra' || gr4.columns[2].visible !== false) throw new Error('gridcolumns: add wrong result: ' + JSON.stringify(gr4.columns));
      if (!/private System\.Windows\.Forms\.DataGridViewTextBoxColumn dataGridViewColumn1;/.test(ge4.text)) throw new Error('gridcolumns: add must declare a new DataGridViewTextBoxColumn field');

      // CLEAR
      const ge5 = await setGridColumns(engine, gridColForm, 'dataGridView1', [], disk);
      if (!ge5.safe || ge5.text === null) throw new Error('gridcolumns: clear rejected: ' + ge5.reason);
      if (/Columns\.AddRange/.test(ge5.text)) throw new Error('gridcolumns: clear must remove the AddRange');

      // SAFETY — a data-bound column (DataPropertyName) or a Name that isn't the field id → read-only
      const bound = disk.replace('this.nameColumn.Name = "nameColumn";', 'this.nameColumn.Name = "nameColumn";\n            this.nameColumn.DataPropertyName = "Name";');
      if ((await listGridColumns(engine, gridColForm, 'dataGridView1', bound)).ok) throw new Error('gridcolumns: a data-bound column (DataPropertyName) must be read-only');
      const renamed = disk.replace('this.nameColumn.Name = "nameColumn";', 'this.nameColumn.Name = "different";');
      if ((await listGridColumns(engine, gridColForm, 'dataGridView1', renamed)).ok) throw new Error('gridcolumns: a column whose Name != field id must be read-only');

      // SAFETY — a REAL developer note (multi-word) in the column block must still be refused (separator exclusion is narrow)
      const note = disk.replace('this.nameColumn.HeaderText = "Name";', '// TODO revisit this column mapping\n this.nameColumn.HeaderText = "Name";');
      if ((await setGridColumns(engine, gridColForm, 'dataGridView1', [
        { id: 'nameColumn', headerText: 'X', width: 150, readOnly: false, visible: true },
        { id: 'valueColumn', headerText: 'Value', width: 100, readOnly: false, visible: true },
      ], note)).safe) throw new Error('gridcolumns: a real developer note in the column block must be refused');

      // SAFETY — unknown id refused
      if ((await setGridColumns(engine, gridColForm, 'dataGridView1', [{ id: 'colBOGUS', headerText: 'X', width: 100, readOnly: false, visible: true }], disk)).safe)
        throw new Error('gridcolumns: an unknown column id must be refused');

      // SAFETY (1.0) — a form SPLIT ACROSS PARTIALS. This edit rewrites exactly one declaration (the one
      // holding InitializeComponent), so a column whose FIELD lives in the sibling partial cannot be removed
      // atomically: the construction + AddRange would go while the declaration stayed, leaving a field that still
      // compiles but is forever null — and it was reported SAFE. The reference scan is now form-wide too, so a
      // helper method in the sibling partial is seen rather than silently invalidated. Both must REFUSE.
      const splitGrid = `namespace WinFormsDesigner.Samples
{
    partial class GridForm
    {
        private void InitializeComponent()
        {
            this.dataGridView1 = new System.Windows.Forms.DataGridView();
            this.nameColumn = new System.Windows.Forms.DataGridViewTextBoxColumn();
            this.dataGridView1.Columns.AddRange(new System.Windows.Forms.DataGridViewColumn[] { this.nameColumn });
            this.nameColumn.HeaderText = "Name";
            this.nameColumn.Name = "nameColumn";
            this.Controls.Add(this.dataGridView1);
            this.ClientSize = new System.Drawing.Size(400, 300);
            this.Name = "GridForm";
        }
    }

    partial class GridForm
    {
        private System.Windows.Forms.DataGridView dataGridView1;
        private System.Windows.Forms.DataGridViewTextBoxColumn nameColumn;

        private void RestoreColumnHeader()
        {
            this.nameColumn.HeaderText = "Customer";
        }
    }
}
`;
      const splitRemove = await setGridColumns(engine, gridColForm, 'dataGridView1', [], splitGrid);
      if (splitRemove.safe)
        throw new Error('gridcolumns: removing a column used by a helper in the form\'s OTHER partial must refuse — the cls-only reference scan could not see it and would delete the field out from under it');

      // …and the same shape WITHOUT any outside use, which isolates the second half of the guard: nothing references
      // the column, so the reference scan is happy, yet the field still cannot be removed atomically (it is declared
      // in the partial this edit does not rewrite). Removing it anyway strands a declaration whose construction is
      // gone — a field that compiles and is forever null.
      const splitGridUnused = splitGrid.replace(/\n        private void RestoreColumnHeader\(\)\n        \{\n            this\.nameColumn\.HeaderText = "Customer";\n        \}\n/, '');
      if (splitGridUnused === splitGrid) throw new Error('gridcolumns: fixture setup — the helper-method strip did not match');
      const splitRemoveUnused = await setGridColumns(engine, gridColForm, 'dataGridView1', [], splitGridUnused);
      if (splitRemoveUnused.safe)
        throw new Error('gridcolumns: removing a column whose field is declared in ANOTHER partial must refuse — this edit rewrites only the InitializeComponent-bearing declaration, so the field would survive with its construction deleted');

      // SAFETY — a column referenced in AddRange but never `new`-constructed (malformed source) must be
      // read-only, not "repaired" with a synthesized ctor that could mismatch the field's declared type
      const noCtor = disk.replace('this.nameColumn = new System.Windows.Forms.DataGridViewTextBoxColumn();', '');
      if ((await listGridColumns(engine, gridColForm, 'dataGridView1', noCtor)).ok) throw new Error('gridcolumns: a construction-less column must be read-only');

      // SAFETY — removing a column that shares a multi-variable field declaration must be refused
      // (dropping the whole decl would delete its sibling; VS never emits multi-var decls, but be airtight)
      const multiVar = disk
        .replace('private System.Windows.Forms.DataGridViewTextBoxColumn nameColumn;', 'private System.Windows.Forms.DataGridViewTextBoxColumn nameColumn, valueColumn;')
        .replace('private System.Windows.Forms.DataGridViewTextBoxColumn valueColumn;', '');
      if ((await setGridColumns(engine, gridColForm, 'dataGridView1', [{ id: 'nameColumn', headerText: 'Name', width: 100, readOnly: false, visible: true }], multiVar)).safe)
        throw new Error('gridcolumns: removing a column that shares a field declaration must be refused');

      console.log('e2e: typed collection editor (DataGridView.Columns) verified — Columns flagged DataGridViewColumn; list [nameColumn,valueColumn]; edit (header/width/ReadOnly round-trip, Name kept); reorder; remove (field+refs gone); add (new DataGridViewTextBoxColumn decl); clear; VS `// <name>` separators tolerated; DataPropertyName/renamed → ok:false; real dev-note refused; unknown id refused');
    } else {
      console.log('e2e: DataGridView collection editor SKIPPED — engine/samples/GridForm.Designer.cs missing');
    }

    // ---- Tabs: net9 hidden-tab hit-test filter (parity) + add-tab text splice ----
    // TabForm: tabControl1 with tabPage1 (active, holds pageButton1) + tabPage2 (holds pageLabel2). The layout must
    // DROP controls on the non-active tab (pageLabel2) so a click can't hit them under the active page; AddTabPage
    // must splice a new field + `TabPages.Add` past the OnlyControlAdded gate and still render.
    const tabForm = path.join(repo, 'engine', 'samples', 'TabForm.Designer.cs');
    if (fs.existsSync(tabForm)) {
      const tabDisk = fs.readFileSync(tabForm, 'utf8');
      const layout = await describeLayout(engine, tabForm, undefined, tabDisk);
      const ids = layout.controls.map((c) => c.id);
      if (!ids.includes('pageButton1')) throw new Error('hidden-tab filter dropped the ACTIVE tab control pageButton1: ' + ids.join(','));
      if (ids.includes('pageLabel2')) throw new Error('hidden-tab filter must drop pageLabel2 (on the non-active tabPage2): ' + ids.join(','));
      if (!ids.includes('tabControl1')) throw new Error('tab host tabControl1 missing from the layout');

      const at = await addTabPage(engine, tabForm, 'tabControl1', 'System.Windows.Forms.TabPage', tabDisk);
      if (!at.safe || at.newText === null) throw new Error('AddTabPage rejected: ' + at.reason);
      if (at.newText.indexOf(`private System.Windows.Forms.TabPage ${at.name};`) < 0) throw new Error('add-tab missing field declaration for ' + at.name);
      if (at.newText.indexOf(`this.${at.name} = new System.Windows.Forms.TabPage();`) < 0) throw new Error('add-tab missing ctor for ' + at.name);
      if (at.newText.indexOf(`this.tabControl1.TabPages.Add(this.${at.name});`) < 0) throw new Error('add-tab missing TabPages.Add for ' + at.name);
      if (fs.readFileSync(tabForm, 'utf8') !== tabDisk) throw new Error('add-tab must NOT modify the file on disk');
      const afterAdd = await renderWithLayout(engine, tabForm, undefined, at.newText);
      if (!isPng(afterAdd.png)) throw new Error('add-tab: form did not render with the new tab');
      if (!afterAdd.controls.some((c) => c.id === 'tabControl1')) throw new Error('add-tab: tab host lost after add');
      console.log(`e2e: tabs verified — hidden-tab filter drops non-active-page controls (pageLabel2 gone, pageButton1 kept); AddTabPage splices field + TabPages.Add (${at.name}) past the gate & renders; disk untouched`);

      // Delete-tab (Controls.Add idiom): removing tabPage2 must drop the page AND its subtree (pageLabel2) — field
      // decls + statements + the tabControl1.Controls.Add(this.tabPage2) parenting — while tabPage1/pageButton1 stay.
      const del = await removeTabPage(engine, tabForm, 'tabControl1', 'tabPage2', tabDisk);
      if (!del.safe || del.newText === null) throw new Error('RemoveTabPage(tabControl1, tabPage2) rejected: ' + del.reason);
      if (/\bthis\.tabPage2\b/.test(del.newText)) throw new Error('delete-tab left a reference to this.tabPage2');
      if (/\bthis\.pageLabel2\b/.test(del.newText)) throw new Error('delete-tab left a reference to this.pageLabel2 (subtree not removed)');
      if (del.newText.indexOf('private System.Windows.Forms.TabPage tabPage2;') >= 0) throw new Error('delete-tab left the tabPage2 field');
      if (del.newText.indexOf('private System.Windows.Forms.Label pageLabel2;') >= 0) throw new Error('delete-tab left the pageLabel2 field');
      if (!/\bthis\.tabPage1\b/.test(del.newText) || del.newText.indexOf('this.tabControl1.Controls.Add(this.tabPage1)') < 0) {
        throw new Error('delete-tab must keep the OTHER page tabPage1 and its parenting');
      }
      if (!/\bthis\.pageButton1\b/.test(del.newText)) throw new Error('delete-tab dropped pageButton1 (on the surviving tab)');
      if (fs.readFileSync(tabForm, 'utf8') !== tabDisk) throw new Error('delete-tab must NOT modify the file on disk');
      const afterDel = await renderWithLayout(engine, tabForm, undefined, del.newText);
      if (!isPng(afterDel.png)) throw new Error('delete-tab: form did not render after removing tabPage2');
      const delIds = afterDel.controls.map((c) => c.id);
      if (delIds.includes('tabPage2') || delIds.includes('pageLabel2')) throw new Error('delete-tab: removed page still in the layout: ' + delIds.join(','));
      if (!delIds.includes('tabControl1')) throw new Error('delete-tab: tab host lost after delete');
      // Refusals: an unknown page, and the host itself, must be declined (never a bad edit).
      if ((await removeTabPage(engine, tabForm, 'tabControl1', 'nope', tabDisk)).safe) throw new Error('RemoveTabPage must refuse an unknown page');
      if ((await removeTabPage(engine, tabForm, 'tabControl1', 'this', tabDisk)).safe) throw new Error('RemoveTabPage must refuse the root form');
      console.log('e2e: delete-tab verified — tabPage2 + subtree (pageLabel2) removed, tabPage1/pageButton1 kept, disk untouched, renders; unknown/root refused');
    } else {
      console.log('e2e: tabs SKIPPED — engine/samples/TabForm.Designer.cs missing');
    }

    // ---- Delete-tab AddRange surgery (DevExpress XtraTabControl idiom): TabPages.AddRange(new[]{ A, B, C }) ----
    // Deleting the MIDDLE page B must TRIM only its element from the array (A & C survive as tabs) and remove B's
    // whole subtree (bLabel). Pure text edit — no interpreter needed, so this leg is text-only.
    const tabAddRange = path.join(repo, 'engine', 'samples', 'TabAddRangeForm.Designer.cs');
    if (fs.existsSync(tabAddRange)) {
      const arDisk = fs.readFileSync(tabAddRange, 'utf8');
      const delB = await removeTabPage(engine, tabAddRange, 'tabControl1', 'tabPageB', arDisk);
      if (!delB.safe || delB.newText === null) throw new Error('RemoveTabPage(AddRange, tabPageB) rejected: ' + delB.reason);
      if (/\bthis\.tabPageB\b/.test(delB.newText)) throw new Error('AddRange delete left a reference to this.tabPageB');
      if (/\bthis\.bLabel\b/.test(delB.newText)) throw new Error('AddRange delete left a reference to this.bLabel (subtree not removed)');
      if (delB.newText.indexOf('TabPage tabPageB;') >= 0 || delB.newText.indexOf('Label bLabel;') >= 0) throw new Error('AddRange delete left a subtree field');
      if (delB.newText.indexOf('AddRange') < 0) throw new Error('AddRange delete must KEEP the AddRange (A & C remain)');
      if (!/\bthis\.tabPageA\b/.test(delB.newText) || !/\bthis\.tabPageC\b/.test(delB.newText)) throw new Error('AddRange delete dropped a sibling page (A/C)');
      if (!/\bthis\.aButton\b/.test(delB.newText) || !/\bthis\.cButton\b/.test(delB.newText)) throw new Error('AddRange delete dropped a sibling page control');
      // the trimmed array must list exactly A and C (B gone), any whitespace between.
      if (!/new\s+System\.Windows\.Forms\.TabPage\[\]\s*\{[\s\S]*this\.tabPageA[\s\S]*this\.tabPageC[\s\S]*\}/.test(delB.newText)) {
        throw new Error('AddRange delete: trimmed array must still contain tabPageA and tabPageC');
      }
      if (fs.readFileSync(tabAddRange, 'utf8') !== arDisk) throw new Error('AddRange delete must NOT modify the file on disk');
      console.log('e2e: delete-tab AddRange surgery verified — tabPageB trimmed from TabPages.AddRange, subtree (bLabel) removed, A & C kept, disk untouched');
    } else {
      console.log('e2e: delete-tab AddRange SKIPPED — engine/samples/TabAddRangeForm.Designer.cs missing');
    }

    // ---- Delete-tab adversarial guards (codify the corruption holes an adversarial review found + fixed) ----
    // All three use an inline sourceText override (RemoveTabPage is pure text — the path is a dummy). anyTab is a
    // valid .Designer.cs; each case bends ONE way that used to corrupt or over-delete.
    {
      const dummy = path.join(repo, 'engine', 'samples', 'TabForm.Designer.cs'); // path only; sourceText drives it
      const head = 'namespace S { partial class F {\n' +
        '  private System.ComponentModel.IContainer components = null;\n' +
        '  private System.Windows.Forms.TabControl tc;\n' +
        '  private System.Windows.Forms.TabPage pa;\n' +
        '  private System.Windows.Forms.TabPage pb;\n' +
        '  private System.Windows.Forms.Button ba;\n';
      // (1) BARE (non-this.) reference to a subtree control must be REMOVED with the subtree — not left dangling.
      const bareSrc = head +
        '  private void InitializeComponent() {\n' +
        '    this.tc = new System.Windows.Forms.TabControl();\n' +
        '    this.pa = new System.Windows.Forms.TabPage();\n' +
        '    this.pb = new System.Windows.Forms.TabPage();\n' +
        '    this.ba = new System.Windows.Forms.Button();\n' +
        '    this.tc.Controls.Add(this.pa);\n' +
        '    this.tc.Controls.Add(this.pb);\n' +
        '    this.pa.Controls.Add(this.ba);\n' +
        ' ba.Text = "bare-ref-no-this";\n' + // the corruption trigger: bare id
        '    this.pa.Name = "pa";\n' +
        '  }\n} }\n';
      const bare = await removeTabPage(engine, dummy, 'tc', 'pa', bareSrc);
      if (!bare.safe || bare.newText === null) throw new Error('delete-tab bare-id: should delete cleanly, got: ' + bare.reason);
      if (/\bba\b/.test(bare.newText) || /\bpa\b/.test(bare.newText)) throw new Error('delete-tab bare-id: left a dangling bare reference to the removed subtree');
      if (!/\bthis\.pb\b/.test(bare.newText)) throw new Error('delete-tab bare-id: dropped the surviving page pb');

      // (2) a host-rooted statement that ALSO names a SURVIVING page must NOT be whole-removed → refuse.
      const survSrc = head +
        '  private void InitializeComponent() {\n' +
        '    this.tc = new System.Windows.Forms.TabControl();\n' +
        '    this.pa = new System.Windows.Forms.TabPage();\n' +
        '    this.pb = new System.Windows.Forms.TabPage();\n' +
        ' this.tc.TabPages.Add(this.pa);\n' + // 1-arg parenting (found first)
        ' this.tc.TabPages.AddRange(new System.Windows.Forms.TabPage[] { this.pa, this.pb });\n' + // host-rooted, holds survivor pb
        '    this.pa.Name = "pa";\n' +
        '  }\n} }\n';
      const surv = await removeTabPage(engine, dummy, 'tc', 'pa', survSrc);
      if (surv.safe) throw new Error('delete-tab host-survivor: must REFUSE (would orphan the surviving page pb), but returned safe');

      // (3) a reference to the page in ANOTHER method of the class (Dispose) must be caught → refuse.
      const dispSrc = head +
        '  private void InitializeComponent() {\n' +
        '    this.tc = new System.Windows.Forms.TabControl();\n' +
        '    this.pa = new System.Windows.Forms.TabPage();\n' +
        '    this.pb = new System.Windows.Forms.TabPage();\n' +
        '    this.tc.Controls.Add(this.pa);\n' +
        '    this.tc.Controls.Add(this.pb);\n' +
        '  }\n' +
        '  protected override void Dispose(bool disposing) { this.pa.Dispose(); base.Dispose(disposing); }\n} }\n';
      const disp = await removeTabPage(engine, dummy, 'tc', 'pa', dispSrc);
      if (disp.safe) throw new Error('delete-tab outside-IC: must REFUSE (Dispose still references pa), but returned safe');

      console.log('e2e: delete-tab adversarial guards verified — bare-id ref removed (not dangling); host-survivor & outside-InitializeComponent refs refused');
    }

    // ---- Reset property (VS "Reset" / Dock↔Anchor mutual-exclusivity) ----
    // ResetProperty deletes a property's assignment(s) so it reverts to default. Nothing is interpolated — only
    // whole target-statement lines are removed, safe-save-gated (OnlyPropertyReset): ONLY the (comp, prop) assignments
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
      // whole-line span. The merge must delete that line EXACTLY ONCE (not twice) so following trivia — the
      // KEEP comment — survives. (Adversarial review found the un-merged loop over-deleted the comment.)
      const dupBuf = [
        'namespace S { partial class F {',
        '    private System.Windows.Forms.Panel p;',
        '    private void InitializeComponent() {',
        '        this.p = new System.Windows.Forms.Panel();',
        '        this.p.Dock = System.Windows.Forms.DockStyle.Right; this.p.Dock = System.Windows.Forms.DockStyle.Left;',
        ' // KEEP THIS COMMENT LINE — long enough to be over-deleted by the stale-offset bug',
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
      // (6) a TRAILING comment on the target's own line. A reset deletes whole lines, and OnlyPropertyReset compares
      // statements + field names — a comment is trivia, invisible to it — so this silently deleted the user's
      // comment and still reported success. Reachable from the UI via Dock/Anchor mutual exclusivity. Must refuse.
      const cmtBuf = [
        'namespace S { partial class F {',
        '    private System.Windows.Forms.Panel p;',
        '    private void InitializeComponent() {',
        '        this.p = new System.Windows.Forms.Panel();',
        ' this.p.Dock = System.Windows.Forms.DockStyle.Right; // KEEP: pinned by ticket #4711',
        '        this.p.Name = "p";',
        '        this.Controls.Add(this.p);',
        '    }',
        '} }',
        '',
      ].join('\n');
      const rCmt = await resetProperty(engine, adForm, 'p', 'Dock', cmtBuf);
      if (rCmt.safe || rCmt.text != null)
        throw new Error('ResetProperty must REFUSE when the target line carries a trailing comment (it would be silently deleted), got safe=' + rCmt.safe);
      // (7) a comment INSIDE the statement. A Roslyn span covers the trivia between its first and last token, so the
      // per-line residue check blanks such a comment along with the statement and cannot see it.
      const innerBuf = cmtBuf.replace(
        ' this.p.Dock = System.Windows.Forms.DockStyle.Right; // KEEP: pinned by ticket #4711',
        '        this.p.Dock /* KEEP: ticket 4711 */ = System.Windows.Forms.DockStyle.Right;');
      if (innerBuf === cmtBuf) throw new Error('ResetProperty inner-comment fixture did not apply');
      const rInner = await resetProperty(engine, adForm, 'p', 'Dock', innerBuf);
      if (rInner.safe || rInner.text != null)
        throw new Error('ResetProperty must REFUSE when the target statement CONTAINS a comment (span trivia hides it from the line check), got safe=' + rInner.safe);
      // (8) a PREPROCESSOR DIRECTIVE inside the target statement. Directive trivia is invisible to the statement/field
      // comparison too, so this reset used to delete the whole #if/#else/#endif block — build-affecting source
      // structure — and report success. Any non-whitespace trivia in the span must refuse, not just comments.
      const dirBuf = [
        'namespace S { partial class F {',
        '    private System.Windows.Forms.Panel p;',
        '    private void InitializeComponent() {',
        '        this.p = new System.Windows.Forms.Panel();',
        '        this.p.Dock =',
        '#if FOO',
        '            System.Windows.Forms.DockStyle.Top',
        '#else',
        '            System.Windows.Forms.DockStyle.Bottom',
        '#endif',
        '            ;',
        '        this.p.Name = "p";',
        '        this.Controls.Add(this.p);',
        '    }',
        '} }',
        '',
      ].join('\n');
      const rDir = await resetProperty(engine, adForm, 'p', 'Dock', dirBuf);
      if (rDir.safe || rDir.text != null)
        throw new Error('ResetProperty must REFUSE when the target statement contains a #if/#else directive (it would be silently deleted), got safe=' + rDir.safe);
      console.log('e2e: ResetProperty verified — panel1.Anchor (multi-line) removed with siblings + other controls intact; btn2.Dock reset leaves Anchor (conjugate); same-line duplicate removed once (following comment survives); a trailing comment on the target line REFUSES instead of being silently deleted; no-op & invalid-id handled');
    } else {
      console.log('e2e: ResetProperty SKIPPED — engine/samples/AnchorDockForm.Designer.cs missing');
    }

    // ---- SplitContainer cell placement ----
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

      // ---- 0.12.0 R1: ISupportInitialize BeginInit/EndInit now ROUND-TRIP (re-emitted verbatim, not dropped) ----
      // SplitterForm's SplitContainer emits ((System.ComponentModel.ISupportInitialize)(this.splitContainer1)).BeginInit()/
      // .EndInit(). These are a representable no-op for RENDER (RoundTripSafe==true). BEFORE 0.12.0 the serializer did not
      // re-emit them, so the safe-save gate correctly REFUSED (fail-closed, no silent drop). AS OF 0.12.0 R1 the serializer
      // re-emits them verbatim (DesignerSerializer.InjectSupportInit), so the form now round-trips: previewSave is SAFE and
      // the spliced output CONTAINS both brackets. The gate stays strict — if a bracket regressed to being dropped, its
      // absence from the generated code would re-fail the gate. This proves round-trip preservation, not just "renders".
      const splitRt = await serializeDesigner(engine, splitForm);
      if (splitRt.safe !== true) throw new Error('0.12.0 R1: SplitterForm should be RoundTripSafe (BeginInit is a representable no-op); got safe=' + splitRt.safe + ' unrep=' + splitRt.unrepresentable.join('; '));
      const splitSave = await previewSave(engine, splitForm);
      if (splitSave.safe !== true) throw new Error('0.12.0 R1: SplitterForm save must now be SAFE (BeginInit/EndInit re-emitted), got safe=' + splitSave.safe + ' missing=' + splitSave.missingStatements.join(' | '));
      if (splitSave.reasonCategory !== 'safe') throw new Error('0.12.0 R1: SplitterForm capability must be "safe", got ' + splitSave.reasonCategory);
      if (splitSave.text === null || !/\.BeginInit\(\)/.test(splitSave.text) || !/\.EndInit\(\)/.test(splitSave.text))
        throw new Error('0.12.0 R1: spliced save output must re-emit both the BeginInit and EndInit brackets (round-trip preserved), not drop them');
      console.log(`e2e: 0.12.0 R1 BeginInit/EndInit round-trip verified — SplitterForm previewSave is SAFE (capability=safe) and the spliced output re-emits both ISupportInitialize brackets instead of dropping them`);
    } else {
      console.log('e2e: SplitContainer SKIPPED — engine/samples/SplitterForm.Designer.cs missing');
    }

    // ---- 0.12.0 golden-corpus round-trip matrix (capability preflight) ----
    // Lock the AUTHORITATIVE save-safe verdict + reason category for the whole sample corpus. This is the
    // "re-verify the 0.5.0 round-trip claim end-to-end" contract: every form is EITHER save-safe OR honestly
    // fail-closed with a NAMED reason — never silently. A serializer/gate regression (a form flipping safe↔unsafe,
    // or a wrong reason) fails CI. `previewSave().safe` is the authoritative predicate (NOT RoundTripSafe alone).
    const roundTripCorpus: Array<{ form: string; safe: boolean; reason: string }> = [
      // save-safe — fully round-trips:
      { form: 'SampleForm', safe: true, reason: 'safe' },
      { form: 'EventForm', safe: true, reason: 'safe' }, // += event wirings re-emitted verbatim
      { form: 'ComponentRefForm', safe: true, reason: 'safe' }, // this.AcceptButton = this.okButton round-trips
      { form: 'SplitterForm', safe: true, reason: 'safe' }, // 0.12.0 R1: BeginInit/EndInit re-emitted
      { form: 'TabForm', safe: true, reason: 'safe' },
      { form: 'FlowForm', safe: true, reason: 'safe' },
      { form: 'ListViewForm', safe: true, reason: 'safe' },
      { form: 'TableLayoutForm', safe: true, reason: 'safe' },
      // 1.0 R4: a VS-generated TreeView form round-trips. The serializer used to name generated TreeNode locals
      // "treenode1" (the framework's fallback lower-casing) while every VS-generated source says "treeNode1", so
      // the text-comparing gate reported all of them lost and refused a faithful round-trip (a FALSE refusal).
      // VsNameCreationService now emits VS's camelCase; the gate itself is untouched and just as strict.
      { form: 'TreeForm', safe: true, reason: 'safe' },
      { form: 'TwoTreeForm', safe: true, reason: 'safe' }, // two TreeViews → per-graph node numbering
      // honest fail-closed (the fail-closed 1.0 bar) — each read-only for a NAMED reason, never silently:
      { form: 'GridForm', safe: false, reason: 'binaryResx' },
      { form: 'MenuStripForm', safe: false, reason: 'binaryResx' },
      { form: 'ImageListForm', safe: false, reason: 'binaryResx' },
      { form: 'LocalizableForm', safe: false, reason: 'localizable' },
    { form: 'CustomForm', safe: false, reason: 'unresolvedType' }, // net9 can't load the vendor control (net48 renders)
      { form: 'TabAddRangeForm', safe: false, reason: 'lostStatements' }, // TabPages.AddRange / Hidden SelectedTab (deferred R2/R3)
    { form: 'AnchorDockForm', safe: false, reason: 'lostStatements' }, // anchored bounds recomputed on load
    // Hand-simplified (NOT VS-canonical) source: VS emits Color.FromArgb(((int)(((byte)(255)))), …) and the
    // image-index TreeNode ctor. Regenerating these would rewrite bytes the user never edited, so refusing is
    // correct fail-closed behaviour — NOT the R4 naming bug. Written VS-canonically both are save-safe (asserted
    // in the R4 canonical-form leg below), which is the shape real VS-generated files actually have.
    { form: 'TreeImageForm', safe: false, reason: 'lostStatements' }, // ctor: new TreeNode("Banana") vs ("Banana", 1, 2)
    { form: 'TreeStyleForm', safe: false, reason: 'lostStatements' }, // short Color.FromArgb(255, 224, 192)
    ];
    let corpusChecked = 0;
    for (const row of roundTripCorpus) {
      const fp = path.join(repo, 'engine', 'samples', row.form + '.Designer.cs');
      if (!fs.existsSync(fp)) continue;
      const ps = await previewSave(engine, fp);
      if (ps.safe !== row.safe)
        throw new Error(`golden-corpus: ${row.form} save-safe expected ${row.safe}, got ${ps.safe} (reason ${ps.reasonCategory}, missing ${ps.missingStatements.length}: ${ps.missingStatements.join(' | ')})`);
      if (ps.reasonCategory !== row.reason)
        throw new Error(`golden-corpus: ${row.form} reason expected "${row.reason}", got "${ps.reasonCategory}"`);
      corpusChecked++;
    }
    if (corpusChecked < 12) throw new Error(`golden-corpus: expected >=12 corpus fixtures present, only ${corpusChecked} found`);
    console.log(`e2e: 0.12.0 golden-corpus round-trip matrix verified — ${corpusChecked} fixtures assert their authoritative save-safe verdict + reason category (safe / binaryResx / localizable / unresolvedType / lostStatements)`);

    // ---- 1.0 R4: a VS-CANONICAL TreeView form round-trips ----
    // The corpus keeps TreeImageForm/TreeStyleForm fail-closed because those fixtures are hand-simplified. Real
    // .Designer.cs files are machine-generated by VS, which emits the verbose Color cast and the image-index
    // TreeNode ctor. Written the way VS actually writes them they MUST be save-safe — otherwise the R4 naming fix
    // would only be cosmetic. This is the leg that proves R4 helps real-world files.
    {
      const canonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-r4canon-'));
      try {
        const styleSrc = fs.readFileSync(path.join(repo, 'engine', 'samples', 'TreeStyleForm.Designer.cs'), 'utf8');
        const styleCanon = styleSrc.replace(
          'System.Drawing.Color.FromArgb(255, 224, 192)',
          'System.Drawing.Color.FromArgb(((int)(((byte)(255)))), ((int)(((byte)(224)))), ((int)(((byte)(192)))))');
        if (styleCanon === styleSrc) throw new Error('1.0 R4: TreeStyleForm canonicalization did not apply — fixture changed?');
        const styleFp = path.join(canonDir, 'TreeStyleForm.Designer.cs');
        fs.writeFileSync(styleFp, styleCanon);
        const styleSave = await previewSave(engine, styleFp);
        if (!styleSave.safe || styleSave.reasonCategory !== 'safe')
          throw new Error(`1.0 R4: VS-canonical TreeStyleForm must be save-safe, got safe=${styleSave.safe} reason=${styleSave.reasonCategory} missing=${styleSave.missingStatements.join(' | ')}`);

        const imgSrc = fs.readFileSync(path.join(repo, 'engine', 'samples', 'TreeImageForm.Designer.cs'), 'utf8');
        const imgCanon = imgSrc.replace(
          'System.Windows.Forms.TreeNode treeNode2 = new System.Windows.Forms.TreeNode("Banana");',
          'System.Windows.Forms.TreeNode treeNode2 = new System.Windows.Forms.TreeNode("Banana", 1, 2);');
        if (imgCanon === imgSrc) throw new Error('1.0 R4: TreeImageForm canonicalization did not apply — fixture changed?');
        const imgFp = path.join(canonDir, 'TreeImageForm.Designer.cs');
        fs.writeFileSync(imgFp, imgCanon);
        const imgSave = await previewSave(engine, imgFp);
        if (!imgSave.safe || imgSave.reasonCategory !== 'safe')
          throw new Error(`1.0 R4: VS-canonical TreeImageForm must be save-safe, got safe=${imgSave.safe} reason=${imgSave.reasonCategory} missing=${imgSave.missingStatements.join(' | ')}`);

        console.log('e2e: 1.0 R4 verified — VS-canonical TreeView forms (verbose Color cast + image-index TreeNode ctor) are save-safe, and the generated TreeNode locals are camelCase (treeNode1) exactly as VS emits; hand-simplified fixtures stay honestly fail-closed');
      } finally {
        try { fs.rmSync(canonDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }

    // ---- 1.0 R4 guard: VS-style generated-local naming must NOT leak into the LOAD path ----
    // VsNameCreationService is handed ONLY to the serialization manager (SerializerServices). A previous cut of the
    // fix registered it on the DesignSurface itself, which regressed loading, because the host consults the service
    // even when a name is given explicitly (found by independent review):
    // • a legal verbatim identifier field (@class) hit ValidateName → "Invalid name: @class" → unrepresentable;
    // • the ROOT was auto-named "form", so a real field named `form` threw "Duplicate component name".
    // Both turned perfectly legal forms read-only — the exact FALSE-refusal class R4 exists to remove. Pin them.
    {
      const nameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-r4names-'));
      try {
        const mk = (cls: string, field: string, nameProp: string) => `namespace SampleApp
{
    partial class ${cls}
    {
        private System.Windows.Forms.Button ${field};
        private void InitializeComponent()
        {
            this.${field} = new System.Windows.Forms.Button();
            this.SuspendLayout();
            this.${field}.Location = new System.Drawing.Point(12, 12);
            this.${field}.Name = "${nameProp}";
            this.${field}.Size = new System.Drawing.Size(75, 23);
            this.${field}.TabIndex = 0;
            this.${field}.Text = "Hi";
            this.Controls.Add(this.${field});
            this.ClientSize = new System.Drawing.Size(284, 161);
            this.Name = "${cls}";
            this.ResumeLayout(false);
        }
    }
}
`;
        for (const [cls, field, nameProp, why] of [
          ['AtClassForm', '@class', 'class', 'a legal verbatim-identifier field must not hit a hand-rolled name validator'],
          ['CleanFormField', 'form', 'form', 'a field named like the root type\'s camelCase name must not collide with an auto-named root'],
        ] as Array<[string, string, string, string]>) {
          const fp = path.join(nameDir, cls + '.Designer.cs');
          fs.writeFileSync(fp, mk(cls, field, nameProp));
      const ps = await previewSave(engine, fp);
          if (!ps.safe || ps.reasonCategory !== 'safe')
            throw new Error(`1.0 R4 naming leak: ${cls} must stay save-safe (${why}); got safe=${ps.safe} reason=${ps.reasonCategory} missing=${ps.missingStatements.join(' | ')}`);
        }
        console.log('e2e: 1.0 R4 load-path guard verified — VS-style generated-local naming stays scoped to the serializer: a @class field and a field named "form" both remain save-safe (they regressed to unrepresentable when the service was registered surface-wide)');
      } finally {
        try { fs.rmSync(nameDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }

    // ---- 1.0: the engine renders THE DESIGNER CLASS, never "the first class in the file" ----
    // The renderer used to take the first ClassDeclarationSyntax in the file. A .Designer.cs with a second class
    // ahead of the form therefore rendered the WRONG class and reported it save-safe with no banner, while the
    // property editor and save splicer keyed off InitializeComponent — three components, three answers. All three
    // now share DesignerModifiers.DesignerFormClass (InitializeComponent-declaring, partial-preferred, file-name
    // tiebreak, fail-closed when absent).
    {
      const clsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-clsel-'));
      try {
        // (a) the form is NOT the first class → must still render the form's controls, not the other class's
        const twoClass = path.join(clsDir, 'TwoClass.Designer.cs');
        fs.writeFileSync(twoClass, `namespace SampleApp
{
    partial class SidePanel
    {
        private System.Windows.Forms.Label sideLabel;
    }

    partial class TwoClass
    {
        private System.Windows.Forms.Button okButton;
        private void InitializeComponent()
        {
            this.okButton = new System.Windows.Forms.Button();
            this.SuspendLayout();
            this.okButton.Location = new System.Drawing.Point(12, 12);
            this.okButton.Name = "okButton";
            this.okButton.Size = new System.Drawing.Size(75, 23);
            this.okButton.TabIndex = 0;
            this.okButton.Text = "OK";
            this.Controls.Add(this.okButton);
            this.ClientSize = new System.Drawing.Size(400, 300);
            this.Name = "TwoClass";
            this.Text = "Two Class Form";
            this.ResumeLayout(false);
        }
    }
}
`);
        const twoDesc = await describeDesigner(engine, twoClass);
        const twoIds = twoDesc.components.map(c => c.id);
        if (!twoIds.includes('okButton'))
          throw new Error(`class selection: the FORM's control must render when the form isn't the first class; got components [${twoIds.join(', ')}]`);
        if (twoIds.includes('sideLabel'))
          throw new Error(`class selection: rendered the wrong class (sideLabel belongs to SidePanel, not the form); got [${twoIds.join(', ')}]`);
        const twoSave = await previewSave(engine, twoClass);
        if (!twoSave.safe || twoSave.reasonCategory !== 'safe')
          throw new Error(`class selection: TwoClass should be save-safe once the right class is picked, got safe=${twoSave.safe} reason=${twoSave.reasonCategory}`);

        // (b) a form legitimately split across partials (fields in one, InitializeComponent in another)
        const splitForm = path.join(clsDir, 'SplitForm.Designer.cs');
        fs.writeFileSync(splitForm, `namespace SampleApp
{
    partial class SplitForm
    {
        private System.Windows.Forms.Button okButton;
    }

    partial class SplitForm
    {
        private void InitializeComponent()
        {
            this.okButton = new System.Windows.Forms.Button();
            this.SuspendLayout();
            this.okButton.Location = new System.Drawing.Point(12, 12);
            this.okButton.Name = "okButton";
            this.okButton.Size = new System.Drawing.Size(75, 23);
            this.okButton.TabIndex = 0;
            this.okButton.Text = "OK";
            this.Controls.Add(this.okButton);
            this.ClientSize = new System.Drawing.Size(300, 200);
            this.Name = "SplitForm";
            this.ResumeLayout(false);
        }
    }
}
`);
      const splitSave = await previewSave(engine, splitForm);
        if (!splitSave.safe || splitSave.reasonCategory !== 'safe')
          throw new Error(`class selection: a form split across partials must be save-safe (its fields live in the other partial), got safe=${splitSave.safe} reason=${splitSave.reasonCategory} missing=${splitSave.missingStatements.join(' | ')}`);

        // (c) no designer class at all → fail CLOSED, never render an arbitrary class
        const noForm = path.join(clsDir, 'NoForm.Designer.cs');
        fs.writeFileSync(noForm, 'namespace SampleApp\n{\n    class JustAHelper\n    {\n        private int x;\n    }\n}\n');
        let failedClosed = false;
        try { await describeDesigner(engine, noForm); } catch { failedClosed = true; }
        if (!failedClosed) throw new Error('class selection: a file with no designer class must fail closed, not render some other class');

        // (d) AMBIGUOUS — two top-level classes both declaring InitializeComponent. This MUST fail closed rather than
        // pick one: the save splicer and the byte-surgical editors resolve the class independently (first
        // declarer), so any rule that picks a different one here splices the generated body of one class into
        // the other and reports a successful save. A file-name tiebreak did exactly that: the renderer
        // chose Foo while the splicer rewrote Helper's empty body, producing a file that no longer compiles.
        const ambiguous = path.join(clsDir, 'Foo.Designer.cs');
        fs.writeFileSync(ambiguous, `namespace N
{
    partial class Helper
    {
        private void InitializeComponent() { }
    }

    partial class Foo
    {
        private System.Windows.Forms.Button okButton;
        private void InitializeComponent()
        {
            this.okButton = new System.Windows.Forms.Button();
            this.okButton.Text = "real form";
            this.Controls.Add(this.okButton);
        }
    }
}
`);
        let ambiguousRefused = false;
        try { await describeDesigner(engine, ambiguous); } catch { ambiguousRefused = true; }
        if (!ambiguousRefused)
          throw new Error('class selection: two classes declaring InitializeComponent are AMBIGUOUS and must fail closed — picking one disagrees with the splicer and regenerates into the wrong class');

        // (e) a NESTED declarer counts too. The splicer/editors scan ALL descendant classes, so skipping nested ones
        // here (a top-level-only filter) recreated the very divergence above: the renderer chose the real form
        // while the splicer rewrote Helper.Inner.InitializeComponent — save-safe, non-compiling output.
        const nested = path.join(clsDir, 'NestedProbe.Designer.cs');
        fs.writeFileSync(nested, `namespace N
{
    class Helper
    {
        class Inner
        {
            private void InitializeComponent() { }
        }
    }

    partial class NestedProbe
    {
        private System.Windows.Forms.Button okButton;
        private void InitializeComponent()
        {
            this.okButton = new System.Windows.Forms.Button();
            this.okButton.Text = "real form";
            this.Controls.Add(this.okButton);
            this.ClientSize = new System.Drawing.Size(300, 200);
            this.Name = "NestedProbe";
        }
    }
}
`);
        let nestedRefused = false;
        try { await describeDesigner(engine, nested); } catch { nestedRefused = true; }
        if (!nestedRefused)
          throw new Error('class selection: a NESTED InitializeComponent declarer must make the file ambiguous (the splicer would pick it) and fail closed');

        // (f) an InitializeComponent OVERLOAD ahead of the real one. Every consumer used to take the first method
        // matching the NAME, so the interpreter replayed the empty `InitializeComponent(int)` and rendered an
        // EMPTY form with no banner — a mis-render, and the save splicer would then rewrite that overload's body.
        // Now the class and the method are one decision (FormClassResolver), shared by every consumer, so the
        // parameterless one is unambiguously THE InitializeComponent. This tightening was only safe once the
        // resolver was shared: applied to one selector alone it is precisely the divergence (d)/(e) guard against.
        const overload = path.join(clsDir, 'OverloadForm.Designer.cs');
        fs.writeFileSync(overload, `namespace N
{
    partial class OverloadForm
    {
        private System.Windows.Forms.Button okButton;

        private void InitializeComponent(int unused) { }

        private void InitializeComponent()
        {
            this.okButton = new System.Windows.Forms.Button();
            this.okButton.Location = new System.Drawing.Point(12, 12);
            this.okButton.Name = "okButton";
            this.okButton.Size = new System.Drawing.Size(75, 23);
            this.okButton.TabIndex = 0;
            this.okButton.Text = "OK";
            this.Controls.Add(this.okButton);
            this.ClientSize = new System.Drawing.Size(300, 200);
            this.Name = "OverloadForm";
        }
    }
}
`);
        const ovDesc = await describeDesigner(engine, overload);
        const ovIds = ovDesc.components.map(c => c.id);
        if (!ovIds.includes('okButton'))
          throw new Error(`class selection: an InitializeComponent(int) overload ahead of the real one must NOT be interpreted — the form rendered empty; got [${ovIds.join(', ')}]`);
        const ovSave = await previewSave(engine, overload);
        if (!ovSave.safe || ovSave.reasonCategory !== 'safe')
          throw new Error(`class selection: OverloadForm must stay save-safe (the splicer rewrites the parameterless IC), got safe=${ovSave.safe} reason=${ovSave.reasonCategory} missing=${ovSave.missingStatements.join(' | ')}`);

        // (g) a class declaring ONLY an overload is not a designer class at all → the file fails closed rather than
        // rendering an empty form from a method that was never InitializeComponent.
        const onlyOverload = path.join(clsDir, 'OnlyOverload.Designer.cs');
        fs.writeFileSync(onlyOverload, 'namespace N\n{\n    class OnlyOverload\n    {\n        private void InitializeComponent(int x) { }\n    }\n}\n');
        let onlyOverloadRefused = false;
        try { await describeDesigner(engine, onlyOverload); } catch { onlyOverloadRefused = true; }
        if (!onlyOverloadRefused)
          throw new Error('class selection: a class declaring only an InitializeComponent(int) overload is not a designer class and must fail closed');

        // (h) CODE-BEHIND identity. The designer file's class rule is shared now, but the paired .cs was matched by
        // SIMPLE name, first hit — so a helper `namespace Other { class Form1 }` ahead of the real form made the
        // events dropdown offer Other.Form1's methods and HasMethod validate against them, while the wiring went
        // into Product.Ui.Form1, which has no such method: both files parse, the save reports success, and the
        // project no longer compiles. Matched on the full namespace-qualified identity now.
        const cbDir = path.join(clsDir, 'cb');
        fs.mkdirSync(cbDir, { recursive: true });
        const cbDesigner = path.join(cbDir, 'Form1.Designer.cs');
        fs.writeFileSync(cbDesigner, `namespace Product.Ui
{
    partial class Form1 : System.Windows.Forms.Form
    {
        private System.Windows.Forms.Button button1;

        private void InitializeComponent()
        {
            this.button1 = new System.Windows.Forms.Button();
            this.button1.Location = new System.Drawing.Point(10, 10);
            this.button1.Name = "button1";
            this.button1.Size = new System.Drawing.Size(75, 23);
            this.button1.Text = "Run";
            this.Controls.Add(this.button1);
            this.ClientSize = new System.Drawing.Size(300, 200);
            this.Name = "Form1";
        }
    }
}
`);
        // The decoy declares a signature-compatible handler and comes FIRST in the file.
        const cbCode = `namespace Other
{
    class Form1
    {
        private void button1_Click(object sender, System.EventArgs e) { }
    }
}

namespace Product.Ui
{
    partial class Form1
    {
    }
}
`;
        fs.writeFileSync(path.join(cbDir, 'Form1.cs'), cbCode);
        const cbCands = await listHandlerCandidates(engine, cbDesigner, 'button1', null, cbCode, null);
        const clickCands = cbCands['Click'] || [];
        if (clickCands.includes('button1_Click'))
          throw new Error(`code-behind identity: offered button1_Click, which belongs to Other.Form1 — wiring it into Product.Ui.Form1 produces a non-compiling project; got Click candidates [${clickCands.join(', ')}]`);
        // The "new handler" flow must put the stub in Product.Ui.Form1, NOT in the decoy that merely shares the name.
        const cbGen = await generateEventHandler(engine, cbDesigner, 'button1', 'Click', null, null, cbCode, null);
        if (!cbGen.safe || cbGen.codeText == null)
          throw new Error(`code-behind identity: generating a handler should succeed on the real form, got safe=${cbGen.safe} reason=${cbGen.reason}`);
        // The decoy's own text must be untouched, and the stub must appear in the REAL form's declaration. (Don't
        // search for the handler name globally: the decoy already declares a method of exactly that name+signature —
        // that is the whole point of the fixture.)
        const decoyBefore = cbCode.slice(cbCode.indexOf('namespace Other'), cbCode.indexOf('namespace Product.Ui'));
        const decoyAfter = cbGen.codeText.slice(cbGen.codeText.indexOf('namespace Other'), cbGen.codeText.indexOf('namespace Product.Ui'));
        if (decoyAfter !== decoyBefore)
          throw new Error('code-behind identity: the stub was written into Other.Form1 — a class that merely shares the form\'s simple name; the wiring would reference a method Product.Ui.Form1 does not have');
        const realPart = cbGen.codeText.slice(cbGen.codeText.indexOf('namespace Product.Ui'));
        if (!realPart.includes(cbGen.handlerName + '(object sender'))
          throw new Error(`code-behind identity: the stub ${cbGen.handlerName} did not land in Product.Ui.Form1`);

        // (i) The GLOBAL-namespace form — the identity has no dot, so a "does it look qualified?" shortcut would fall
        // back to simple-name matching here and re-open (h) for a NESTED decoy. Identity is compared in full,
        // always: "Helper+GlobalForm" is not "GlobalForm".
        const gDesigner = path.join(cbDir, 'GlobalForm.Designer.cs');
        fs.writeFileSync(gDesigner, `partial class GlobalForm : System.Windows.Forms.Form
{
    private System.Windows.Forms.Button button1;

    private void InitializeComponent()
    {
        this.button1 = new System.Windows.Forms.Button();
        this.button1.Location = new System.Drawing.Point(10, 10);
        this.button1.Name = "button1";
        this.button1.Size = new System.Drawing.Size(75, 23);
        this.button1.Text = "Run";
        this.Controls.Add(this.button1);
        this.ClientSize = new System.Drawing.Size(300, 200);
        this.Name = "GlobalForm";
    }
}
`);
        const gCode = `class Helper
{
    class GlobalForm
    {
        private void button1_Click(object sender, System.EventArgs e) { }
    }
}

partial class GlobalForm
{
}
`;
        const gCands = await listHandlerCandidates(engine, gDesigner, 'button1', null, gCode, null);
        if ((gCands['Click'] || []).includes('button1_Click'))
          throw new Error('code-behind identity: a NESTED same-named class (Helper+GlobalForm) was treated as the global-namespace form — its method would be wired into a form that does not have it');

        // (j) HANDLER SIGNATURE identity. Candidate parameter types were compared by their LAST segment, so a user's
        // own Custom.EventArgs passed as System.EventArgs: the dropdown offered WrongClick, and wiring it emitted
        // `Click += new EventHandler(this.WrongClick)` — not compatible with EventHandler, project stops compiling.
        // A qualified spelling must now agree with the real namespace; correctly-typed handlers still show up.
        const sigCode = `namespace Product.Ui
{
    partial class Form1
    {
        private void WrongClick(object sender, Custom.EventArgs e) { }
        private void RightClick(object sender, System.EventArgs e) { }
        private void AlsoRight(object sender, System.Windows.Forms.MouseEventArgs e) { }
    }
}

namespace Custom
{
    public sealed class EventArgs : System.EventArgs { }
}
`;
        const sigCands = await listHandlerCandidates(engine, cbDesigner, 'button1', null, sigCode, null);
        const sigClick = sigCands['Click'] || [];
        if (sigClick.includes('WrongClick'))
          throw new Error(`code-behind signature: WrongClick takes Custom.EventArgs, which is NOT System.EventArgs — offering it wires an incompatible method group and breaks the build; got [${sigClick.join(', ')}]`);
        if (!sigClick.includes('RightClick'))
          throw new Error(`code-behind signature: a correctly-typed System.EventArgs handler must still be offered; got Click candidates [${sigClick.join(', ')}]`);
        // partial qualification is legal C# and must still match (MouseEventArgs → MouseDown, not Click)
        const sigMouse = sigCands['MouseDown'] || [];
        if (!sigMouse.includes('AlsoRight'))
          throw new Error(`code-behind signature: a fully-qualified MouseEventArgs handler must be offered for MouseDown; got [${sigMouse.join(', ')}]`);

        // (k) A `using` ALIAS makes a qualified spelling mean something the syntactic comparison cannot see. Matching
        // "does the real name end with what was written?" accepted `Forms.MouseEventArgs` for
        // System.Windows.Forms.MouseEventArgs even though the alias binds it elsewhere — wiring it breaks the build.
        const aliasCode = `using Forms = Product.CustomForms;

namespace Product.Ui
{
    partial class Form1
    {
        private void button1_MouseDown(object sender, Forms.MouseEventArgs e) { }
    }
}

namespace Product.CustomForms
{
    public sealed class MouseEventArgs : System.EventArgs { }
}
`;
        const aliasCands = await listHandlerCandidates(engine, cbDesigner, 'button1', null, aliasCode, null);
        if ((aliasCands['MouseDown'] || []).includes('button1_MouseDown'))
          throw new Error('code-behind signature: `using Forms = Product.CustomForms;` makes Forms.MouseEventArgs a DIFFERENT type from System.Windows.Forms.MouseEventArgs — offering it wires an incompatible method group');

        // (l) An ESCAPED identifier is a legal C# spelling whose metadata name has no '@'. Building the identity from
        // the raw spelling produced "@Ui.@Form1", which matches no compiled type — the .NET 4.8 host then reported
        // a perfectly current assembly as a stale build, and the code-behind match failed too.
        const escDesigner = path.join(cbDir, 'EscForm.Designer.cs');
        fs.writeFileSync(escDesigner, `namespace @Ui
{
    partial class @EscForm : System.Windows.Forms.Form
    {
        private System.Windows.Forms.Button button1;

        private void InitializeComponent()
        {
            this.button1 = new System.Windows.Forms.Button();
            this.button1.Name = "button1";
            this.button1.Text = "Run";
            this.Controls.Add(this.button1);
            this.ClientSize = new System.Drawing.Size(300, 200);
            this.Name = "EscForm";
        }
    }
}
`);
        const escCode = `namespace Ui
{
    partial class EscForm
    {
        private void button1_Click(object sender, System.EventArgs e) { }
    }
}
`;
        const escCands = await listHandlerCandidates(engine, escDesigner, 'button1', null, escCode, null);
        if (!(escCands['Click'] || []).includes('button1_Click'))
          throw new Error(`escaped identifiers: @Ui.@EscForm denotes Ui.EscForm — its code-behind handler must be found; got [${(escCands['Click'] || []).join(', ')}]`);

        console.log('e2e: 1.0 class-selection verified — the engine renders the InitializeComponent-declaring form (not the first class in the file), a form split across partials is save-safe, an InitializeComponent(int) overload no longer renders the form empty, the code-behind is matched by full identity (a same-named class in another namespace is not the form), and "no designer class" / "two candidates" / "overload only" all fail closed');
      } finally {
        try { fs.rmSync(clsDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }

    // ---- 1.0: a negative literal keeps its sign for EVERY numeric type ----
    // Eval's unary-minus used to negate only int/double/long and return anything else UNNEGATED, silently: a
    // decimal `Minimum = -100` was described and rendered as 100. A wrong number presented as fact is exactly what
    // the fail-closed bar forbids; unnegatable operands now throw → unrepresentable (banner), never a wrong value.
    {
      const negDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-neg-'));
      try {
        const negForm = path.join(negDir, 'NegForm.Designer.cs');
        fs.writeFileSync(negForm, `namespace SampleApp
{
    partial class NegForm
    {
        private System.Windows.Forms.NumericUpDown numericUpDown1;
        private void InitializeComponent()
        {
            this.numericUpDown1 = new System.Windows.Forms.NumericUpDown();
            this.SuspendLayout();
            this.numericUpDown1.Location = new System.Drawing.Point(-10, -20);
            this.numericUpDown1.Minimum = -100;
            this.numericUpDown1.Name = "numericUpDown1";
            this.numericUpDown1.Size = new System.Drawing.Size(120, 23);
            this.numericUpDown1.TabIndex = 0;
            this.Controls.Add(this.numericUpDown1);
            this.ClientSize = new System.Drawing.Size(284, 161);
            this.Name = "NegForm";
            this.ResumeLayout(false);
        }
    }
}
`);
        const nud = await describeComponent(engine, negForm, 'numericUpDown1');
        if (!nud) throw new Error('negative literals: numericUpDown1 should describe');
        const propVal = (n: string) => nud.properties.find(p => p.name === n)?.value;
        // decimal — the one the int/double/long ladder silently dropped the sign on
        if (propVal('Minimum') !== '-100')
          throw new Error(`negative literals: Minimum must stay -100 (decimal), got ${propVal('Minimum')}`);
        // int — was already correct; pin it so the rewrite didn't cost anything
        if (propVal('Location') !== '-10, -20')
          throw new Error(`negative literals: Location must stay -10, -20 (int), got ${propVal('Location')}`);
        console.log('e2e: 1.0 negative-literal sign verified — a decimal Minimum = -100 describes as -100 (it silently became 100 when unary-minus only handled int/double/long) and int Point(-10, -20) is unchanged');
      } finally {
        try { fs.rmSync(negDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }

    // ---- 0.12.0 Modifiers / GenerateMember design-time pseudo-properties ----
    // Modifiers is the field-declaration access keyword, edited via a byte-local splice (safe on EVERY form — it never
    // touches InitializeComponent); GenerateMember (a field exists) is read-only (its toggle isn't round-trip-safe).
    // Verify describe surfaces both, Modifiers is an editable exclusive dropdown defaulting to the source value, and a
    // SetModifier edit changes ONLY the field declaration's keyword — one line, InitializeComponent untouched.
    {
      const modForm = path.join(repo, 'engine', 'samples', 'SampleForm.Designer.cs');
      const dc = await describeComponent(engine, modForm, 'okButton');
      if (!dc) throw new Error('Modifiers: okButton not described');
      const modProp = dc.properties.find((p) => p.name === 'Modifiers');
      const genProp = dc.properties.find((p) => p.name === 'GenerateMember');
      if (!modProp) throw new Error('Modifiers: pseudo-property missing from describe');
      if (modProp.readOnly) throw new Error('Modifiers: a single-declarator field must be editable');
      if (modProp.value !== 'Private') throw new Error(`Modifiers: okButton default should be "Private", got "${modProp.value}"`);
      if (!(modProp.standardValues || []).includes('Public') || !modProp.standardValuesExclusive)
        throw new Error('Modifiers: must be an exclusive dropdown including Public');
      // designTime flag drives the host's routing to setModifier (not the name) — real property named "Modifiers" is safe
      if (modProp.designTime !== true) throw new Error('Modifiers: pseudo-property must be tagged designTime (host routes on the flag, not the name)');
      if (!genProp || !genProp.readOnly || genProp.value !== 'true')
        throw new Error(`GenerateMember: expected read-only "true", got readOnly=${genProp?.readOnly} value=${genProp?.value}`);
      if (genProp.designTime !== true) throw new Error('GenerateMember: pseudo-property must be tagged designTime');
      // byte-local edit: private → public, ONLY okButton's field line changes; InitializeComponent untouched
      const src = fs.readFileSync(modForm, 'utf8');
      const em = await setModifier(engine, modForm, 'okButton', 'Public', src);
      if (!em.safe || em.text === null) throw new Error('Modifiers: setModifier(okButton, Public) refused: ' + em.reason);
      const beforeLines = src.split('\n'), afterLines = em.text.split('\n');
      if (beforeLines.length !== afterLines.length) throw new Error('Modifiers: edit changed the line count (not byte-local)');
      const diffIdx = beforeLines.map((l, i) => (l === afterLines[i] ? -1 : i)).filter((i) => i >= 0);
      if (diffIdx.length !== 1) throw new Error(`Modifiers: expected exactly 1 changed line, got ${diffIdx.length}`);
      if (!/\bpublic\s+System\.Windows\.Forms\.Button\s+okButton\s*;/.test(afterLines[diffIdx[0]]))
        throw new Error('Modifiers: the changed line must be okButton\'s public field declaration, got: ' + afterLines[diffIdx[0]]);
      if (em.text.indexOf('this.okButton = new System.Windows.Forms.Button()') < 0)
        throw new Error('Modifiers: InitializeComponent (okButton construction) must be untouched');
      const bad = await setModifier(engine, modForm, 'okButton', 'Bogus', src);
      if (bad.safe) throw new Error('Modifiers: an unknown modifier must be refused (fail-closed)');
      console.log('e2e: 0.12.0 Modifiers/GenerateMember verified — describe surfaces an editable exclusive Modifiers dropdown (default Private) + read-only GenerateMember; setModifier is byte-local (1 field line changes, InitializeComponent untouched); unknown modifier refused');
    }

    // ---- FlowLayoutPanel reorder ----
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

    // ---- DataGridView + BindingSource resilience (fragile fixtures golden) ----
    // DataGridView (Columns.AddRange + ISupportInitialize BeginInit/EndInit) and a tray BindingSource are
    // "fragile": full normalize-save can't round-trip them (BinaryFormatter/CodeDom limits) → safe=false. But the
    // INTERACTIVE path must work: the form renders, both columns + the binding source describe, the BindingSource
    // sits in the component tray, and a targeted property edit succeeds (the resilient path that skips full serialize).
    const gridForm = path.join(repo, 'engine', 'samples', 'GridForm.Designer.cs');
    if (fs.existsSync(gridForm)) {
      const gl = await renderWithLayout(engine, gridForm);
      if (!isPng(gl.png)) throw new Error('GridForm did not render');
      for (const n of ['dataGridView1', 'nameColumn', 'valueColumn', 'bindingSource1']) {
        if (!(await describeComponent(engine, gridForm, n))) throw new Error('GridForm: component dropped from describe: ' + n);
      }
      const glay = await describeLayout(engine, gridForm);
      const gtray = (glay as unknown as { tray?: Array<{ id: string }> }).tray || [];
      if (!gtray.some((t) => t.id === 'bindingSource1')) throw new Error('GridForm: bindingSource1 should be in the component tray, not the visual layout');
      const gdisk = fs.readFileSync(gridForm, 'utf8');
      const ge = await setProperty(engine, gridForm, 'refreshButton', 'Text', '"Reload"', gdisk);
      if (!ge.safe || ge.text === null) throw new Error('GridForm: a targeted edit must work even on a fragile form: ' + ge.reason);
      const gser = await serializeDesigner(engine, gridForm);
      // T2.1: BeginInit/EndInit (ISupportInitialize scaffolding) are now representable no-ops → they must NOT be
      // in the unrepresentable set. GridForm still degrades to read-only, but ONLY for the .NET-9 BinaryFormatter
      // limit (DataGridView resource serialization), not the init bracketing that used to block it.
      if (gser.unrepresentable.some((u) => /BeginInit|EndInit|ISupportInitialize/.test(u))) throw new Error('T2.1: BeginInit/EndInit must be representable now; unrep: ' + gser.unrepresentable.join('; '));
      if (gser.safe !== false || !gser.unrepresentable.some((u) => /binary serialized resources|PlatformNotSupported/i.test(u))) throw new Error('T2.1: GridForm should degrade only for the .NET-9 BinaryFormatter limit; unrep: ' + gser.unrepresentable.join('; '));
      console.log(`e2e: fragile fixtures verified — GridForm renders (${gl.png.length}B), DataGridView columns + tray BindingSource described, targeted edit works, BeginInit/EndInit now representable, full-serialize degrades only for BinaryFormatter (safe=${gser.safe})`);
    } else {
      console.log('e2e: fragile fixtures SKIPPED — engine/samples/GridForm.Designer.cs missing');
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

      // ---- T2.1 round-trip: a form with event wirings (+=) is now FULLY round-trip safe ----
      // The interpreter captures each `this.X.Event += new Handler(this.method)` verbatim (representable) and the
      // serializer re-emits it, so no user wiring is silently dropped — the safe-save gate passes. Previously the `+=`
      // hit HandleAssignment (no property "Click") → unrepresentable → read-only.
      const evSer = await serializeDesigner(engine, eventForm);
      if (evSer.safe !== true) throw new Error('T2.1: EventForm (+= wirings) should be round-trip safe; unrep: ' + evSer.unrepresentable.join('; '));
      if (evSer.code == null
        || !/this\.okButton\.Click \+= new System\.EventHandler\(this\.okButton_Click\);/.test(evSer.code)
        || !/this\.okButton\.MouseEnter \+= new System\.EventHandler\(this\.okButton_MouseEnter\);/.test(evSer.code)
        || !/this\.Load \+= new System\.EventHandler\(this\.EventForm_Load\);/.test(evSer.code)) {
        throw new Error('T2.1: EventForm round-trip must re-emit all three wirings verbatim');
      }
      console.log('e2e: T2.1 event-wiring round-trip verified — EventForm (+= Click/MouseEnter/Load) fully round-trip safe, all wirings re-emitted verbatim');

      // ---- create event handler (VS-style): wire an UNWIRED event + generate a signature-matching stub ----
      // Drive GenerateEventHandler against the unsaved buffers. okButton.MouseDown is unwired and uses a
      // NON-trivial delegate (MouseEventHandler) — proves the stub signature comes from delegate reflection,
      // not a hardcoded (object,EventArgs). The safe-save gate must add EXACTLY one wiring statement, nothing else.
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
      if (after !== before + 1) throw new Error(`GenerateEventHandler: wiring count ${before}→${after} (expected +1)`);
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

      // safe-save gate: a non-identifier handler name (code-injection attempt) must be REJECTED, never interpolated.
      const inj = await generateEventHandler(engine, eventForm, 'okButton', 'MouseLeave', 'evil){}static void Pwn(){', dText, cText, null);
      if (inj.safe || inj.designerText != null || inj.codeText != null) throw new Error('GenerateEventHandler MUST reject a non-identifier handler name (injection): safe=' + inj.safe);
      console.log(`e2e: create-event-handler verified — okButton.MouseDown wired + typed stub generated (safe-save gate: +1 wiring only), wired form renders (${wiredPng.png.length}B), already-wired Click → no change, injection handler name rejected`);

      // ---- events dropdown: compatible-handler candidates + wire/rewire/unwire ----
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

      // 1.0 — EXISTING is not COMPATIBLE. The write path checked only that a method of that name exists, so a
      // wrong-signature method could be wired: `Click += new EventHandler(this.WrongClick)` where WrongClick takes a
      // string is not a valid method group, and the project stops compiling. The dropdown filters by signature; this
      // path is reachable from the panel with any value, so it must apply the same rule rather than trust the UI.
      const withWrong = cText.replace(
        'private void okButton_Click(object sender, EventArgs e)',
        'private void WrongSig(string text) { }\n\n        private void okButton_Click(object sender, EventArgs e)');
      if (withWrong === cText) throw new Error('events: fixture setup — could not inject WrongSig into the code-behind');
      const incompat = await setEventWiring(engine, eventForm, 'okButton', 'MouseLeave', 'WrongSig', dText, withWrong, null);
      if (incompat.safe)
        throw new Error('SetEventWiring must refuse a handler whose SIGNATURE does not match the event — wiring it emits an invalid method group and breaks the build');
      // …and a compatible one still wires from the same code-behind (the guard is not just "refuse everything")
      const stillOk = await setEventWiring(engine, eventForm, 'okButton', 'MouseLeave', 'okButton_Click', dText, withWrong, null);
      if (!stillOk.safe) throw new Error('SetEventWiring: a correctly-typed handler must still wire; got ' + stillOk.reason);

      console.log(`e2e: events dropdown verified — candidates by precise signature (Click→${cands['Click'].length}, MouseDown→none), rewire/unwire/wire-to-existing safe, missing method rejected, wrong-signature handler rejected`);
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

    // ---- T2.1 component-reference property RHS (this.<prop> = this.<component>) — round-trip safe ----
    // ComponentRefForm points AcceptButton/CancelButton at Button components (the reference VS emits for a
    // dialog). The interpreter now assigns the live component instance (Eval can't — it has no `comps`) and the
    // serializer re-emits the reference, so the form fully round-trips; it also renders (the reference applies).
    const compRefForm = path.join(repo, 'engine', 'samples', 'ComponentRefForm.Designer.cs');
    if (fs.existsSync(compRefForm)) {
      const crSer = await serializeDesigner(engine, compRefForm);
      if (crSer.safe !== true) throw new Error('T2.1: ComponentRefForm (component-ref RHS) should be round-trip safe; unrep: ' + crSer.unrepresentable.join('; '));
      if (crSer.code == null || !/this\.AcceptButton = this\.okButton;/.test(crSer.code) || !/this\.CancelButton = this\.cancelButton;/.test(crSer.code)) {
        throw new Error('T2.1: ComponentRefForm round-trip must re-emit the AcceptButton/CancelButton component refs');
      }
      const crPng = await renderDesigner(engine, compRefForm);
      if (!isPng(crPng)) throw new Error('T2.1: ComponentRefForm should render to a valid PNG');
      console.log(`e2e: T2.1 component-ref round-trip verified — ComponentRefForm AcceptButton/CancelButton round-trip safe + re-emitted, renders (${crPng.length}B)`);

      // ---- component-reference DROPDOWN (net9 describe self-enumerates the container's compatible siblings) ----
      // The converter can only list references with a design container; the engine self-enumerates the sited
      // components instead → AcceptButton/CancelButton offer "(none)"+the compatible Button field names, pre-selecting
      // the current one. The picked value is written as `this.<name>` / `null` (refEdit) — proven here by splicing the
      // reference expr the host would send. (The component-ref case — a control's ContextMenuStrip → a tray component —
      // is covered by the ContextMenuForm leg, which exercises the FieldNames reverse-scan resolve.)
      const crRoot = await describeComponent(engine, compRefForm, 'this');
      const acc9 = crRoot?.properties?.find((p) => p.name === 'AcceptButton');
      const acc9Vals = acc9?.standardValues ?? [];
      if (!(acc9Vals.includes('(none)') && acc9Vals.includes('okButton') && acc9Vals.includes('cancelButton')))
        throw new Error(`T2.1: net9 AcceptButton dropdown must be [(none), cancelButton, okButton] — got [${acc9Vals.join(', ')}]`);
      if (acc9?.referenceValues !== true || acc9?.standardValuesExclusive !== true) throw new Error('T2.1: net9 AcceptButton must be an exclusive referenceValues dropdown');
      if (acc9?.value !== 'okButton') throw new Error(`T2.1: net9 AcceptButton must pre-select "okButton" — got ${JSON.stringify(acc9?.value)}`);
      // the reference expr the host splices for a pick (this.<name>) / a clear (null) must round-trip minimally + safely
      const pick = await setProperty(engine, compRefForm, 'this', 'AcceptButton', 'this.cancelButton');
      if (!pick.safe || !/this\.AcceptButton = this\.cancelButton;/.test(pick.text ?? '')) throw new Error(`T2.1: picking AcceptButton=cancelButton must splice "this.AcceptButton = this.cancelButton" (safe) — mode ${pick.mode}, reason ${pick.reason ?? ''}`);
      const clr = await setProperty(engine, compRefForm, 'this', 'AcceptButton', 'null');
      if (!clr.safe || !/this\.AcceptButton = null;/.test(clr.text ?? '')) throw new Error(`T2.1: clearing AcceptButton must splice "this.AcceptButton = null" (safe) — mode ${clr.mode}, reason ${clr.reason ?? ''}`);
      console.log(`e2e: component-ref dropdown (net9) verified — AcceptButton/CancelButton [(none), cancelButton, okButton] pre-selecting "okButton"; pick splices this.<name>, clear splices null`);
    } else {
      console.log('e2e: T2.1 component-ref SKIPPED — engine/samples/ComponentRefForm.Designer.cs missing');
    }

    // ---- component-reference dropdown on a TRAY-COMPONENT owner (net9) ----
    // notifyIcon1.ContextMenuStrip points at a ContextMenuStrip sibling — a reference whose OWNER is a non-Control
    // tray Component. The describe gate now excludes only ToolStripItems (not "non-Control"), so a tray component's
    // reference prop self-enumerates the compatible ContextMenuStrip field names into an exclusive dropdown, exactly
    // like a control owner. The refEdit splice (`this.notifyIcon1.ContextMenuStrip = this.contextMenuStrip1` / `null`)
    // is the same control-channel write — a tray edit carries refEdit (no ownerId), so no host change is needed.
    const notifyIconForm = path.join(repo, 'engine', 'samples', 'NotifyIconForm.Designer.cs');
    if (fs.existsSync(notifyIconForm)) {
      const niPng = await renderDesigner(engine, notifyIconForm);
      if (!isPng(niPng)) throw new Error('tray-ref (net9): NotifyIconForm should render to a valid PNG');
      const ni = await describeComponent(engine, notifyIconForm, 'notifyIcon1');
      if (!ni) throw new Error('tray-ref (net9): notifyIcon1 (a tray Component) failed to describe');
      const cms = ni.properties?.find((p) => p.name === 'ContextMenuStrip');
      const cmsVals = cms?.standardValues ?? [];
      if (!(cmsVals.includes('(none)') && cmsVals.includes('contextMenuStrip1')))
        throw new Error(`tray-ref (net9): notifyIcon1.ContextMenuStrip dropdown must be [(none), contextMenuStrip1] — got [${cmsVals.join(', ')}]`);
      if (cms?.referenceValues !== true || cms?.standardValuesExclusive !== true) throw new Error('tray-ref (net9): notifyIcon1.ContextMenuStrip must be an exclusive referenceValues dropdown on a tray owner');
      if (cms?.value !== 'contextMenuStrip1') throw new Error(`tray-ref (net9): notifyIcon1.ContextMenuStrip must pre-select "contextMenuStrip1" — got ${JSON.stringify(cms?.value)}`);
      // the refEdit splice for a tray owner: pick writes `this.notifyIcon1.ContextMenuStrip = this.<name>`, clear writes null
      const niPick = await setProperty(engine, notifyIconForm, 'notifyIcon1', 'ContextMenuStrip', 'this.contextMenuStrip1');
      if (!niPick.safe || !/this\.notifyIcon1\.ContextMenuStrip = this\.contextMenuStrip1;/.test(niPick.text ?? '')) throw new Error(`tray-ref (net9): picking notifyIcon1.ContextMenuStrip=contextMenuStrip1 must splice the tray-owner reference (safe) — mode ${niPick.mode}, reason ${niPick.reason ?? ''}`);
      const niClr = await setProperty(engine, notifyIconForm, 'notifyIcon1', 'ContextMenuStrip', 'null');
      if (!niClr.safe || !/this\.notifyIcon1\.ContextMenuStrip = null;/.test(niClr.text ?? '')) throw new Error(`tray-ref (net9): clearing notifyIcon1.ContextMenuStrip must splice null (safe) — mode ${niClr.mode}, reason ${niClr.reason ?? ''}`);
      // a NON-reference tray property (Text) must NOT become a reference dropdown — the widening is reference-scoped
      const niText = ni.properties?.find((p) => p.name === 'Text');
      if (niText?.referenceValues) throw new Error('tray-ref (net9): a non-reference tray property (Text) must NOT carry referenceValues');
      // a tray-component reference to the ROOT form (errorProvider1.ContainerControl = this): the form is assignable to
      // ContainerControl, so describe offers the synthetic "(this)" token — an exclusive [(none), (this)] dropdown
      // pre-selecting "(this)". The pick splices a BARE `this` (not `this.(this)`); the clear splices null. (The net9
      // interpreter now binds `= this` to the root so the value reads back as the root form; ErrorProvider still forces a
      // binary-resource serialize on .NET 9, so the form stays read-only-fallback — making `= this` representable cannot
      // unblock a save, hence no data-loss surface.)
      const ep = await describeComponent(engine, notifyIconForm, 'errorProvider1');
      const cc = ep?.properties?.find((p) => p.name === 'ContainerControl');
      const ccVals = cc?.standardValues ?? [];
      if (cc?.referenceValues !== true || cc?.standardValuesExclusive !== true) throw new Error('tray-ref (net9): errorProvider1.ContainerControl (a ROOT reference to an assignable form) must be an exclusive referenceValues dropdown');
      if (!(ccVals.length === 2 && ccVals.includes('(none)') && ccVals.includes('(this)'))) throw new Error(`tray-ref (net9): errorProvider1.ContainerControl dropdown must be [(none), (this)] — got [${ccVals.join(', ')}]`);
      if (cc?.value !== '(this)') throw new Error(`tray-ref (net9): errorProvider1.ContainerControl must pre-select "(this)" (the current value is the root form) — got ${JSON.stringify(cc?.value)}`);
      // the refEdit splice for a ROOT pick writes a BARE `this`; the clear writes null
      const ccRoot = await setProperty(engine, notifyIconForm, 'errorProvider1', 'ContainerControl', 'this');
      if (!ccRoot.safe || !/this\.errorProvider1\.ContainerControl = this;/.test(ccRoot.text ?? '')) throw new Error(`tray-ref (net9): picking errorProvider1.ContainerControl=(this) must splice the bare root reference "= this" (safe) — mode ${ccRoot.mode}, reason ${ccRoot.reason ?? ''}`);
      const ccClr = await setProperty(engine, notifyIconForm, 'errorProvider1', 'ContainerControl', 'null');
      if (!ccClr.safe || !/this\.errorProvider1\.ContainerControl = null;/.test(ccClr.text ?? '')) throw new Error(`tray-ref (net9): clearing errorProvider1.ContainerControl must splice null (safe) — mode ${ccClr.mode}, reason ${ccClr.reason ?? ''}`);
      // the root form is NOT an IButtonControl, so its OWN AcceptButton must NOT offer "(this)" (rootAssignable=false;
      // and a component never references itself) — proves the root token is gated on assignability, not offered blanket
      const rootDesc = await describeComponent(engine, notifyIconForm, 'this');
      const acceptBtn = rootDesc?.properties?.find((p) => p.name === 'AcceptButton');
      if ((acceptBtn?.standardValues ?? []).includes('(this)')) throw new Error('tray-ref (net9): the form\'s own AcceptButton (IButtonControl, root not assignable) must NOT offer the "(this)" token');
      console.log(`e2e: tray-component reference dropdown (net9) verified — notifyIcon1.ContextMenuStrip [(none), contextMenuStrip1] pre-selecting "contextMenuStrip1"; a ROOT reference (errorProvider1.ContainerControl) is an editable [(none), (this)] dropdown pre-selecting "(this)", pick splices bare "= this" / clear splices null; a non-assignable root prop (AcceptButton) does not offer "(this)"`);
    } else {
      console.log('e2e: tray-ref (net9) SKIPPED — engine/samples/NotifyIconForm.Designer.cs missing');
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
      // component tray: the non-visual ToolTip provider appears in the tray, not the visual layout
      const exLayout = await describeLayout(engine, extenderForm);
      if (!exLayout.tray.some((t) => t.id === 'toolTip1')) {
        throw new Error('tray: toolTip1 should be in the component tray: ' + JSON.stringify(exLayout.tray));
      }
      if (exLayout.controls.some((c) => c.id === 'toolTip1')) throw new Error('a non-visual component must NOT be in the visual layout');
      const es = await serializeDesigner(engine, extenderForm);
      if (es.safe !== false) throw new Error('extender serialize should degrade to read-only on .NET 9 (BinaryFormatter)');
      // delete-tray: RemoveControl removes a NON-visual tray component (its field + ctor + SetToolTip wiring),
      // and the control it provided a tooltip for (helpButton) survives — the engine side of "delete from the tray".
      const exDisk = fs.readFileSync(extenderForm, 'utf8');
      const rmTray = await removeControl(engine, extenderForm, 'toolTip1', exDisk);
      if (!rmTray.safe || rmTray.newText == null) throw new Error('delete-tray: RemoveControl(toolTip1) rejected: ' + rmTray.reason);
      if (/\btoolTip1\b/.test(rmTray.newText)) throw new Error('delete-tray: toolTip1 field/statements/wiring not fully removed');
      if (!/\bhelpButton\b/.test(rmTray.newText)) throw new Error('delete-tray: the provided-to control (helpButton) must survive');
      const trayGone = await describeLayout(engine, extenderForm, undefined, rmTray.newText);
      if (trayGone.tray.some((t) => t.id === 'toolTip1')) throw new Error('delete-tray: toolTip1 still in tray after removal');
      if (!trayGone.controls.some((c) => c.id === 'helpButton')) throw new Error('delete-tray: helpButton missing after tray removal');
      console.log(`e2e: extender providers verified — ToolTip/SetToolTip interpreted & rendered (${ep.length}B), in tray, serialize degrades read-only; delete-tray removes toolTip1 (helpButton survives)`);
    } else {
      console.log('e2e: extender providers SKIPPED — engine/samples/ExtenderForm.Designer.cs missing');
    }
    // safe-save gate: the extender ctor relaxation is gated to `new T(this.<components>)` ONLY — a non-container
    // ctor arg is still a hand-edit → unrepresentable (must not silently create + drop state).
    {
      const src6 = fs.readFileSync(designer, 'utf8');
      const hostile = src6.replace('this.okButton = new System.Windows.Forms.Button();', 'this.okButton = new System.Windows.Forms.Button(this.nameTextBox);');
      if (hostile === src6) throw new Error('safe-save gate fixture: okButton ctor anchor not found');
      const tmpH = path.join(os.tmpdir(), `wfd-e2e-ctorarg-${process.pid}.Designer.cs`);
      fs.writeFileSync(tmpH, hostile, 'utf8');
      try {
        const hs = await serializeDesigner(engine, tmpH);
        if (hs.safe !== false) throw new Error('safe-save gate: a non-container ctor arg must NOT be round-trip safe');
        if (!hs.unrepresentable.some((u) => u.includes('ctor args'))) throw new Error('safe-save gate: ctor-arg hand-edit should be flagged unrepresentable; got: ' + hs.unrepresentable.join('; '));
        console.log('e2e: safe-save gate preserved — a non-container ctor arg is still flagged unrepresentable (extender relaxation is narrow)');
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

    // ---- toolbox auto-population — reflect framework controls, grouped by VS category ----
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
      // toolbox icons: each framework control carries its own [ToolboxBitmap] as a base64 PNG, and the
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
      console.log(`e2e: toolbox auto-population verified — ${items.length} controls in ${new Set(items.map((i) => i.category)).size} categories; TreeView add+render (no explicit Size) & SplitContainer materializes (not Container-swallowed)`);
    }

    // ---- toolbox non-visual components/dialogs + AddComponent ----
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
      // safe-save gate / robustness: a non-allowlisted type and an unknown parent are rejected
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
      // net48-preview hints: the clone's type + nudged Location (150,204 → 158,212) so the compiled host can live-add it
      if (ps.typeName !== 'System.Windows.Forms.Button') throw new Error('PasteControl did not surface the clone type for net48 live-add: ' + ps.typeName);
      if (ps.x !== 158 || ps.y !== 212) throw new Error(`PasteControl did not surface the nudged Location for net48 live-add: (${ps.x},${ps.y})`);
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
      // net48-preview hint: a clip with no representable integer Location yields (-1,-1) → net48 AddControl leaves the default position
      if (litPaste.typeName !== 'System.Windows.Forms.Button') throw new Error('PasteControl did not surface the clone type for a Location-less clip: ' + litPaste.typeName);
      if (litPaste.x !== -1 || litPaste.y !== -1) throw new Error(`PasteControl should report (-1,-1) for a clip without an integer Location: (${litPaste.x},${litPaste.y})`);
      console.log(`e2e: copy/paste verified — clone (${ps.name}) renames+offsets & renders (+1); original survives; refuse root/container/bad-clip; paste into a container parents; net48 live-add hints (type=${ps.typeName}, loc ${ps.x},${ps.y}; Location-less clip → -1,-1); SECURITY: reject Fqn-injection, non-designer call, sibling-ref; AST rename preserves string literals; disk untouched`);
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

    // ---- reparent: move a leaf control into a different container / back to the root ----
    {
      const rpDisk = fs.readFileSync(designer, 'utf8'); // SampleForm: okButton (root leaf), optionsGroup (container of optionA/optionB)
      const rp1 = await reparentControl(engine, designer, 'okButton', 'optionsGroup', rpDisk);
      if (!rp1.safe || rp1.newText == null) throw new Error('reparent(okButton → optionsGroup) rejected: ' + rp1.reason);
      if (!/this\.optionsGroup\.Controls\.Add\(this\.okButton\)/.test(rp1.newText)) throw new Error('reparent: okButton not re-parented into optionsGroup');
      if (/this\.Controls\.Add\(this\.okButton\)/.test(rp1.newText)) throw new Error('reparent: the old root Controls.Add(okButton) must be gone');
      const rpLay = await describeLayout(engine, designer, undefined, rp1.newText);
      const okc = rpLay.controls.find((c) => c.id === 'okButton');
      if (!okc || okc.parentId !== 'optionsGroup') throw new Error(`reparent: okButton.parentId should reflow to optionsGroup, got ${okc?.parentId}`);
      // reverse the move (→ root) and confirm it reproduces the original file byte-for-byte (receiver-only edit).
      const rp2 = await reparentControl(engine, designer, 'okButton', 'this', rp1.newText);
      if (!rp2.safe || rp2.newText == null) throw new Error('reparent(okButton → root) rejected: ' + rp2.reason);
      if (rp2.newText !== rpDisk) throw new Error('reparent there-and-back should reproduce the original bytes');
      // safe-save gate refusals: the root, a self-parent, an unknown parent.
      if ((await reparentControl(engine, designer, 'this', 'optionsGroup', rpDisk)).safe) throw new Error('reparent must refuse the root form');
      if ((await reparentControl(engine, designer, 'okButton', 'okButton', rpDisk)).safe) throw new Error('reparent must refuse a self-parent');
      if ((await reparentControl(engine, designer, 'okButton', 'noSuchParent', rpDisk)).safe) throw new Error('reparent must refuse an unknown parent');
      // container-with-children (leaf-only): reparenting optionsGroup (holds optionA/optionB) even to the root is
      // refused by the leaf check (root skips the target-type check, so this exercises leaf-only directly).
      if ((await reparentControl(engine, designer, 'optionsGroup', 'this', rpDisk)).safe) throw new Error('reparent must refuse a container with children (leaf-only)');
      // The target must be a container that accepts a DIRECT child: a leaf Control (CheckBox) is refused.
      if ((await reparentControl(engine, designer, 'okButton', 'agreeCheck', rpDisk)).safe) throw new Error('reparent must refuse a non-container target (agreeCheck is a CheckBox)');
      if (fs.readFileSync(designer, 'utf8') !== rpDisk) throw new Error('reparent must not touch disk (buffer path)');
      // Reparenting into a NON-Control tray field (ToolTip) is refused: it would emit
      // non-compiling `toolTip1.Controls.Add(...)`.
      const extForm = path.join(repo, 'engine', 'samples', 'ExtenderForm.Designer.cs');
      if (fs.existsSync(extForm)) {
        const extDisk2 = fs.readFileSync(extForm, 'utf8');
        if ((await reparentControl(engine, extForm, 'helpButton', 'toolTip1', extDisk2)).safe) throw new Error('reparent must refuse a non-Control (tray component) target — would not compile');
      }
      // Cycle-safety — a TableLayoutPanel's 3-arg cell children still make it a container, so
      // reparenting it (even to root) is refused by the robust leaf check.
      if (fs.existsSync(tlpForm)) {
        const tlpDisk2 = fs.readFileSync(tlpForm, 'utf8');
        if ((await reparentControl(engine, tlpForm, 'tableLayoutPanel1', 'this', tlpDisk2)).safe) throw new Error('reparent must refuse a TableLayoutPanel with 3-arg cell children (leaf-only/cycle-safe)');
      }
      console.log('e2e: reparent verified — okButton → optionsGroup (parentId reflows) and back to root (byte-identical); refuses root/self/unknown/container-with-children/non-container target/non-Control tray target/TLP-cells; disk untouched');
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
    // ComplexProject is multi-target (net8/net9/net10-windows) with a <BaseOutputPath>build-out\</BaseOutputPath>
    // that redirects output OUT of bin/. The lightweight bin-search cannot find it (no bin/ dir); only the
    // MSBuild eval + TFM selection resolve it. Asserts ResolveAssembly returns the build-out net9 dll and
    // that the fixture invariant (no bin/) holds, so TFM-selection + custom-OutputPath has a regression test.
    const complexFixture = path.join(repo, 'samples', 'ComplexProject', 'MainForm.Designer.cs');
    const complexDll = path.join(repo, 'samples', 'ComplexProject', 'build-out', 'Debug', 'net10.0-windows', 'ComplexProject.dll');
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
      console.log('e2e: MSBuild resolver SKIPPED — build samples/ComplexProject (-f net10.0-windows -c Debug -p:TargetFrameworks=net10.0-windows) to exercise it');
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
