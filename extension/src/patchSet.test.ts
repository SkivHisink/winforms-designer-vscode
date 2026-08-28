import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PatchOperation, PatchSet, authorizePatchSetTargets, validatePatchSet } from './patchSet';

const root = path.resolve('workspace', 'app');
const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

const preserve = {
  beforeBom: false,
  afterBom: false,
  beforeEol: 'crlf' as const,
  afterEol: 'crlf' as const,
};

function op(target: string, start: number, length: number): PatchOperation {
  return { kind: 'replaceTextSpan', target, span: { start, length }, preservation: preserve };
}

function patchSet(overrides: Partial<PatchSet>): PatchSet {
  return {
    id: 'ps1',
    lane: 'A',
    workspaceRoot: root,
    operations: [op('Form1.Designer.cs', 10, 5)],
    ...overrides,
  };
}

describe('patch set validation', () => {
  it('accepts non-overlapping Lane A text spans inside the workspace root', () => {
    const result = validatePatchSet(patchSet({
      operations: [
        op('Form1.Designer.cs', 10, 5),
        op('Form1.Designer.cs', 20, 2),
        op('Form1.resx', 0, 0),
      ],
    }));

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.normalizedTargets).toHaveLength(2);
  });

  it('rejects absolute, parent-traversal and empty targets', () => {
    const result = validatePatchSet(patchSet({
      operations: [
        op('..\\outside.cs', 0, 1),
        op('', 0, 1),
        op(path.join(root, 'Form1.cs'), 0, 1),
      ],
    }));

    expect(result.ok).toBe(false);
    expect(result.errors.filter((e) => e.includes('outside workspace root'))).toHaveLength(3);
  });

  it('rejects duplicate whole-target patches and overlapping spans', () => {
    const duplicate = validatePatchSet(patchSet({
      operations: [
        { kind: 'writeResourceText', target: 'Form1.resx', preservation: preserve },
        { kind: 'writeResourceText', target: 'Form1.resx', preservation: preserve },
      ],
    }));
    const overlap = validatePatchSet(patchSet({
      operations: [
        op('Form1.Designer.cs', 10, 5),
        op('Form1.Designer.cs', 14, 2),
      ],
    }));

    expect(duplicate.errors.join('\n')).toContain('duplicate whole-target patch');
    expect(overlap.errors.join('\n')).toContain('overlapping patch spans');
  });

  it('requires BOM/EOL metadata and explicit opt-in for preservation changes', () => {
    const result = validatePatchSet(patchSet({
      operations: [
        { kind: 'replaceTextSpan', target: 'Form1.Designer.cs', span: { start: 0, length: 1 } },
        {
          kind: 'replaceTextSpan',
          target: 'Form2.Designer.cs',
          span: { start: 0, length: 1 },
          preservation: { beforeBom: true, afterBom: false, beforeEol: 'crlf', afterEol: 'lf' },
        },
      ],
    }));

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('missing BOM/EOL preservation metadata');
    expect(result.errors.join('\n')).toContain('changes BOM without allowBomChange');
    expect(result.errors.join('\n')).toContain('changes EOL without allowEolChange');
  });

  it('requires Lane B patches to carry preview data and stay inside an owned region', () => {
    const result = validatePatchSet(patchSet({
      lane: 'B',
      ownedRegions: [{ id: 'initc-button', target: 'Form1.Designer.cs', start: 100, length: 50 }],
      operations: [
        {
          kind: 'replaceOwnedText',
          target: 'Form1.Designer.cs',
          span: { start: 110, length: 5 },
          ownedRegionId: 'initc-button',
          preview: { beforeSha256: 'a'.repeat(64), afterSha256: 'b'.repeat(64), summary: 'set Text' },
          preservation: preserve,
        },
        {
          kind: 'replaceOwnedText',
          target: 'Form1.Designer.cs',
          span: { start: 200, length: 5 },
          ownedRegionId: 'initc-button',
          preservation: preserve,
        },
      ],
    }));

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('missing preview');
    expect(result.errors.join('\n')).toContain('outside an owned region');
  });

  it('authorizes safe existing and create-file targets against the real filesystem', async () => {
    const workspaceRoot = tempDir('wfd-patch-root-');
    fs.mkdirSync(path.join(workspaceRoot, 'Forms'));
    fs.writeFileSync(path.join(workspaceRoot, 'Forms', 'Form1.cs'), 'old', 'utf8');

    const result = await authorizePatchSetTargets(patchSet({
      workspaceRoot,
      operations: [
        op('Forms/Form1.cs', 0, 1),
        { kind: 'createFile', target: 'Forms/Form2.cs', preservation: preserve },
      ],
    }));

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects a target whose existing ancestor is a symlink or junction', async () => {
    const workspaceRoot = tempDir('wfd-patch-root-');
    const outside = tempDir('wfd-patch-outside-');
    const link = path.join(workspaceRoot, 'linked');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

    const result = await authorizePatchSetTargets(patchSet({
      workspaceRoot,
      operations: [{ kind: 'createFile', target: 'linked/escaped.cs', preservation: preserve }],
    }));

    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toContain('symbolic link or junction');
  });
});
