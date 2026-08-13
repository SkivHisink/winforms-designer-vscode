import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { formSiblingsToDelete } from './formSiblings';

const DIR = path.join('C:', 'src', 'App', 'Forms');
const p = (name: string): string => path.join(DIR, name);

describe('formSiblingsToDelete', () => {
  const listing = [
    'Form1.cs', 'Form1.Designer.cs', 'Form1.resx', 'Form1.ru.resx', 'Form1.fr-FR.resx',
    'Form2.cs', 'Form2.Designer.cs', 'Form2.resx',
    'Helper.cs', 'Form1.Backup.resx', 'Form10.cs', 'Form10.resx',
  ];

  it('takes the generated half and every resource of the deleted form', () => {
    expect(formSiblingsToDelete(p('Form1.cs'), listing).sort()).toEqual(
      [p('Form1.Designer.cs'), p('Form1.resx'), p('Form1.fr-FR.resx'), p('Form1.ru.resx')].sort(),
    );
  });

  it('touches nothing that belongs to another form', () => {
    const result = formSiblingsToDelete(p('Form1.cs'), listing);
    expect(result.some((f) => path.basename(f).startsWith('Form2'))).toBe(false);
    // `Form10` shares the `Form1` prefix but is a different form — a prefix match would delete its resources.
    expect(result.some((f) => path.basename(f).startsWith('Form10'))).toBe(false);
  });

  it('leaves a non-culture resource alone — the designer did not create it', () => {
    expect(formSiblingsToDelete(p('Form1.cs'), listing)).not.toContain(p('Form1.Backup.resx'));
  });

  it('is a no-op for files that are not a form of ours', () => {
    expect(formSiblingsToDelete(p('Form1.Designer.cs'), listing)).toEqual([]); // deleting the generated half alone
    expect(formSiblingsToDelete(p('Form1.resx'), listing)).toEqual([]);
    expect(formSiblingsToDelete(p('Helper.txt'), listing)).toEqual([]);
    expect(formSiblingsToDelete(p('Helper.cs'), listing)).toEqual([]); // a plain class: nothing nested under it
  });

  it('never returns a file the same delete already covers', () => {
    const multiSelect = [p('Form1.cs'), p('Form1.resx')];
    const result = formSiblingsToDelete(p('Form1.cs'), listing, multiSelect);
    expect(result).not.toContain(p('Form1.resx'));
    expect(result).toContain(p('Form1.Designer.cs'));
  });

  it('matches file names case-insensitively, as Windows does', () => {
    const shouty = ['FORM1.CS', 'Form1.DESIGNER.CS', 'FORM1.ResX'];
    expect(formSiblingsToDelete(p('FORM1.CS'), shouty).sort())
      .toEqual([p('FORM1.ResX'), p('Form1.DESIGNER.CS')].sort());
  });

  it('accepts the culture shapes the localization feature writes', () => {
    const cultures = ['F.cs', 'F.Designer.cs', 'F.ru.resx', 'F.fr-FR.resx', 'F.ar-SA.resx', 'F.zh-Hans-CN.resx'];
    expect(formSiblingsToDelete(p('F.cs'), cultures)).toHaveLength(5);
  });
});
