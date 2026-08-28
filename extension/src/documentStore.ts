import * as crypto from 'node:crypto';
import * as fs from 'node:fs';

export type DocumentVersion = string | number;

export type EolKind = 'none' | 'lf' | 'crlf' | 'cr' | 'mixed';

export interface ArtifactSnapshot {
  target: string;
  exists: boolean;
  bom: boolean;
  bytesSha256: string | null;
  textSha256: string | null;
  text: string | null;
  byteLength: number | null;
  mtimeMs: number | null;
  documentVersion: DocumentVersion | null;
  eol: EolKind;
}

export interface SnapshotMetadata {
  mtimeMs?: number | null;
  documentVersion?: DocumentVersion | null;
}

export interface ArtifactFingerprint {
  exists: boolean;
  bom: boolean;
  bytesSha256: string | null;
  textSha256: string | null;
  byteLength: number | null;
  mtimeMs: number | null;
  documentVersion: DocumentVersion | null;
}

export type DocumentSaveDiagnostic =
  | 'NONE'
  | 'STALE_SOURCE'
  | 'DESTINATION_EXISTS';

export interface NoEditSaveEvaluation {
  accepted: boolean;
  dirty: boolean;
  diagnostic: DocumentSaveDiagnostic;
  writes: readonly never[];
}

export interface SaveAsPlan {
  accepted: boolean;
  diagnostic: DocumentSaveDiagnostic;
  destinations: readonly string[];
  collisions: readonly string[];
}

export interface HotExitUndoUnit {
  id: string;
  label: string;
  beforeTargetSha256: string;
  afterTargetSha256: string;
}

export interface HotExitDocumentState {
  documentId: string;
  dirty: boolean;
  textByTarget: Readonly<Record<string, string>>;
  undoUnits: readonly HotExitUndoUnit[];
  activeUndoIndex: number;
}

const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);

export function sha256Hex(data: string | Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function stripUtf8Bom(bytes: Uint8Array): { bom: boolean; text: string } {
  const buffer = Buffer.from(bytes);
  const bom = buffer.length >= utf8Bom.length && buffer.subarray(0, utf8Bom.length).equals(utf8Bom);
  return {
    bom,
    text: buffer.subarray(bom ? utf8Bom.length : 0).toString('utf8'),
  };
}

export function detectEol(text: string): EolKind {
  let lf = false;
  let crlf = false;
  let cr = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '\r' && text[i] !== '\n') continue;
    if (text[i] === '\r' && text[i + 1] === '\n') {
      crlf = true;
      i++;
    } else if (text[i] === '\r') {
      cr = true;
    } else {
      lf = true;
    }
  }
  const count = Number(lf) + Number(crlf) + Number(cr);
  if (count === 0) return 'none';
  if (count > 1) return 'mixed';
  if (crlf) return 'crlf';
  return cr ? 'cr' : 'lf';
}

export function snapshotMissingArtifact(target: string, metadata: SnapshotMetadata = {}): ArtifactSnapshot {
  return {
    target,
    exists: false,
    bom: false,
    bytesSha256: null,
    textSha256: null,
    text: null,
    byteLength: null,
    mtimeMs: metadata.mtimeMs ?? null,
    documentVersion: metadata.documentVersion ?? null,
    eol: 'none',
  };
}

export function snapshotArtifactBytes(
  target: string,
  bytes: Uint8Array | null,
  metadata: SnapshotMetadata = {},
): ArtifactSnapshot {
  if (bytes === null) return snapshotMissingArtifact(target, metadata);
  const buffer = Buffer.from(bytes);
  const stripped = stripUtf8Bom(buffer);
  return {
    target,
    exists: true,
    bom: stripped.bom,
    bytesSha256: sha256Hex(buffer),
    textSha256: sha256Hex(stripped.text),
    text: stripped.text,
    byteLength: buffer.byteLength,
    mtimeMs: metadata.mtimeMs ?? null,
    documentVersion: metadata.documentVersion ?? null,
    eol: detectEol(stripped.text),
  };
}

