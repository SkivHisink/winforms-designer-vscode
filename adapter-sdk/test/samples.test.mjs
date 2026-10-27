import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { validateAdapterPackage, validateAdapterResponse } from '../index.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
test('both independently copied author packages build and execute public stdio contracts without extension sources', async t => {
  const temporaryBase = path.join(repo, '.dotnet-temp', 'adapter-sdk-tests');
  await fs.mkdir(temporaryBase, { recursive: true });
  const root = await fs.mkdtemp(path.join(temporaryBase, 'author-'));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(`${path.resolve(temporaryBase)}${path.sep}`));
    assert.ok(path.basename(root).startsWith('author-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, 'adapter-sdk'));
  for (const file of ['index.mjs', 'index.d.mts', 'adapter-package.schema.json', 'package.json'])
    await fs.copyFile(path.join(repo, 'adapter-sdk', file), path.join(root, 'adapter-sdk', file));
  const author = path.join(root, 'samples', 'AdapterSdkPreview');
  await fs.mkdir(author, { recursive: true });
  await fs.copyFile(path.join(repo, 'samples', 'AdapterSdkPreview', 'build.mjs'), path.join(author, 'build.mjs'));
  for (const sample of ['action', 'editor']) {
    await fs.mkdir(path.join(author, sample));
    for (const file of ['adapter.mjs', 'package.json'])
      await fs.copyFile(path.join(repo, 'samples', 'AdapterSdkPreview', sample, file), path.join(author, sample, file));
  }
  const built = spawnSync(process.execPath, [path.join(author, 'build.mjs')], { encoding: 'utf8', windowsHide: true });
  assert.equal(built.status, 0, built.stderr);
  await assert.rejects(fs.stat(path.join(root, 'extension')), { code: 'ENOENT' });
  for (const sample of ['action', 'editor']) {
    const directory = path.join(author, sample, 'bin');
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'adapter-package.json'), 'utf8'));
    assert.equal(validateAdapterPackage(manifest).ok, true);
    for (const file of manifest.integrity.files)
      assert.equal(createHash('sha256').update(await fs.readFile(path.join(directory, file.path))).digest('hex'), file.sha256);
    const request = input => ({ protocolId: 'winforms-designer.adapter-stdio', protocolVersion: 1, id: 'author-test',
      operation: sample === 'action' ? 'invokeAction' : 'editProperty',
      contributionId: sample === 'action' ? 'sample.set-caption' : 'sample.caption-editor',
      context: { componentId: 'button1', propertyName: 'Text', propertyType: 'System.String', invariantValue: 'Before', revision: 1 }, input });
    const run = req => {
      const child = spawnSync(process.execPath, [path.join(directory, 'adapter.mjs')], {
        input: `${JSON.stringify(req)}\n`, encoding: 'utf8', timeout: 5000, windowsHide: true,
      });
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.stderr, '');
      const result = JSON.parse(child.stdout);
      assert.equal(validateAdapterResponse(result, req, manifest.contributions[sample === 'action' ? 'actions' : 'editors'][0]).ok, true);
      return result;
    };
    const success = run(request({ invariantValue: sample === 'action' ? 'Author action' : 'SDK editor caption' }));
    assert.equal(success.status, 'ok'); assert.equal(success.intent.propertyType, 'System.String');
    assert.equal(run(request({ cancel: true })).status, 'cancelled');
    assert.equal(run(request({ invariantValue: 'REFUSE' })).status, 'refused');
    const unknown = request({}); unknown.contributionId = 'other.contribution';
    assert.equal(run(unknown).status, 'refused');
  }
});
