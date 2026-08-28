import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test } from 'vitest';
import { projectPathsFromSolution, projectPathsFromSolutionFile } from './solutionProjects';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('solution project discovery', () => {
  test('reads existing C# projects from classic sln and ignores solution folders/missing projects', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-sln-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'src'));
    const project = path.join(root, 'src', 'App.csproj');
    fs.writeFileSync(project, '<Project />');
    const solution = path.join(root, 'App.sln');
    const text = [
      'Microsoft Visual Studio Solution File, Format Version 12.00',
      'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "App", "src\\App.csproj", "{A}"',
      'EndProject',
      'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Missing", "src\\Missing.csproj", "{B}"',
      'EndProject',
    ].join('\r\n');
    fs.writeFileSync(solution, text);

    expect(projectPathsFromSolutionFile(solution)).toEqual([project]);
  });

  test('reads current slnx Project Path attributes and de-duplicates identities', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-slnx-'));
    roots.push(root);
    const project = path.join(root, 'App.csproj');
    fs.writeFileSync(project, '<Project />');
    const solution = path.join(root, 'App.slnx');
    const text = '<Solution><Folder Name="/src/"><Project Path="App.csproj" /><Project Id="x" Path=\'App.csproj\' /></Folder></Solution>';

    expect(projectPathsFromSolution(solution, text)).toEqual([project]);
  });
});
