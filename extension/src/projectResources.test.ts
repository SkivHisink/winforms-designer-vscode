import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { describe, expect, it } from 'vitest';
import {
  conventionalProjectResourcePair,
  isCanonicalProjectResourcePath,
  isProjectResourcePath,
  publishedProjectImagePropertyType,
  requestedProjectResourceAccessorRefusal,
} from './projectResources';

describe('project resource discovery boundary', () => {
  const root = path.resolve('C:/work/App');
  const form = path.join(root, 'Forms', 'Form1.Designer.cs');

  it('maps a conventional project resource to its adjacent generated accessor', () => {
    expect(conventionalProjectResourcePair(root, path.join(root, 'Properties', 'Resources.resx'), form)).toEqual({
      projectRoot: root,
      resxPath: path.join(root, 'Properties', 'Resources.resx'),
      designerPath: path.join(root, 'Properties', 'Resources.Designer.cs'),
      label: 'Properties/Resources.resx',
    });
  });

  it('refuses traversal, prefix lookalikes, and non-resx files', () => {
    expect(isProjectResourcePath(root, path.resolve('C:/work/AppElsewhere/Resources.resx'))).toBe(false);
    expect(conventionalProjectResourcePair(root, path.resolve(root, '..', 'outside.resx'), form)).toBeNull();
    expect(conventionalProjectResourcePair(root, path.join(root, 'Properties', 'Resources.txt'), form)).toBeNull();
  });

  it('does not mislabel the active form neutral or localized resource as a project resource', () => {
    expect(conventionalProjectResourcePair(root, path.join(root, 'Forms', 'Form1.resx'), form)).toBeNull();
    expect(conventionalProjectResourcePair(root, path.join(root, 'Forms', 'Form1.ru.resx'), form)).toBeNull();
  });

  it('uses only published writable image metadata, never a forged webview property type', () => {
    expect(publishedProjectImagePropertyType('Image', {
      name: 'Image', type: 'System.Drawing.Image', isImage: true, readOnly: false,
    })).toBe('System.Drawing.Image');
    expect(publishedProjectImagePropertyType('Tag', {
      name: 'Tag', type: 'System.String', isImage: false, readOnly: false,
    })).toBeNull();
    expect(publishedProjectImagePropertyType('Tag', {
      name: 'Image', type: 'System.Drawing.Image', isImage: true, readOnly: false,
    })).toBeNull();
  });

  it('V2-FND-001-S076 refuses punctuation and property-chain injection in a requested resource accessor', () => {
    expect(requestedProjectResourceAccessorRefusal('DemoApp.Properties.Resources.Logo')).toBeNull();
    expect(requestedProjectResourceAccessorRefusal('DemoApp.Properties.Resources;this.evil.Logo'))
      .toBe('invalid resource class name: DemoApp.Properties.Resources;this.evil');
    expect(requestedProjectResourceAccessorRefusal('DemoApp.Properties.Resources.Logo()'))
      .toBe('invalid resource property name: Logo()');
  });

  it('refuses a resource pair reached through a project-local junction to an outside directory', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wfd-resource-boundary-'));
    const project = path.join(temp, 'App');
    const outside = path.join(temp, 'Outside');
    const linked = path.join(project, 'Properties');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'Resources.resx'), '<root/>');
    fs.writeFileSync(path.join(outside, 'Resources.Designer.cs'), 'class Resources {}');
    fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      expect(await isCanonicalProjectResourcePath(project, path.join(linked, 'Resources.resx'))).toBe(false);
      expect(await isCanonicalProjectResourcePath(project, path.join(linked, 'Resources.Designer.cs'))).toBe(false);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
