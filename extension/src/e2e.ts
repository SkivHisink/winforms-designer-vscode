import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { startEngine, ping, renderDesigner, renderControl, renderWithLayout, describeComponent, describeLayout, serializeDesigner, setProperty, convertValue, resolveAssembly, generateEventHandler, listHandlerCandidates, setEventWiring, addControl, listControlTypes, listToolboxItems, removeControl, copyControl, pasteControl, moveZOrder } from './engineClient';

const isPng = (b: Buffer): boolean =>
  b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

/**
 * Headless end-to-end proof of the extension's engine-client side (no VS Code GUI):
 * spawn the engine in --pipe mode, Ping it, render the sample .Designer.cs, write PNG,
 * then prove the live-update path: a content change yields a different render. The final
 * check inside the actual VS Code Extension Host (F5) is left to the user.
 */
async function main(): Promise<void> {
  const repo = path.resolve(__dirname, '..', '..');
  const dll = path.join(repo, 'engine', 'bin', 'Release', 'net9.0-windows', 'WinFormsDesigner.Engine.dll');
  const designer = path.join(repo, 'engine', 'samples', 'SampleForm.Designer.cs');
  const outPng = path.resolve(__dirname, '..', 'e2e-render.png');

  if (!fs.existsSync(dll)) throw new Error('engine dll not found: ' + dll);
  if (!fs.existsSync(designer)) throw new Error('sample not found: ' + designer);

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
      console.log(`e2e: layout hit-test map verified — okButton rect == patch (${lOk.x},${lOk.y},${lOk.width},${lOk.height}); root full-frame & last; center→okButton, corner→form`);

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
            a.parentId !== b.parentId || a.depth !== b.depth || a.isRoot !== b.isRoot) {
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
      console.log(`e2e: extender providers verified — ToolTip/SetToolTip interpreted & rendered (${ep.length}B), in tray (§7.3), serialize degrades read-only`);
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
