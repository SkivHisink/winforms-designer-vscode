import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertLocalArtifactPath } from './localArtifactPath';
import { runDesignerResourceTransaction } from './resourceTransactionCoordinator';

const scratch: string[] = [];
function temp(): string { const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-local-artifact-')); scratch.push(directory); return directory; }
afterEach(() => { for (const directory of scratch.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe('local artifact path authorization', () => {
  it('accepts future artifacts under a real workspace and rejects escapes', async () => {
    const root = temp();
    await expect(assertLocalArtifactPath(root, path.join(root, 'future', 'Copy.Designer.cs'))).resolves.toBeUndefined();
    await expect(assertLocalArtifactPath(root, path.join(root, '..', 'Other.cs'))).rejects.toThrow('escapes');
  });

  it('refuses a junction target before reading or writing its external project bytes', async () => {
    const root = temp(); const external = temp();
    const externalProject = path.join(external, 'App.csproj');
    fs.writeFileSync(externalProject, '<Project />');
    const junction = path.join(root, 'LinkedProject');
    fs.symlinkSync(external, junction, process.platform === 'win32' ? 'junction' : 'dir');
    const target = path.join(junction, 'Copy.cs');
    await expect(assertLocalArtifactPath(root, target)).rejects.toThrow('junction');
    await expect(assertLocalArtifactPath(junction, target)).rejects.toThrow('junction');
    let reads = 0; let writes = 0;
    await expect(runDesignerResourceTransaction({ label: 'junction Save As', workspaceRoot: root, journalRoot: path.join(root, 'journal'),
      targets: [{ filePath: target, before: null, after: 'new form', bom: false },
        { filePath: path.join(junction, 'App.csproj'), before: '<Project />', after: '<Project>new</Project>', bom: false }],
      readBytes: async () => { reads++; return null; }, writeBytes: async () => { writes++; }, deleteFile: async () => {}, registerUndo: () => true,
    })).rejects.toThrow('junction');
    expect(reads).toBe(0); expect(writes).toBe(0);
    expect(fs.readFileSync(externalProject, 'utf8')).toBe('<Project />');
    expect(fs.existsSync(path.join(external, 'Copy.cs'))).toBe(false);
  });
});
