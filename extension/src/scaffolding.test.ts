import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createScaffoldPlan,
  detectUsingPlacement,
  normalizeScaffoldTypeName,
  resolveScaffoldProject,
  ScaffoldError,
  ScaffoldErrorCode,
  suggestScaffoldTypeName,
} from './scaffolding';

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-scaffold-'));
  scratch.push(dir);
  return dir;
}

function expectCode(run: () => unknown, code: ScaffoldErrorCode): void {
  try {
    run();
    throw new Error(`expected ScaffoldError(${code})`);
  } catch (error) {
    expect(error).toBeInstanceOf(ScaffoldError);
    expect((error as ScaffoldError).code).toBe(code);
  }
}

const sdkWinForms = (extra = '') => [
  '<Project Sdk="Microsoft.NET.Sdk">',
  '  <PropertyGroup>',
  '    <TargetFramework>net10.0-windows</TargetFramework>',
  '    <UseWindowsForms>true</UseWindowsForms>',
  '    <RootNamespace>Sample.App</RootNamespace>',
  extra,
  '  </PropertyGroup>',
  '</Project>',
  '',
].filter((line) => line !== '').join('\n') + '\n';

describe('Explorer Add scaffolding', () => {
  it('normalizes safe Unicode names and rejects paths, punctuation, keywords, and empty input', () => {
    expect(normalizeScaffoldTypeName('  CustomerForm.cs ')).toBe('CustomerForm');
    expect(normalizeScaffoldTypeName('ФормаЗаказа')).toBe('ФормаЗаказа');
    for (const bad of ['', 'Form/Two', 'Two\\Form', '2Form', 'Bad.Name', 'class', 'record', 'A-B']) {
      expectCode(() => normalizeScaffoldTypeName(bad), 'invalidName');
    }
  });

  it('suggests the first collision-free Visual Studio-style name across all companion files', () => {
    expect(suggestScaffoldTypeName('form', ['Form1.cs', 'FORM2.RESX', 'Form3.Designer.cs'])).toBe('Form4');
    expect(suggestScaffoldTypeName('userControl', [])).toBe('UserControl1');
    expect(suggestScaffoldTypeName('component', ['component1.cs'])).toBe('Component2');
    expect(suggestScaffoldTypeName('class', ['Class1.cs'])).toBe('Class2');
  });

  it('resolves one bounded owner, refuses ambiguous/shared/no-project shapes, and honors a selected csproj', () => {
    const root = tempDir();
    const projectDir = path.join(root, 'App');
    const child = path.join(projectDir, 'Views');
    fs.mkdirSync(child, { recursive: true });
    const first = path.join(projectDir, 'App.csproj');
    fs.writeFileSync(first, '<Project />');
    expect(resolveScaffoldProject(child, root)).toBe(first);

    const second = path.join(projectDir, 'Other.csproj');
    fs.writeFileSync(second, '<Project />');
    expectCode(() => resolveScaffoldProject(child, root), 'ambiguousProject');
    expect(resolveScaffoldProject(projectDir, root, second)).toBe(second);

    const shared = path.join(root, 'Shared');
    fs.mkdirSync(shared);
    fs.writeFileSync(path.join(shared, 'Shared.projitems'), '<Project />');
    expectCode(() => resolveScaffoldProject(shared, root), 'sharedProjectUnsupported');
    const empty = path.join(root, 'Empty');
    fs.mkdirSync(empty);
    expectCode(() => resolveScaffoldProject(empty, empty), 'noProject');
    expectCode(() => resolveScaffoldProject(root, projectDir), 'outsideWorkspace');
  });

  it('generates a complete SDK Form in the correct nested namespace without editing implicit items', () => {
    const root = tempDir();
    const target = path.join(root, 'Views', 'Order Entry');
    fs.mkdirSync(target, { recursive: true });
    const projectPath = path.join(root, 'Sample.csproj');
    const plan = createScaffoldPlan({
      kind: 'form', typeName: 'OrderForm', targetDir: target, projectPath,
      projectText: sdkWinForms(), existingEntries: [],
    });

    expect(plan.namespace).toBe('Sample.App.Views.Order_Entry');
    // Visual Studio seeds no .resx on an SDK project; the engine writes one when a resource first needs it.
    expect(plan.files.map((file) => file.name)).toEqual(['OrderForm.cs', 'OrderForm.Designer.cs']);
    expect(plan.projectInsertion).toBeUndefined();
    expect(plan.openInDesigner).toBe(true);
    expect(plan.files[0].content).toContain('public partial class OrderForm : Form');
    expect(plan.files[0].content).toContain('InitializeComponent();');
    expect(plan.files[1].content).toContain('private System.ComponentModel.IContainer components = null;');
    expect(plan.files[1].content).toContain('this.ClientSize = new System.Drawing.Size(800, 450);');
  });

  it('emits the Visual Studio Windows Form template byte for byte', () => {
    const root = tempDir();
    const projectPath = path.join(root, 'Sample.csproj');
    const plan = createScaffoldPlan({
      kind: 'form', typeName: 'Form1', targetDir: root, projectPath,
      projectText: sdkWinForms(), existingEntries: [],
    });

    expect(plan.files[0].content).toBe([
      'using System;',
      'using System.Collections.Generic;',
      'using System.ComponentModel;',
      'using System.Data;',
      'using System.Drawing;',
      'using System.Linq;',
      'using System.Text;',
      'using System.Threading.Tasks;',
      'using System.Windows.Forms;',
      '',
      'namespace Sample.App',
      '{',
      '    public partial class Form1 : Form',
      '    {',
      '        public Form1()',
      '        {',
      '            InitializeComponent();',
      '        }',
      '    }',
      '}',
      '',
    ].join('\n'));

    expect(plan.files[1].content).toBe([
      'namespace Sample.App',
      '{',
      '    partial class Form1',
      '    {',
      '        /// <summary>',
      '        /// Required designer variable.',
      '        /// </summary>',
      '        private System.ComponentModel.IContainer components = null;',
      '',
      '        /// <summary>',
      '        /// Clean up any resources being used.',
      '        /// </summary>',
      '        /// <param name="disposing">true if managed resources should be disposed; otherwise, false.</param>',
      '        protected override void Dispose(bool disposing)',
      '        {',
      '            if (disposing && (components != null))',
      '            {',
      '                components.Dispose();',
      '            }',
      '            base.Dispose(disposing);',
      '        }',
      '',
      '        #region Windows Form Designer generated code',
      '',
      '        /// <summary>',
      '        /// Required method for Designer support - do not modify',
      '        /// the contents of this method with the code editor.',
      '        /// </summary>',
      '        private void InitializeComponent()',
      '        {',
      '            this.components = new System.ComponentModel.Container();',
      '            this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;',
      '            this.ClientSize = new System.Drawing.Size(800, 450);',
      '            this.Text = "Form1";',
      '        }',
      '',
      '        #endregion',
      '    }',
      '}',
      '',
    ].join('\n'));

    // A constant AutoScaleDimensions would rescale the form wherever the default font is not 9pt Segoe UI,
    // and the template writes neither it nor the layout suspension the designer adds on the first edit.
    for (const absent of ['AutoScaleDimensions', 'SuspendLayout', 'ResumeLayout', 'this.Name =']) {
      expect(plan.files[1].content).not.toContain(absent);
    }
  });

  it('omits the using block when the project enables implicit usings', () => {
    const root = tempDir();
    const plan = createScaffoldPlan({
      kind: 'form', typeName: 'Form1', targetDir: root, projectPath: path.join(root, 'Sample.csproj'),
      projectText: sdkWinForms('    <ImplicitUsings>enable</ImplicitUsings>'), existingEntries: [],
    });
    expect(plan.files[0].content.startsWith('namespace Sample.App')).toBe(true);
    expect(plan.files[0].content).not.toContain('using System;');
    expect(plan.files[0].content).toContain('public partial class Form1 : Form');
  });

  it('places usings inside the namespace when .editorconfig asks for it', () => {
    const root = tempDir();
    const plan = createScaffoldPlan({
      kind: 'form', typeName: 'Form1', targetDir: root, projectPath: path.join(root, 'Sample.csproj'),
      projectText: sdkWinForms(), existingEntries: [], usingPlacement: 'inside',
    });
    expect(plan.files[0].content).toBe([
      'namespace Sample.App',
      '{',
      '    using System;',
      '    using System.Collections.Generic;',
      '    using System.ComponentModel;',
      '    using System.Data;',
      '    using System.Drawing;',
      '    using System.Linq;',
      '    using System.Text;',
      '    using System.Threading.Tasks;',
      '    using System.Windows.Forms;',
      '',
      '    public partial class Form1 : Form',
      '    {',
      '        public Form1()',
      '        {',
      '            InitializeComponent();',
      '        }',
      '    }',
      '}',
      '',
    ].join('\n'));
  });

  it('reads csharp_using_directive_placement from the nearest matching .editorconfig', () => {
    const root = tempDir();
    const nested = path.join(root, 'src', 'App');
    fs.mkdirSync(nested, { recursive: true });
    expect(detectUsingPlacement(nested, root)).toBe('outside');

    fs.writeFileSync(path.join(root, '.editorconfig'), [
      'root = true',
      '',
      '[*]',
      'indent_style = space',
      '',
      '[*.{cs,vb}]',
      'csharp_using_directive_placement = inside_namespace:silent',
      '',
    ].join('\n'));
    expect(detectUsingPlacement(nested, root)).toBe('inside');

    // A nearer file wins, and a section that does not match .cs is ignored.
    fs.writeFileSync(path.join(nested, '.editorconfig'), [
      '[*.vb]',
      'csharp_using_directive_placement = inside_namespace',
      '',
      '[*.cs]',
      'csharp_using_directive_placement = outside_namespace:warning',
      '',
    ].join('\n'));
    expect(detectUsingPlacement(nested, root)).toBe('outside');

    // Unreadable or unrelated configuration keeps Visual Studio's own default.
    fs.writeFileSync(path.join(nested, '.editorconfig'), '[*.cs]\nindent_size = 4\n');
    expect(detectUsingPlacement(nested, root)).toBe('inside');
    fs.rmSync(path.join(root, '.editorconfig'));
    expect(detectUsingPlacement(nested, root)).toBe('outside');
  });

  it('generates a complete UserControl surface', () => {
    const root = tempDir();
    const projectPath = path.join(root, 'Sample.csproj');
    const plan = createScaffoldPlan({
      kind: 'userControl', typeName: 'AddressEditor', targetDir: root, projectPath,
      projectText: sdkWinForms(), existingEntries: [],
    });
    expect(plan.files[0].content).toContain('public partial class AddressEditor : UserControl');
    expect(plan.files[1].content).toContain('#region Component Designer generated code');
    expect(plan.files[1].content).toContain('this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;');
    expect(plan.files[1].content).not.toContain('this.ClientSize');
    expect(plan.files[1].content).not.toContain('AutoScaleDimensions');
  });

  it('generates code-only Component and Class templates without pretending the component has a visual root', () => {
    const root = tempDir();
    const projectPath = path.join(root, 'Library.csproj');
    const projectText = '<Project Sdk="Microsoft.NET.Sdk">\n</Project>\n';
    const component = createScaffoldPlan({
      kind: 'component', typeName: 'ClockComponent', targetDir: root, projectPath, projectText, existingEntries: [],
    });
    expect(component.files).toHaveLength(1);
    expect(component.files[0].content).toContain('ClockComponent : System.ComponentModel.Component');
    expect(component.files[0].content).toContain('System.ComponentModel.IContainer container');
    expect(component.openInDesigner).toBe(false);
    expect(component.projectInsertion).toBeUndefined();

    const klass = createScaffoldPlan({
      kind: 'class', typeName: 'Customer', targetDir: root, projectPath, projectText, existingEntries: [],
    });
    expect(klass.files).toHaveLength(1);
    expect(klass.files[0].content).toContain('public class Customer');
    expect(klass.files[0].content).not.toContain('System.ComponentModel');
    expect(klass.openInDesigner).toBe(false);
  });

  it('inserts classic Form items with SubType/DependentUpon and preserves CRLF', () => {
    const root = tempDir();
    const target = path.join(root, 'Views');
    fs.mkdirSync(target);
    const projectPath = path.join(root, 'Legacy.csproj');
    const projectText = [
      '<Project ToolsVersion="15.0">',
      '  <PropertyGroup><RootNamespace>Legacy.App</RootNamespace></PropertyGroup>',
      '  <ItemGroup><Reference Include="System.Windows.Forms" /></ItemGroup>',
      '</Project>',
      '',
    ].join('\r\n');
    const plan = createScaffoldPlan({
      kind: 'form', typeName: 'LegacyForm', targetDir: target, projectPath, projectText, existingEntries: [],
    });
    expect(plan.projectInsertion).toBeDefined();
    const insertion = plan.projectInsertion!;
    const updated = projectText.slice(0, insertion.offset) + insertion.text + projectText.slice(insertion.offset);
    expect(updated).toContain('<Compile Include="Views\\LegacyForm.cs">\r\n      <SubType>Form</SubType>');
    expect(updated).toContain('<Compile Include="Views\\LegacyForm.Designer.cs">\r\n      <DependentUpon>LegacyForm.cs</DependentUpon>');
    expect(updated).toContain('<EmbeddedResource Include="Views\\LegacyForm.resx">\r\n      <DependentUpon>LegacyForm.cs</DependentUpon>');
    expect(updated.replace(/\r\n/g, '')).not.toContain('\n');
    expect(updated.endsWith('</Project>\r\n')).toBe(true);
  });

  it('XML-escapes explicit project item paths without changing the generated file path', () => {
    const root = tempDir();
    const target = path.join(root, 'R&D');
    fs.mkdirSync(target);
    const projectPath = path.join(root, 'Legacy.csproj');
    const plan = createScaffoldPlan({
      kind: 'class', typeName: 'Report', targetDir: target, projectPath,
      projectText: '<Project>\n</Project>\n', existingEntries: [],
    });
    expect(plan.files[0].name).toBe('Report.cs');
    expect(plan.projectInsertion?.text).toContain('Include="R&amp;D\\Report.cs"');
  });

  it('adds only item types whose SDK defaults are disabled', () => {
    const root = tempDir();
    const projectPath = path.join(root, 'App.csproj');
    const projectText = sdkWinForms('    <EnableDefaultCompileItems>false</EnableDefaultCompileItems>');
    const plan = createScaffoldPlan({
      kind: 'form', typeName: 'Form1', targetDir: root, projectPath, projectText, existingEntries: [],
    });
    const text = plan.projectInsertion?.text ?? '';
    expect(text).toContain('<Compile Include="Form1.cs">');
    expect(text).toContain('<Compile Include="Form1.Designer.cs">');
    expect(text).not.toContain('<EmbeddedResource');
  });

  it('reuses an existing exact classic item instead of duplicating it', () => {
    const root = tempDir();
    const projectPath = path.join(root, 'Legacy.csproj');
    const projectText = [
      '<Project>',
      '  <ItemGroup>',
      '    <Reference Include="System.Windows.Forms" />',
      '    <Compile Include="Form1.cs"><SubType>Form</SubType></Compile>',
      '  </ItemGroup>',
      '</Project>',
    ].join('\n');
    const plan = createScaffoldPlan({
      kind: 'form', typeName: 'Form1', targetDir: root, projectPath, projectText, existingEntries: [],
    });
    expect(plan.projectInsertion?.text).not.toContain('<Compile Include="Form1.cs">');
    expect(plan.projectInsertion?.text).toContain('<Compile Include="Form1.Designer.cs">');
  });

  it('refuses collisions before producing a plan', () => {
    const root = tempDir();
    expectCode(() => createScaffoldPlan({
      kind: 'form', typeName: 'Form1', targetDir: root, projectPath: path.join(root, 'App.csproj'),
      projectText: sdkWinForms(), existingEntries: ['FORM1.DESIGNER.CS'],
    }), 'fileCollision');
  });

  it('refuses non-WinForms, malformed, dynamic, outside-project, and ambiguous item shapes', () => {
    const root = tempDir();
    const projectPath = path.join(root, 'App.csproj');
    expectCode(() => createScaffoldPlan({
      kind: 'form', typeName: 'Form1', targetDir: root, projectPath,
      projectText: '<Project Sdk="Microsoft.NET.Sdk"></Project>', existingEntries: [],
    }), 'notWinFormsProject');
    expectCode(() => createScaffoldPlan({
      kind: 'class', typeName: 'Class1', targetDir: root, projectPath,
      projectText: '<Project Sdk="Microsoft.NET.Sdk">', existingEntries: [],
    }), 'malformedProject');
    expectCode(() => createScaffoldPlan({
      kind: 'class', typeName: 'Class1', targetDir: root, projectPath,
      projectText: '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><RootNamespace>$(ProjectName)</RootNamespace></PropertyGroup></Project>', existingEntries: [],
    }), 'dynamicProjectProperty');
    expectCode(() => createScaffoldPlan({
      kind: 'class', typeName: 'Class1', targetDir: root, projectPath,
      projectText: '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup Condition="\'$(Configuration)\' == \'Debug\'"><RootNamespace>Debug.App</RootNamespace></PropertyGroup></Project>', existingEntries: [],
    }), 'dynamicProjectProperty');
    expectCode(() => createScaffoldPlan({
      kind: 'class', typeName: 'Class1', targetDir: root, projectPath,
      projectText: '<Project Sdk="$(CustomSdk)"></Project>', existingEntries: [],
    }), 'dynamicProjectProperty');
    expectCode(() => createScaffoldPlan({
      kind: 'class', typeName: 'Class1', targetDir: path.dirname(root), projectPath,
      projectText: '<Project Sdk="Microsoft.NET.Sdk"></Project>', existingEntries: [],
    }), 'outsideProject');
    expectCode(() => createScaffoldPlan({
      kind: 'class', typeName: 'Class1', targetDir: root, projectPath,
      projectText: '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup><ItemGroup><Compile Include="**\\*.cs" /></ItemGroup></Project>', existingEntries: [],
    }), 'unsupportedProjectItems');
  });
});
