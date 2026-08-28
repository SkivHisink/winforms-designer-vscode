import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { planAddFormMembership, planRemoveFormMembership } from './formProjectMembership';

describe('form project membership', () => {
  const root = path.resolve('C:/repo/App');
  const project = path.join(root, 'App.csproj');
  const files = [
    path.join(root, 'Copy.cs'),
    path.join(root, 'Copy.Designer.cs'),
    path.join(root, 'Copy.resx'),
    path.join(root, 'Copy.fr-FR.resx'),
  ];

  it('adds code, generated source, neutral and culture resources to one classic project edit', () => {
    const before = '<Project>\r\n</Project>\r\n';
    const edit = planAddFormMembership(project, before, files[0], files);
    expect(edit).not.toBeNull();
    expect(edit!.after).toContain('<Compile Include="Copy.cs">');
    expect(edit!.after).toContain('<Compile Include="Copy.Designer.cs">');
    expect(edit!.after).toContain('<EmbeddedResource Include="Copy.resx">');
    expect(edit!.after).toContain('<EmbeddedResource Include="Copy.fr-FR.resx">');
    expect(edit!.after.match(/<DependentUpon>Copy\.cs<\/DependentUpon>/g)).toHaveLength(3);
  });

  it('leaves an SDK project with default items byte-identical', () => {
    const before = '<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup><EnableDefaultItems>true</EnableDefaultItems></PropertyGroup>\n</Project>\n';
    expect(planAddFormMembership(project, before, files[0], files)).toBeNull();
  });

  it('adds shared-project paths with MSBuildThisFileDirectory', () => {
    const projitems = path.join(root, 'Shared.projitems');
    const before = '<Project>\n</Project>\n';
    const edit = planAddFormMembership(projitems, before, files[0], files);
    expect(edit!.after).toContain('Include="$(MSBuildThisFileDirectory)Copy.Designer.cs"');
  });

  it('removes exact classic form items but preserves unrelated and wildcard entries', () => {
    const before = [
      '<Project>',
      '  <ItemGroup>',
      '    <Compile Include="Copy.cs"><SubType>Form</SubType></Compile>',
      '    <Compile Include="Copy.Designer.cs"><DependentUpon>Copy.cs</DependentUpon></Compile>',
      '    <EmbeddedResource Include="Copy.resx"><DependentUpon>Copy.cs</DependentUpon></EmbeddedResource>',
      '    <EmbeddedResource Include="Copy.fr-FR.resx"><DependentUpon>Copy.cs</DependentUpon></EmbeddedResource>',
      '    <Compile Include="Other.cs" />',
      '    <Compile Include="Generated\\*.cs" />',
      '  </ItemGroup>',
      '</Project>',
      '',
    ].join('\r\n');
    const edit = planRemoveFormMembership(project, before, files);
    expect(edit).not.toBeNull();
    expect(edit!.after).not.toContain('Copy.cs');
    expect(edit!.after).not.toContain('Copy.Designer.cs');
    expect(edit!.after).not.toContain('Copy.resx');
    expect(edit!.after).toContain('Other.cs');
    expect(edit!.after).toContain('Generated\\*.cs');
  });
});
