import * as path from 'path';
import * as fs from 'fs';

/** A conventional strongly typed project-resource pair. The caller still verifies that both files exist and asks the
 * engine to cross-check the .resx metadata against the generated accessor source before showing any candidate. */
export interface ProjectResourceFilePair {
  projectRoot: string;
  resxPath: string;
  designerPath: string;
  label: string;
}

/** Minimal shape needed to authorize an image-resource command from the metadata most recently published by the
 * engine. The webview-supplied property type is deliberately absent: postMessage payloads are not an authority. */
export interface PublishedProjectImageProperty {
  name: string;
  type: string;
  readOnly?: boolean;
  isImage?: boolean;
}

const generatedResourceIdentifier = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** V2-FND-001-S076: validate the fully-qualified accessor returned by a resource picker before any project scan or engine edit.
 * The generated resource boundary intentionally uses the same conservative ASCII identifier alphabet as the engine:
 * Visual Studio's strongly typed resource generator emits this shape, while punctuation/property-chain injection is
 * refused early enough that even a compromised picker response cannot influence source text. */
export function requestedProjectResourceAccessorRefusal(accessor: string): string | null {
  const segments = accessor.split('.');
  if (segments.length < 2) return `invalid resource symbol: ${accessor}`;
  const propertyName = segments.pop() ?? '';
  const resourceClassFullName = segments.join('.');
  if (!segments.every((segment) => generatedResourceIdentifier.test(segment))) {
    return `invalid resource class name: ${resourceClassFullName}`;
  }
  if (!generatedResourceIdentifier.test(propertyName)) {
    return `invalid resource property name: ${propertyName}`;
  }
  return null;
}

/** Return the engine-published target type only for a writable image/icon property with the exact requested name. */
export function publishedProjectImagePropertyType(
  requestedProperty: string,
  published: PublishedProjectImageProperty | null | undefined,
): string | null {
  if (!published || published.name !== requestedProperty || published.readOnly || published.isImage !== true) return null;
  return published.type === 'System.Drawing.Image'
    || published.type === 'System.Drawing.Bitmap'
    || published.type === 'System.Drawing.Icon'
    ? published.type
    : null;
}

function normalized(p: string): string {
  // The extension is Windows-only. Case-folding here also makes a differently-cased VS Code URI incapable of
  // bypassing the project/current-form bounds.
  return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
}

/** True only for a descendant of `root` (not the root itself). Kept pure for traversal-boundary tests. */
export function isProjectResourcePath(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const rel = path.relative(resolvedRoot, resolvedCandidate);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

/**
 * Canonical containment check for a discovered resource input. The project root itself may be reached through a
 * workspace junction, but a reparse point below that root is refused: the candidate's real path must equal the path
 * obtained by applying its lexical project-relative path to the real project root. This closes parent-directory
 * symlink/junction escapes that a final-file stat cannot see.
 */
export async function isCanonicalProjectResourcePath(root: string, candidate: string): Promise<boolean> {
  if (!isProjectResourcePath(root, candidate)) return false;
  try {
    const lexicalRoot = path.resolve(root);
    const lexicalCandidate = path.resolve(candidate);
    const relative = path.relative(lexicalRoot, lexicalCandidate);
    const [realRoot, realCandidate] = await Promise.all([
      fs.promises.realpath(lexicalRoot),
      fs.promises.realpath(lexicalCandidate),
    ]);
    if (!isProjectResourcePath(realRoot, realCandidate)) return false;
    return normalized(realCandidate) === normalized(path.resolve(realRoot, relative));
  } catch {
    return false;
  }
}

/**
 * Map a discovered project `.resx` to the conventional adjacent strongly typed output (`Foo.Designer.cs`).
 * This deliberately does not guess custom generator outputs or follow a ResXFileRef value. Unsupported/custom
 * layouts simply produce no pair; the engine is the final authority for every pair that does pass.
 */
export function conventionalProjectResourcePair(
  projectRoot: string,
  resxPath: string,
  currentFormDesignerPath: string,
): ProjectResourceFilePair | null {
  if (!/\.resx$/i.test(resxPath)) return null;
  if (!isProjectResourcePath(projectRoot, resxPath)) return null;

  const stem = resxPath.slice(0, -'.resx'.length);
  const designerPath = stem + '.Designer.cs';
  if (!isProjectResourcePath(projectRoot, designerPath)) return null;

  // Never offer the active form's own neutral/localized resources as a "project resource". Import/Clear already own
  // those files, and treating Form1.resx + Form1.Designer.cs as a generated resource class would be misleading.
  const formStem = currentFormDesignerPath.replace(/\.Designer\.cs$/i, '');
  const resourceStem = normalized(stem);
  const currentStem = normalized(formStem);
  if (resourceStem === currentStem || resourceStem.startsWith(currentStem + '.')) return null;

  return {
    projectRoot: path.resolve(projectRoot),
    resxPath: path.resolve(resxPath),
    designerPath: path.resolve(designerPath),
    label: path.relative(path.resolve(projectRoot), path.resolve(resxPath)).replace(/\\/g, '/'),
  };
}
