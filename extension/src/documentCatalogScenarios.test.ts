import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  artifactFingerprint,
  captureHotExitDocumentState,
  evaluateNoEditSave,
  planWinFormsSaveAs,
  readLocalArtifactSnapshot,
  restoreHotExitDocumentState,
  sha256Hex,
} from './documentStore';
import {
  ScaffoldError,
  applyScaffoldPlanAtomically,
  createScaffoldPlan,
} from './scaffolding';

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-v2-doc-scenarios-'));
  scratch.push(dir);
  return dir;
}

const sdkWinForms = [
  '<Project Sdk="Microsoft.NET.Sdk">',
  '  <PropertyGroup>',
  '    <TargetFramework>net10.0-windows</TargetFramework>',
  '    <UseWindowsForms>true</UseWindowsForms>',
  '    <RootNamespace>Catalog.App</RootNamespace>',
  '  </PropertyGroup>',
  '</Project>',
  '',
].join('\n');

const classicWinForms = [
  '<Project ToolsVersion="15.0">',
  '  <PropertyGroup><RootNamespace>Catalog.Legacy</RootNamespace></PropertyGroup>',
  '  <ItemGroup><Reference Include="System.Windows.Forms" /></ItemGroup>',
  '</Project>',
  '',
].join('\r\n');

