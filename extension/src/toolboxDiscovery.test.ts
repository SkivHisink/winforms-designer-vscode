import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { discoverProbeAssemblies, discoverRegisteredAssemblies, uniqueAssemblyPaths } from './toolboxDiscovery';

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
});