export async function readLocalArtifactSnapshot(
  target: string,
  metadata: Omit<SnapshotMetadata, 'mtimeMs'> = {},
): Promise<ArtifactSnapshot> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    // Bind the bytes and metadata to the same open file identity. A concurrent atomic replace may change the path
    // after open, but this snapshot remains internally coherent and the later path revalidation sees the replacement.
    // Reading the path and statting it concurrently can instead pair old bytes with the replacement's mtime/length.
    handle = await fs.promises.open(target, 'r');
    const before = await handle.stat();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error(`artifact changed while snapshotting: ${target}`);
    }
    return snapshotArtifactBytes(target, bytes, {
      mtimeMs: after.mtimeMs,
      documentVersion: metadata.documentVersion ?? null,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return snapshotMissingArtifact(target, {
        documentVersion: metadata.documentVersion ?? null,
      });
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

export function artifactFingerprint(snapshot: ArtifactSnapshot): ArtifactFingerprint {
  return {
    exists: snapshot.exists,
    bom: snapshot.bom,
    bytesSha256: snapshot.bytesSha256,
    textSha256: snapshot.textSha256,
    byteLength: snapshot.byteLength,
    mtimeMs: snapshot.mtimeMs,
    documentVersion: snapshot.documentVersion,
  };
}

export function sameArtifactFingerprint(left: ArtifactFingerprint, right: ArtifactFingerprint): boolean {
  return left.exists === right.exists
    && left.bom === right.bom
    && left.bytesSha256 === right.bytesSha256
    && left.textSha256 === right.textSha256
    && left.byteLength === right.byteLength
    && left.mtimeMs === right.mtimeMs
    && left.documentVersion === right.documentVersion;
}

/** @deprecated Contract-test helper; product save performs a stronger exact byte/BOM conflict check in CustomEditor. */
export function evaluateNoEditSave(
  baseline: ArtifactFingerprint,
  current: ArtifactFingerprint,
): NoEditSaveEvaluation {
  if (!sameArtifactFingerprint(baseline, current)) {
    return { accepted: false, dirty: true, diagnostic: 'STALE_SOURCE', writes: [] };
  }
  return { accepted: true, dirty: false, diagnostic: 'NONE', writes: [] };
}

/** Product Save As consumes this create-only aggregate collision plan before the journal captures exact target bytes. */
export function planWinFormsSaveAs(
  destinationNames: readonly string[],
  existingEntries: readonly string[],
): SaveAsPlan {
  const present = new Set(existingEntries.map((entry) => entry.toLocaleLowerCase('en-US')));
  const collisions = destinationNames.filter((name) => present.has(name.toLocaleLowerCase('en-US')));
  return {
    accepted: collisions.length === 0,
    diagnostic: collisions.length === 0 ? 'NONE' : 'DESTINATION_EXISTS',
    destinations: [...destinationNames],
    collisions,
  };
}

/**
 * @deprecated Harness-only state model. The shipped S003 product proof lives in the CustomEditor provider's real
 * two-process backup/reopen lifecycle, where one recovered disk-to-backup transition is registered as one native
 * Undo/Redo unit. This clone helper is not called by that path and does not serialize arbitrary native history.
 */
export function captureHotExitDocumentState(state: HotExitDocumentState): HotExitDocumentState {
  return cloneHotExitDocumentState(state);
}

/** @deprecated Harness-only counterpart to captureHotExitDocumentState; it is not called by the product provider. */
export function restoreHotExitDocumentState(state: HotExitDocumentState): HotExitDocumentState {
  return cloneHotExitDocumentState(state);
}

function cloneHotExitDocumentState(state: HotExitDocumentState): HotExitDocumentState {
  return {
    documentId: state.documentId,
    dirty: state.dirty,
    textByTarget: { ...state.textByTarget },
    undoUnits: state.undoUnits.map((unit) => ({ ...unit })),
    activeUndoIndex: state.activeUndoIndex,
  };
}
