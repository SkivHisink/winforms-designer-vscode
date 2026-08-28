import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, expect, test } from 'vitest';
import { fileHasInlineInitializeComponent, mergeInlineEventEdits, sourceHasInlineInitializeComponent } from './inlineDesigner';

const files: string[] = [];
afterEach(() => {
  for (const file of files.splice(0)) fs.rmSync(file, { force: true });
});

test('recognizes a real inline WinForms InitializeComponent and ignores comments/strings', () => {
  expect(sourceHasInlineInitializeComponent(`
    partial class InlineForm : System.Windows.Forms.Form {
      private void InitializeComponent() { this.Text = "Inline"; }
    }`, true)).toBe(true);
  expect(sourceHasInlineInitializeComponent(`
    partial class Ordinary : object {
      string sample = "void InitializeComponent() { }";
      // void InitializeComponent() { }
    }`, false)).toBe(false);
});

test('manual detection accepts a custom base while conservative auto detection requires a known WinForms base', () => {
  const file = path.join(os.tmpdir(), `wfd-inline-${process.pid}-${Date.now()}.cs`);
  files.push(file);
  fs.writeFileSync(file, 'partial class CustomerForm : ProductBaseForm { private void InitializeComponent() { } }');
  expect(fileHasInlineInitializeComponent(file, false)).toBe(true);
  expect(fileHasInlineInitializeComponent(file, true)).toBe(false);
});

test('merges the separate wiring and handler insertions in one inline document', () => {
  const source = 'class F { void InitializeComponent() { }\n}\n';
  const wiringAt = source.indexOf(' }\n}');
  const wired = source.slice(0, wiringAt) + '\n  this.Click += this.OnClick;' + source.slice(wiringAt);
  const handlerAt = source.lastIndexOf('}\n');
  const handler = '  void OnClick(object sender, System.EventArgs e) { }\n';
  const code = source.slice(0, handlerAt) + handler + source.slice(handlerAt);
  const merged = mergeInlineEventEdits(source, wired, handlerAt, handler, code);
  expect(merged).toContain('this.Click += this.OnClick;');
  expect(merged).toContain('void OnClick(object sender, System.EventArgs e)');
});

test('refuses an inline event merge when either engine edit is not an exact insertion', () => {
  expect(mergeInlineEventEdits('abc', 'axc', 3, '!', 'abc!')).toBeNull();
  expect(mergeInlineEventEdits('abc', 'ab+c', 3, '!', 'stale')).toBeNull();
});
