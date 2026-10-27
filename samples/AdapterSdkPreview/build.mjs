import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateAdapterPackage, SDK_VERSION } from '../../adapter-sdk/index.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const sdk = path.resolve(root, '../../adapter-sdk');
const requested = process.argv.find(arg => arg.startsWith('--sample='))?.slice(9);
if (requested && !['action', 'editor'].includes(requested)) throw new Error('Unknown sample.');
for (const sample of requested ? [requested] : ['action', 'editor']) {
  const directory = path.join(root, sample, 'bin');
  await fs.mkdir(directory, { recursive: true });
  await fs.copyFile(path.join(root, sample, 'adapter.mjs'), path.join(directory, 'adapter.mjs'));
  await fs.copyFile(path.join(sdk, 'index.mjs'), path.join(directory, 'sdk.mjs'));
  const files = [];
  for (const name of ['adapter.mjs', 'sdk.mjs']) {
    const bytes = await fs.readFile(path.join(directory, name));
    files.push({ path: name, sha256: createHash('sha256').update(bytes).digest('hex') });
    const syntax = spawnSync(process.execPath, ['--check', path.join(directory, name)], { stdio: 'inherit', windowsHide: true });
    if (syntax.error || syntax.status !== 0) throw syntax.error ?? new Error('Adapter syntax is invalid.');
  }
  const contribution = { id: sample === 'action' ? 'sample.set-caption' : 'sample.caption-editor',
    title: sample === 'action' ? 'Set caption with sample adapter' : 'Choose caption with sample adapter',
    propertyName: 'Text', propertyType: 'System.String' };
  const manifest = {
    schemaId: 'winforms-designer.adapter-package', schemaVersion: 1, sdkVersion: SDK_VERSION,
    adapter: { id: `samples.sdk.${sample}`, version: '0.1.0', displayName: `SDK Preview ${sample} sample` },
    cohort: { productId: 'winforms-designer-vscode', minProductVersion: '2.3.0', maxProductVersionExclusive: '2.4.0',
      runtimes: ['modern', 'net48'], architectures: ['x64', 'arm64'] },
    execution: { kind: 'node-stdio', entrypoint: 'adapter.mjs' }, integrity: { algorithm: 'sha256', files },
    provenance: { policy: 'local-development', certification: 'none' },
    capabilities: [sample === 'action' ? 'action.set-property' : 'editor.scalar'],
    requiredServices: sample === 'action' ? ['Transactions', 'ComponentChange'] : ['TypeResolution', 'PropertySerialization'],
    contributions: {
      actions: sample === 'action' ? [contribution] : [],
      editors: sample === 'editor' ? [{ ...contribution, presentation: 'dropdown', choices: ['SDK editor caption', 'Alternate caption', 'Original caption'] }] : [],
    },
  };
  const checked = validateAdapterPackage(manifest);
  if (!checked.ok) throw new Error(JSON.stringify(checked.diagnostics));
  await fs.writeFile(path.join(directory, 'adapter-package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${sample}: ${path.relative(root, directory)} (SDK ${SDK_VERSION})\n`);
}
