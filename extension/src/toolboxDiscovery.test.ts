import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  applyV2ChooseItems,
  authorizeV2ToolboxAssembly,
  buildV2ToolboxPalette,
  discoverBuildOutputAssemblies,
  discoverProjectBuildOutputRoots,
  discoverProbeAssemblies,
  discoverRegisteredAssemblies,
  filterToolboxByRuntime,
  refuseTierDToolboxRequest,
  isUserEditDocument,
  uniqueAssemblyPaths
} from './toolboxDiscovery';

const made: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-toolbox-'));
  made.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('toolbox assembly discovery', () => {
  it('finds bounded probe DLLs through common lib/TFM nesting and de-duplicates roots', () => {
    const root = tempDir();
    const lib = path.join(root, 'lib', 'net48');
    fs.mkdirSync(lib, { recursive: true });
    fs.writeFileSync(path.join(root, 'Top.dll'), '');
    fs.writeFileSync(path.join(lib, 'Vendor.dll'), '');
    fs.writeFileSync(path.join(lib, 'ignore.txt'), '');
    const found = discoverProbeAssemblies([root, root]).map((p) => path.basename(p)).sort();
    expect(found).toEqual(['Top.dll', 'Vendor.dll']);
  });

  it('keeps third-party GAC registrations and omits framework assemblies already in the baseline', () => {
    const win = tempDir();
    const gac = path.join(win, 'Microsoft.NET', 'assembly', 'GAC_MSIL');
    const vendor = path.join(gac, 'Acme.Controls', 'v4.0_1.0.0.0__abc');
    const system = path.join(gac, 'System.Windows.Forms', 'v4.0_4.0.0.0__b77');
    fs.mkdirSync(vendor, { recursive: true });
    fs.mkdirSync(system, { recursive: true });
    fs.writeFileSync(path.join(vendor, 'Acme.Controls.dll'), '');
    fs.writeFileSync(path.join(system, 'System.Windows.Forms.dll'), '');
    expect(discoverRegisteredAssemblies(win).map((p) => path.basename(p))).toEqual(['Acme.Controls.dll']);
  });

  it('drops missing and non-DLL paths while keeping the first normalized occurrence', () => {
    const root = tempDir();
    const dll = path.join(root, 'Controls.dll');
    fs.writeFileSync(dll, '');
    expect(uniqueAssemblyPaths([dll, dll, path.join(root, 'no.dll'), path.join(root, 'notes.txt')])).toEqual([dll]);
  });

  it('discovers only explicit build-output roots and reports metadata keys and scanned directories', async () => {
    const rootA = tempDir();
    const rootB = tempDir();
    const outside = tempDir();
    fs.writeFileSync(path.join(rootA, 'Alpha.dll'), 'a');
    fs.writeFileSync(path.join(rootB, 'Beta.dll'), 'beta');
    fs.writeFileSync(path.join(outside, 'Ignored.dll'), 'ignored');

    const result = await discoverBuildOutputAssemblies([rootB, rootA, rootB], {
      yieldNow: async () => undefined
    });

    expect(result.assemblies.map((candidate) => path.basename(candidate.path))).toEqual(['Beta.dll', 'Alpha.dll']);
    expect(result.assemblies.map((candidate) => candidate.size)).toEqual([4, 1]);
    expect(result.assemblies.every((candidate) => {
      const normalizedPath = process.platform === 'win32'
        ? path.normalize(candidate.path).toLowerCase()
        : path.normalize(candidate.path);
      return candidate.key.startsWith(`${normalizedPath}|${candidate.size}|`);
    })).toBe(true);
    expect(result.scannedDirectories).toEqual([path.resolve(rootB), path.resolve(rootA)]);
    expect(result.skipped.duplicateRoots).toBe(1);
    expect(result.assemblies.some((candidate) => candidate.path.includes('Ignored.dll'))).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it('stops build-output traversal at the configured depth and reports skipped directories', async () => {
    const root = tempDir();
    const level1 = path.join(root, 'net48');
    const level2 = path.join(level1, 'plugins');
    fs.mkdirSync(level2, { recursive: true });
    fs.writeFileSync(path.join(root, 'Root.dll'), '');
    fs.writeFileSync(path.join(level1, 'Level1.dll'), '');
    fs.writeFileSync(path.join(level2, 'Level2.dll'), '');

    const result = await discoverBuildOutputAssemblies([root], {
      maxDepth: 1,
      yieldNow: async () => undefined
    });

    expect(result.assemblies.map((candidate) => path.basename(candidate.path))).toEqual(['Root.dll', 'Level1.dll']);
    expect(result.scannedDirectories).toEqual([path.resolve(root), path.resolve(level1)]);
    expect(result.skipped.directoriesByDepth).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it('applies the build-output file budget before collecting more DLL metadata', async () => {
    const root = tempDir();
    fs.writeFileSync(path.join(root, 'A.dll'), '');
    fs.writeFileSync(path.join(root, 'B.dll'), '');
    fs.writeFileSync(path.join(root, 'C.dll'), '');

    const result = await discoverBuildOutputAssemblies([root], {
      maxFiles: 2,
      yieldNow: async () => undefined
    });

    expect(result.assemblies.map((candidate) => path.basename(candidate.path))).toEqual(['A.dll', 'B.dll']);
    expect(result.skipped.filesByBudget).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it('applies the build-output directory budget and reports queued directories left unscanned', async () => {
    const root = tempDir();
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    fs.writeFileSync(path.join(a, 'A.dll'), '');
    fs.writeFileSync(path.join(b, 'B.dll'), '');

    const result = await discoverBuildOutputAssemblies([root], {
      maxDirectories: 2,
      yieldNow: async () => undefined
    });

    expect(result.scannedDirectories).toEqual([path.resolve(root), path.resolve(a)]);
    expect(result.assemblies.map((candidate) => path.basename(candidate.path))).toEqual(['A.dll']);
    expect(result.skipped.directoriesByBudget).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it('stops build-output discovery when the time budget expires', async () => {
    const root = tempDir();
    const next = path.join(root, 'next');
    fs.mkdirSync(next, { recursive: true });
    fs.writeFileSync(path.join(next, 'Next.dll'), '');
    const ticks = [0, 0, 10];

    const result = await discoverBuildOutputAssemblies([root], {
      maxMilliseconds: 5,
      now: () => ticks.shift() ?? 10,
      yieldNow: async () => undefined
    });

    expect(result.scannedDirectories).toEqual([path.resolve(root)]);
    expect(result.assemblies).toEqual([]);
    expect(result.skipped.timeBudget).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it('supports cancellation between bounded directory slices', async () => {
    const root = tempDir();
    const next = path.join(root, 'next');
    fs.mkdirSync(next, { recursive: true });
    fs.writeFileSync(path.join(next, 'Next.dll'), '');
    let checks = 0;

    const result = await discoverBuildOutputAssemblies([root], {
      shouldCancel: () => ++checks > 1,
      yieldNow: async () => undefined
    });

    expect(result.scannedDirectories).toEqual([path.resolve(root)]);
    expect(result.cancelled).toBe(true);
    expect(result.skipped.cancelled).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it('yields after the configured number of scanned build-output directories', async () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'a'), { recursive: true });
    fs.mkdirSync(path.join(root, 'b'), { recursive: true });
    let yields = 0;

    await discoverBuildOutputAssemblies([root], {
      yieldEveryDirectories: 1,
      yieldNow: async () => { yields++; }
    });

    expect(yields).toBe(3);
  });
});

describe('project-scoped build-output roots', () => {
  it('follows only the owning project reference graph and excludes unrelated sibling projects', async () => {
    const root = tempDir();
    const app = path.join(root, 'App');
    const controls = path.join(root, 'Controls');
    const unrelated = path.join(root, 'Unrelated');
    for (const dir of [app, controls, unrelated]) fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    const appProject = path.join(app, 'App.csproj');
    const controlsProject = path.join(controls, 'Controls.csproj');
    fs.writeFileSync(appProject, '<Project><ItemGroup><ProjectReference Include="..\\Controls\\Controls.csproj" /></ItemGroup></Project>');
    fs.writeFileSync(controlsProject, '<Project />');
    fs.writeFileSync(path.join(unrelated, 'Unrelated.csproj'), '<Project />');

    const result = await discoverProjectBuildOutputRoots(appProject, { yieldNow: async () => undefined });

    expect(result.projects).toEqual([path.resolve(appProject), path.resolve(controlsProject)]);
    expect(result.roots).toEqual([path.resolve(app, 'bin'), path.resolve(controls, 'bin')]);
    expect(result.roots).not.toContain(path.resolve(unrelated, 'bin'));
    expect(result.projectBudgetReached).toBe(false);
  });

  it('discovers a concrete BaseOutputPath when a project redirects build products outside bin', async () => {
    const root = tempDir();
    const app = path.join(root, 'App');
    const buildOutput = path.join(app, 'build-out');
    fs.mkdirSync(buildOutput, { recursive: true });
    const appProject = path.join(app, 'App.csproj');
    fs.writeFileSync(appProject, [
      '<Project>',
      '  <PropertyGroup><BaseOutputPath>build-out\\</BaseOutputPath></PropertyGroup>',
      '  <!-- <OutputPath>ignored-comment\\</OutputPath> -->',
      '  <PropertyGroup><OutputPath>$(BaseOutputPath)Debug\\</OutputPath></PropertyGroup>',
      '</Project>',
    ].join('\n'));

    const result = await discoverProjectBuildOutputRoots(appProject, { yieldNow: async () => undefined });

    expect(result.roots).toEqual([path.resolve(buildOutput)]);
    expect(result.missingBuildOutputs).toBe(0);
  });

  it('deduplicates cycles and reports a project-count budget without walking the remaining graph', async () => {
    const root = tempDir();
    const a = path.join(root, 'A');
    const b = path.join(root, 'B');
    for (const dir of [a, b]) fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    const aProject = path.join(a, 'A.csproj');
    const bProject = path.join(b, 'B.csproj');
    fs.writeFileSync(aProject, '<Project><ItemGroup><ProjectReference Include="..\\B\\B.csproj" /></ItemGroup></Project>');
    fs.writeFileSync(bProject, '<Project><ItemGroup><ProjectReference Include="..\\A\\A.csproj" /></ItemGroup></Project>');

    const bounded = await discoverProjectBuildOutputRoots(aProject, {
      maxProjects: 1,
      yieldNow: async () => undefined,
    });
    expect(bounded.projects).toEqual([path.resolve(aProject)]);
    expect(bounded.projectBudgetReached).toBe(true);

    const complete = await discoverProjectBuildOutputRoots(aProject, { yieldNow: async () => undefined });
    expect(complete.projects).toEqual([path.resolve(aProject), path.resolve(bProject)]);
    expect(complete.projectBudgetReached).toBe(false);
  });

  it('cancels before reading another referenced project', async () => {
    const root = tempDir();
    const app = path.join(root, 'App');
    const controls = path.join(root, 'Controls');
    for (const dir of [app, controls]) fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    const appProject = path.join(app, 'App.csproj');
    fs.writeFileSync(appProject, '<Project><ItemGroup><ProjectReference Include="..\\Controls\\Controls.csproj" /></ItemGroup></Project>');
    fs.writeFileSync(path.join(controls, 'Controls.csproj'), '<Project />');
    let checks = 0;

    const result = await discoverProjectBuildOutputRoots(appProject, {
      shouldCancel: () => ++checks > 1,
      yieldNow: async () => undefined,
    });

    expect(result.projects).toEqual([path.resolve(appProject)]);
    expect(result.cancelled).toBe(true);
  });

  it('reschedules discovery for user edits only, never for VS Code-owned documents', () => {
    expect(isUserEditDocument('file')).toBe(true);
    expect(isUserEditDocument('untitled')).toBe(true);
    // 'output' is the one that mattered: discovery logs into an output channel, whose document change would
    // otherwise reschedule discovery, which logs again — a loop that runs for as long as the log stays open.
    for (const scheme of ['output', 'vscode-userdata', 'git', 'vscode', 'search-editor', 'debug']) {
      expect(isUserEditDocument(scheme)).toBe(false);
    }
  });
});

describe('v2 toolbox catalog scenarios S053-S060', () => {
  it('V2-FND-001-S053: auto-populates framework controls with provenance and category', () => {
    const palette = buildV2ToolboxPalette([
      { name: 'Button', fqn: 'System.Windows.Forms.Button', category: 'Common Controls' },
      { name: 'Label', fqn: 'System.Windows.Forms.Label', category: 'Common Controls' },
    ], [], {
      chosenItems: [],
      hiddenFqns: [],
      favoriteFqns: ['System.Windows.Forms.Button'],
    });

    const button = palette.items.find((item) => item.name === 'Button');
    expect(button).toMatchObject({
      fqn: 'System.Windows.Forms.Button',
      category: 'Common Controls',
      favorite: true,
      suppressed: false,
      provenance: {
        kind: 'framework',
        assemblyName: 'System.Windows.Forms',
      },
    });
    expect(palette.items.map((item) => item.fqn)).toEqual([
      'System.Windows.Forms.Button',
      'System.Windows.Forms.Label',
    ]);
  });

  it('V2-FND-001-S054: Choose Items adds managed custom control with assembly provenance and cacheable state', () => {
    const root = tempDir();
    const assemblyPath = path.join(root, 'FakeVendor.dll');
    fs.writeFileSync(assemblyPath, 'managed');
    const automatic = [{ name: 'Button', fqn: 'System.Windows.Forms.Button', category: 'Common Controls' }];

    const next = applyV2ChooseItems({ chosenItems: [], hiddenFqns: [], favoriteFqns: [] }, automatic, [{
      name: 'FancyButton',
      namespace: 'FakeVendor',
      assemblyName: 'FakeVendor',
      version: '2.0.0.0',
      directory: root,
      assemblyPath,
      fromProject: true,
      checked: true,
    }], 'Favorites');
    const palette = buildV2ToolboxPalette(automatic, [], next);
    const fancy = palette.items.find((item) => item.fqn === 'FakeVendor.FancyButton');

    expect(next.chosenItems).toEqual([expect.objectContaining({
      name: 'FancyButton',
      fqn: 'FakeVendor.FancyButton',
      category: 'Favorites',
      fromProject: true,
      assemblyPath,
    })]);
    expect(fancy).toMatchObject({
      category: 'Favorites',
      fromProject: true,
      provenance: {
        kind: 'choose-items',
        assemblyName: 'FakeVendor',
        assemblyPath: path.resolve(assemblyPath),
      },
    });
  });

  it('V2-FND-001-S053/S054: product discovery roots feed framework plus project toolbox palette', async () => {
    const workspace = tempDir();
    const app = path.join(workspace, 'App');
    const controls = path.join(workspace, 'Controls');
    const controlsOutput = path.join(controls, 'bin', 'Debug', 'net8.0-windows');
    fs.mkdirSync(path.join(app, 'bin'), { recursive: true });
    fs.mkdirSync(controlsOutput, { recursive: true });
    const appProject = path.join(app, 'App.csproj');
    const controlsProject = path.join(controls, 'Controls.csproj');
    const controlAssembly = path.join(controlsOutput, 'Controls.dll');
    fs.writeFileSync(appProject, '<Project><ItemGroup><ProjectReference Include="..\\Controls\\Controls.csproj" /></ItemGroup></Project>');
    fs.writeFileSync(controlsProject, '<Project />');
    fs.writeFileSync(controlAssembly, 'managed-control-metadata');

    const roots = await discoverProjectBuildOutputRoots(appProject, { yieldNow: async () => undefined });
    const assemblies = await discoverBuildOutputAssemblies(roots.roots, { yieldNow: async () => undefined });
    const projectItems = assemblies.assemblies.map((assembly) => ({
      name: 'RatingControl',
      fqn: 'Controls.RatingControl',
      category: 'Project Controls',
      fromProject: true,
      assemblyPath: assembly.path,
    }));

    const curated = applyV2ChooseItems({
      chosenItems: [],
      hiddenFqns: ['System.Windows.Forms.Label'],
      favoriteFqns: ['Controls.RatingControl'],
    }, [
      { name: 'Button', fqn: 'System.Windows.Forms.Button', category: 'Common Controls' },
      ...projectItems,
    ], [{
      name: 'ChartControl',
      namespace: 'Controls',
      assemblyName: 'Controls',
      assemblyPath: controlAssembly,
      fromProject: true,
      checked: true,
    }], 'Project Controls');
    const palette = buildV2ToolboxPalette([
      { name: 'Button', fqn: 'System.Windows.Forms.Button', category: 'Common Controls' },
      { name: 'Label', fqn: 'System.Windows.Forms.Label', category: 'Common Controls' },
    ], projectItems, curated);

    expect(roots.projects).toEqual([path.resolve(appProject), path.resolve(controlsProject)]);
    expect(assemblies.assemblies.map((assembly) => path.basename(assembly.path))).toEqual(['Controls.dll']);
    expect(palette.items.map((item) => item.fqn)).toEqual([
      'System.Windows.Forms.Button',
      'Controls.RatingControl',
      'Controls.ChartControl',
    ]);
    expect(palette.suppressed.map((item) => item.fqn)).toEqual(['System.Windows.Forms.Label']);
    expect(palette.items.find((item) => item.fqn === 'System.Windows.Forms.Button')?.provenance.kind).toBe('framework');
    expect(palette.items.find((item) => item.fqn === 'Controls.RatingControl')).toMatchObject({
      category: 'Project Controls',
      favorite: true,
      provenance: {
        kind: 'project',
        assemblyName: 'Controls',
        assemblyPath: path.resolve(controlAssembly),
      },
    });
    expect(palette.items.find((item) => item.fqn === 'Controls.ChartControl')?.provenance.kind).toBe('choose-items');
  });

  it('V2-FND-001-S055: favorites and suppression persist per workspace without losing provenance', () => {
    const root = tempDir();
    const vendor = path.join(root, 'FakeVendor.dll');
    fs.writeFileSync(vendor, 'managed');
    const frameworkItems = [
      { name: 'Button', fqn: 'System.Windows.Forms.Button', category: 'Common Controls' },
      { name: 'Label', fqn: 'System.Windows.Forms.Label', category: 'Common Controls' },
    ];
    const projectItems = [
      { name: 'FancyButton', fqn: 'FakeVendor.FancyButton', category: 'Project Controls', fromProject: true, assemblyPath: vendor },
    ];
    const workspaceState = {
      chosenItems: [],
      hiddenFqns: ['System.Windows.Forms.Label'],
      favoriteFqns: ['System.Windows.Forms.Button', 'FakeVendor.FancyButton'],
    };

    const first = buildV2ToolboxPalette(frameworkItems, projectItems, workspaceState);
    const reloaded = buildV2ToolboxPalette(frameworkItems, projectItems, first.curation);

    expect(reloaded.items.map((item) => item.fqn)).toEqual([
      'System.Windows.Forms.Button',
      'FakeVendor.FancyButton',
    ]);
    expect(reloaded.suppressed.map((item) => item.fqn)).toEqual(['System.Windows.Forms.Label']);
    expect(reloaded.items.every((item) => item.favorite)).toBe(true);
    expect(reloaded.items.find((item) => item.fqn === 'FakeVendor.FancyButton')?.provenance).toMatchObject({
      kind: 'project',
      assemblyName: 'FakeVendor',
    });
  });

  it('V2-FND-001-S056: refuses toolbox assembly outside trusted workspace or allowlist before scanning', () => {
    const workspace = tempDir();
    const outside = tempDir();
    const dll = path.join(outside, 'ExternalControls.dll');
    fs.writeFileSync(dll, 'managed');

    const untrusted = authorizeV2ToolboxAssembly({
      assemblyPath: dll,
      workspaceRoots: [workspace],
      workspaceTrusted: true,
      designTimeCodeEnabled: false,
    });
    expect(untrusted).toMatchObject({
      ok: false,
      reasonCode: 'UNTRUSTED_ASSEMBLY',
    });

    const allowed = authorizeV2ToolboxAssembly({
      assemblyPath: dll,
      workspaceRoots: [workspace],
      allowlistedAssemblyPaths: [dll],
      workspaceTrusted: true,
      designTimeCodeEnabled: true,
    });
    expect(allowed).toMatchObject({
      ok: true,
      normalizedAssemblyPath: fs.realpathSync.native(dll),
    });
  });

  // Explicit evidence bindings: V2-FND-001-S057, V2-FND-001-S058, V2-FND-001-S059, V2-FND-001-S060.
  it('V2-FND-001-S057-S060: keeps x86 COM ActiveX Tier-D paths gated with no mutation or fake host', () => {
    expect(refuseTierDToolboxRequest('registered-activex')).toMatchObject({
      ok: false,
      reasonCode: 'X86_WORKER_UNAVAILABLE',
      mutationAllowed: false,
      generatedFiles: [],
    });
    expect(refuseTierDToolboxRequest('unsigned-activex')).toMatchObject({
      ok: false,
      reasonCode: 'COM_ACTIVE_X_UNSUPPORTED',
      mutationAllowed: false,
      generatedFiles: [],
    });
    expect(refuseTierDToolboxRequest('activex-rollback')).toMatchObject({
      ok: false,
      reasonCode: 'COM_ACTIVE_X_UNSUPPORTED',
      mutationAllowed: false,
      generatedFiles: [],
    });
    expect(refuseTierDToolboxRequest('com-toolbox')).toMatchObject({
      ok: false,
      reasonCode: 'TIER_D_NOT_APPROVED',
      mutationAllowed: false,
      generatedFiles: [],
    });
  });
});

describe('filterToolboxByRuntime', () => {
  type Item = { name: string; frameworkOnly?: boolean };
  const shim: Item = { name: 'DataGrid', frameworkOnly: true };
  const modern: Item = { name: 'Button' };
  const items: Item[] = [shim, modern];

  it('follows the open form in auto mode: a net4x form keeps the .NET Framework-only controls', () => {
    expect(filterToolboxByRuntime(items, 'net48').map((i) => i.name)).toEqual(['DataGrid', 'Button']);
    expect(filterToolboxByRuntime(items, 'modern').map((i) => i.name)).toEqual(['Button']);
  });

  it('pins the answer when the user overrides auto', () => {
    expect(filterToolboxByRuntime(items, 'modern', 'net48').map((i) => i.name)).toEqual(['DataGrid', 'Button']);
    expect(filterToolboxByRuntime(items, 'net48', 'modern').map((i) => i.name)).toEqual(['Button']);
    expect(filterToolboxByRuntime(items, 'modern', 'all').map((i) => i.name)).toEqual(['DataGrid', 'Button']);
  });

  it('keeps an item that never carries the flag, on either runtime', () => {
    expect(filterToolboxByRuntime([modern], 'modern')).toHaveLength(1);
    expect(filterToolboxByRuntime([modern], 'net48')).toHaveLength(1);
  });
});