describe('v2 document catalog scenarios S001-S008', () => {
  it('V2-FND-001-S001: no-edit save keeps bytes clean and plans no writes', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'Form1.Designer.cs');
    fs.writeFileSync(file, 'partial class Form1 { private void InitializeComponent() { } }\r\n', 'utf8');

    const baseline = artifactFingerprint(await readLocalArtifactSnapshot(file, { documentVersion: 1 }));
    const current = artifactFingerprint(await readLocalArtifactSnapshot(file, { documentVersion: 1 }));
    const result = evaluateNoEditSave(baseline, current);

    expect(result).toEqual({ accepted: true, dirty: false, diagnostic: 'NONE', writes: [] });
    expect(fs.readFileSync(file, 'utf8')).toBe('partial class Form1 { private void InitializeComponent() { } }\r\n');
  });

  it('V2-FND-001-S002: external designer source change refuses before mutation', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'Form1.Designer.cs');
    fs.writeFileSync(file, 'partial class Form1 { private void InitializeComponent() { } }\n', 'utf8');
    const baseline = artifactFingerprint(await readLocalArtifactSnapshot(file, { documentVersion: 4 }));

    fs.writeFileSync(file, 'partial class Form1 { private void InitializeComponent() { this.Text = "external"; } }\n', 'utf8');
    const current = artifactFingerprint(await readLocalArtifactSnapshot(file, { documentVersion: 4 }));
    const result = evaluateNoEditSave(baseline, current);

    expect(result.accepted).toBe(false);
    expect(result.diagnostic).toBe('STALE_SOURCE');
    expect(result.writes).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toContain('external');
  });

  it('V2-FND-001-S003: hot exit restores dirty buffers and the undo contract without replaying a patch', () => {
    const captured = captureHotExitDocumentState({
      documentId: 'Form1.cs',
      dirty: true,
      activeUndoIndex: 0,
      textByTarget: {
        'Form1.Designer.cs': 'this.button1.Location = new System.Drawing.Point(20, 30);',
        'Form1.resx': '<root />',
      },
      undoUnits: [{
        id: 'move-button1',
        label: 'Move button1',
        beforeTargetSha256: sha256Hex('10, 20'),
        afterTargetSha256: sha256Hex('20, 30'),
      }],
    });

    const restored = restoreHotExitDocumentState(captured);

    expect(restored).toEqual(captured);
    expect(restored).not.toBe(captured);
    expect(restored.undoUnits[0]).not.toBe(captured.undoUnits[0]);
    expect(restored.dirty).toBe(true);
  });

  it('V2-FND-001-S004: Save As refuses destination collisions and names every existing target', () => {
    const plan = planWinFormsSaveAs(
      ['CopyOfForm1.cs', 'CopyOfForm1.Designer.cs', 'CopyOfForm1.resx'],
      ['CopyOfForm1.cs', 'COPYOFFORM1.RESX', 'OtherForm.cs'],
    );

    expect(plan.accepted).toBe(false);
    expect(plan.diagnostic).toBe('DESTINATION_EXISTS');
    expect(plan.collisions).toEqual(['CopyOfForm1.cs', 'CopyOfForm1.resx']);
    expect(plan.destinations).toEqual(['CopyOfForm1.cs', 'CopyOfForm1.Designer.cs', 'CopyOfForm1.resx']);
  });

  it('V2-FND-001-S005: SDK Form scaffolding can create source designer and resx in one v2 plan', async () => {
    const root = tempDir();
    const projectPath = path.join(root, 'Catalog.App.csproj');
    fs.writeFileSync(projectPath, sdkWinForms, 'utf8');

    const plan = createScaffoldPlan({
      kind: 'form',
      typeName: 'Form2',
      targetDir: root,
      projectPath,
      projectText: sdkWinForms,
      existingEntries: ['Catalog.App.csproj'],
      seedSdkResx: true,
    });
    const applied = await applyScaffoldPlanAtomically(plan, {
      writeFile: async (filePath, content) => fs.promises.writeFile(filePath, content, 'utf8'),
      deleteFile: async (filePath) => fs.promises.rm(filePath, { force: true }),
    });

    expect(plan.files.map((file) => file.name)).toEqual(['Form2.cs', 'Form2.Designer.cs', 'Form2.resx']);
    expect(plan.projectInsertion).toBeUndefined();
    expect(applied.createdFiles.map((file) => path.basename(file)).sort()).toEqual(
      ['Form2.Designer.cs', 'Form2.cs', 'Form2.resx'].sort(),
    );
    expect(fs.existsSync(path.join(root, 'Form2.resx'))).toBe(true);
  });

  it('V2-FND-001-S006: classic UserControl scaffolding writes dependent project items', () => {
    const root = tempDir();
    const targetDir = path.join(root, 'Controls');
    fs.mkdirSync(targetDir);
    const projectPath = path.join(root, 'Catalog.Legacy.csproj');
    const plan = createScaffoldPlan({
      kind: 'userControl',
      typeName: 'WidgetControl',
      targetDir,
      projectPath,
      projectText: classicWinForms,
      existingEntries: [],
    });

    expect(plan.files.map((file) => file.name)).toEqual([
      'WidgetControl.cs',
      'WidgetControl.Designer.cs',
    ]);
    expect(plan.projectInsertion?.text).toContain('<Compile Include="Controls\\WidgetControl.cs">');
    expect(plan.projectInsertion?.text).toContain('<SubType>UserControl</SubType>');
    expect(plan.projectInsertion?.text).toContain('<DependentUpon>WidgetControl.cs</DependentUpon>');
    expect(plan.projectInsertion?.text).not.toContain('EmbeddedResource');
  });

  it('V2-FND-001-S007: unsafe component class names are refused before planning', () => {
    expect(() => createScaffoldPlan({
      kind: 'component',
      typeName: '..\\Injected',
      targetDir: tempDir(),
      projectPath: path.join(tempDir(), 'App.csproj'),
      projectText: '<Project Sdk="Microsoft.NET.Sdk"></Project>',
      existingEntries: [],
    })).toThrowError(ScaffoldError);
  });

  it('V2-FND-001-S008: partial scaffold write failure rolls back created artifacts and leaves project text alone', async () => {
    const root = tempDir();
    const projectPath = path.join(root, 'Catalog.Legacy.csproj');
    fs.writeFileSync(projectPath, classicWinForms, 'utf8');
    const plan = createScaffoldPlan({
      kind: 'form',
      typeName: 'PartialRollback',
      targetDir: root,
      projectPath,
      projectText: classicWinForms,
      existingEntries: ['Catalog.Legacy.csproj'],
    });
    const beforeProject = fs.readFileSync(projectPath, 'utf8');

    await expect(applyScaffoldPlanAtomically(plan, {
      writeFile: async (filePath, content) => {
        if (path.basename(filePath) === 'PartialRollback.resx') throw new Error('forced resx failure');
        await fs.promises.writeFile(filePath, content, 'utf8');
      },
      deleteFile: async (filePath) => fs.promises.rm(filePath, { force: true }),
      applyProjectInsertion: async () => { throw new Error('project update must not run after file failure'); },
    })).rejects.toMatchObject({ code: 'applyFailed' });

    expect(fs.existsSync(path.join(root, 'PartialRollback.cs'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'PartialRollback.Designer.cs'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'PartialRollback.resx'))).toBe(false);
    expect(fs.readFileSync(projectPath, 'utf8')).toBe(beforeProject);

    const projectFailurePlan = createScaffoldPlan({
      kind: 'form',
      typeName: 'ProjectRollback',
      targetDir: root,
      projectPath,
      projectText: classicWinForms,
      existingEntries: ['Catalog.Legacy.csproj'],
    });
    await expect(applyScaffoldPlanAtomically(projectFailurePlan, {
      writeFile: async (filePath, content) => fs.promises.writeFile(filePath, content, 'utf8'),
      deleteFile: async (filePath) => fs.promises.rm(filePath, { force: true }),
      applyProjectInsertion: async () => { throw new Error('forced project insertion failure'); },
    })).rejects.toMatchObject({ code: 'applyFailed' });

    expect(fs.existsSync(path.join(root, 'ProjectRollback.cs'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'ProjectRollback.Designer.cs'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'ProjectRollback.resx'))).toBe(false);
    expect(fs.readFileSync(projectPath, 'utf8')).toBe(beforeProject);
  });
});
