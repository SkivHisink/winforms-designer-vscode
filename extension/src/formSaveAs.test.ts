import { describe, expect, it } from 'vitest';
import { renameSavedFormType, saveAsTypeName, verifySaveAsSourceSnapshot } from './formSaveAs';

describe('bounded Save As form type copy', () => {
  it('rejects a delayed companion read when a resource-only edit advances the document revision', async () => {
    let revision = 3;
    const images = new Map([['Form1.Designer.cs', Buffer.from('image wiring')], ['Form1.resx', Buffer.from('image bytes')]]);
    const valid = await verifySaveAsSourceSnapshot(3, () => revision, images, async (target) => {
      await Promise.resolve();
      if (target === 'Form1.resx') revision++;
      return images.get(target)!;
    });
    expect(valid).toBe(false);
  });

  it('rejects an external companion byte change without a designer revision change', async () => {
    const images = new Map([['Form1.resx', Buffer.from('old image')]]);
    expect(await verifySaveAsSourceSnapshot(3, () => 3, images, async () => Buffer.from('new image'))).toBe(false);
  });
  it('renames only the declared form, constructors and direct self-type expressions', () => {
    const before = `namespace App.Forms { public partial class Form1 : Form {
  // Form1 remains a comment
  public Form1() { Text = "Form1"; var resource = new ResourceManager(typeof(Form1)); }
  static Form1() { } ~Form1() { } void Copy() { var next = new Form1(); }
} }`;
    const result = renameSavedFormType(before, 'Form1', 'FormCopy');
    expect(result).toContain('namespace App.Forms');
    expect(result).toContain('partial class FormCopy');
    expect(result).toContain('public FormCopy()');
    expect(result).toContain('typeof(FormCopy)');
    expect(result).toContain('new FormCopy()');
    expect(result).toContain('// Form1 remains a comment');
    expect(result).toContain('Text = "Form1"');
  });

  it('derives the declaration from code rather than a comment or string', () => {
    expect(saveAsTypeName('// partial class Decoy\nnamespace App { partial class Form1 {} }', 'Copy'))
      .toEqual({ sourceType: 'Form1', destinationType: 'Copy' });
  });

  it.each(['class', '3Form', 'Form-2'])('refuses unsupported destination type %s', (destination) => {
    expect(() => saveAsTypeName('partial class Form1 {}', destination)).toThrow('SAVE_AS_UNSUPPORTED_FORM_TYPE');
  });

  it.each([
    'partial class Form1 { Form1 field; }',
    'partial class Form1 { void M() { var t = typeof(App.Form1); } }',
    'partial class Form1 { string text = $"{typeof(Form1)}"; }',
    'partial class Form1 { string text = $@"line\n{typeof(Form1)}"; }',
    'partial class Form1 { string text = $$"""line\n{{typeof(Form1)}}\n"""; }',
    'namespace A { partial class Form1 {} } namespace B { class Form1 {} }',
    'namespace A { partial class Form1 {} class Helper {} }',
  ])('refuses self-type uses requiring semantic binding: %s', (source) => {
    expect(() => renameSavedFormType(source, 'Form1', 'Copy')).toThrow('SAVE_AS_SEMANTIC_RENAME_REQUIRED');
  });

  it('preserves byte-relevant text and line endings outside the allowed identifiers', () => {
    const source = 'namespace App\r\n{\r\n    partial class Form1 { string label = @"Form1"; }\r\n}\r\n';
    expect(renameSavedFormType(source, 'Form1', 'Copy')).toBe(source.replace('class Form1', 'class Copy'));
  });
});
