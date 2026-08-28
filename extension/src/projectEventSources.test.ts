import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test } from 'vitest';
import { collectProjectEventSourcePaths } from './projectEventSources';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('collectProjectEventSourcePaths', () => {
  test('finds project-wide partials, keeps the primary first, and excludes generated/build trees', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-event-sources-'));
    roots.push(root);
    const project = path.join(root, 'App.csproj');
    const primary = path.join(root, 'Form1.cs');
    fs.writeFileSync(project, '<Project Sdk="Microsoft.NET.Sdk" />');
    fs.writeFileSync(primary, 'partial class Form1 { }');
    fs.mkdirSync(path.join(root, 'Features'));
    fs.writeFileSync(path.join(root, 'Features', 'Form1.Events.cs'), 'partial class Form1 { void Save_Click() {} }');
    fs.writeFileSync(path.join(root, 'Form1.Designer.cs'), 'partial class Form1 { void InitializeComponent() {} }');
    fs.mkdirSync(path.join(root, 'obj'));
    fs.writeFileSync(path.join(root, 'obj', 'Generated.cs'), 'partial class Form1 { void Wrong() {} }');

    const paths = collectProjectEventSourcePaths(project, primary);

    expect(paths[0]).toBe(primary);
    expect(paths).toContain(path.join(root, 'Features', 'Form1.Events.cs'));
    expect(paths).not.toContain(path.join(root, 'Form1.Designer.cs'));
    expect(paths).not.toContain(path.join(root, 'obj', 'Generated.cs'));
  });

  test('enforces file and byte limits without following directory links', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-event-bounds-'));
    roots.push(root);
    const project = path.join(root, 'App.csproj');
    fs.writeFileSync(project, '<Project />');
    for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(root, `P${i}.cs`), `partial class F${i} { }`);
    fs.writeFileSync(path.join(root, 'Huge.cs'), 'x'.repeat(4096));

    const paths = collectProjectEventSourcePaths(project, null, {
      maxFiles: 3,
      maxFileBytes: 1024,
      maxTotalBytes: 2048,
    });

    expect(paths).toHaveLength(3);
    expect(paths.some((file) => file.endsWith('Huge.cs'))).toBe(false);
  });
});
