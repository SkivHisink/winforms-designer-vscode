import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { formSiblingsToDelete } from './formSiblings';

/** Callbacks and worker objects are deliberately absent from the durable document format. */
export interface DocumentHistoryArtifact {
  target: string;
  before: string | null;
  after: string | null;
  bom: boolean;
  storage: 'disk' | 'editor';
}

export interface DocumentHistoryEdit {
  label: string;
  before: string;
  after: string;
  linkedArtifacts: readonly DocumentHistoryArtifact[];
  beforeEventAuthorized?: boolean;
  afterEventAuthorized?: boolean;
  sourceOnDisk?: boolean;
}

export interface DocumentHistoryUnit extends DocumentHistoryEdit {
  id: string;
  sha256: string;
}

export interface SerializedDocumentHistory {
  format: 'winforms-designer-history-v1';
  documentId: string;
  root: string;
  currentSourceSha256: string;
  savedSourceSha256: string;
  baseSource: string;
  activeIndex: number;
  checkpointIndex: number | null;
  units: DocumentHistoryUnit[];
  editorCheckpoints?: DocumentHistoryArtifact[];
  sha256: string;
}

export const DOCUMENT_HISTORY_LIMIT = 20;
export const DOCUMENT_HISTORY_MAX_BYTES = 16 * 1024 * 1024;
export const DOCUMENT_HISTORY_EDITOR_MAX_BYTES = 8 * 1024 * 1024;
export const DOCUMENT_HISTORY_BACKUP_MAX_BYTES = 64 * 1024 * 1024;
export interface DocumentHistoryCheckpoint { operationId: string | null; generation: number; }
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const key = (value: string): string => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const signed = <T extends object>(value: T): T & { sha256: string } => ({ ...value, sha256: digest(JSON.stringify(value)) });

function verifySignature(value: Record<string, unknown>): boolean {
  const { sha256, ...payload } = value;
  return typeof sha256 === 'string' && sha256 === digest(JSON.stringify(payload));
}

/** Durable targets stay inside the captured workspace and may only name the source/resource/project formats owned
 * by designer transactions. A damaged sidecar must never turn history replay into an arbitrary file writer. */
export function validDocumentHistoryTarget(root: string, target: string): boolean {
  if (!path.isAbsolute(root) || !path.isAbsolute(target)) return false;
  const relative = path.relative(key(root), key(target));
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    && !relative.split(/[\\/]/).some((part) => part.toLowerCase() === 'secrets')
    && /\.(?:cs|resx|csproj|projitems)$/i.test(target);
}

/** Checksums detect corruption, not provenance. Automatic restore only owns this form's conventional files.
 * Broader event companions and project edits require a fresh ownership proof, and remain a manual decision. */
export function ownedDocumentHistoryArtifact(documentId: string, artifact: DocumentHistoryArtifact): boolean {
  const main = documentId.replace(/\.Designer\.cs$/i, '.cs');
  if (artifact.storage === 'editor') return key(artifact.target) === key(main);
  return key(path.dirname(artifact.target)) === key(path.dirname(main))
    && formSiblingsToDelete(main, [path.basename(artifact.target)]).length === 1;
}

/** Bounded logical history independent of the workbench's process-local edit stack. Indexes count applied units. */
export class DocumentHistory {
  private units: DocumentHistoryUnit[] = [];
  private activeIndex = 0;
  private checkpointIndex: number | null = 0;
  private baseSource: string;
  private generation = 0;
  private editorCheckpoints = new Map<string, DocumentHistoryArtifact>();

  constructor(readonly documentId: string, readonly root: string, initialSource: string) {
    this.baseSource = initialSource;
  }

  get state(): { length: number; activeIndex: number; checkpointIndex: number | null; retainedRedoCount: number } {
    return { length: this.units.length, activeIndex: this.activeIndex, checkpointIndex: this.checkpointIndex,
      retainedRedoCount: this.units.length - this.activeIndex };
  }
  get dirty(): boolean { return this.checkpointIndex === null || this.checkpointIndex !== this.activeIndex; }
  get currentSource(): string { return this.activeIndex ? this.units[this.activeIndex - 1].after : this.baseSource; }
  get checkpointToken(): DocumentHistoryCheckpoint {
    return { operationId: this.activeIndex ? this.units[this.activeIndex - 1].id : null, generation: this.generation };
  }
  contains(id: string): boolean { return this.units.some((unit) => unit.id === id); }
  get appliedUnits(): readonly DocumentHistoryUnit[] { return clone(this.units.slice(0, this.activeIndex)); }
  get editorImages(): readonly DocumentHistoryArtifact[] { return clone([...this.editorCheckpoints.values()]); }
  operation(direction: 'undo' | 'redo'): DocumentHistoryUnit | undefined {
    const unit = this.units[direction === 'undo' ? this.activeIndex - 1 : this.activeIndex];
    return unit ? clone(unit) : undefined;
  }
  get timeline(): readonly { id: string; label: string; applied: boolean }[] {
    return this.units.map((unit, index) => ({ id: unit.id, label: unit.label, applied: index < this.activeIndex }));
  }

  record(edit: DocumentHistoryEdit): string {
    if (edit.before !== this.currentSource) throw new Error('document history source is stale');
    const seen = new Set<string>();
    for (const artifact of edit.linkedArtifacts) {
      if (!validDocumentHistoryTarget(this.root, artifact.target) || seen.has(key(artifact.target))) {
        throw new Error('document history target is outside its ownership boundary or duplicated');
      }
      seen.add(key(artifact.target));
    }
    if (this.checkpointIndex !== null && this.checkpointIndex > this.activeIndex) this.checkpointIndex = null;
    this.units = this.units.slice(0, this.activeIndex);
    const unit = signed({ ...clone(edit), id: randomUUID() });
    this.units.push(unit);
    for (const artifact of unit.linkedArtifacts) if (artifact.storage === 'editor') {
      const previous = this.editorCheckpoints.get(key(artifact.target));
      this.editorCheckpoints.set(key(artifact.target), { ...artifact, before: previous?.before ?? artifact.before });
    }
    this.activeIndex++;
    this.trim();
    return unit.id;
  }

  private trim(): void {
    while (this.units.length > DOCUMENT_HISTORY_LIMIT || Buffer.byteLength(JSON.stringify(this.units), 'utf8') > DOCUMENT_HISTORY_MAX_BYTES) {
      // The newest oversized operation remains the current image, but is not advertised as replayable history.
      const removed = this.units.shift()!;
      this.baseSource = removed.after;
      this.generation++;
      this.activeIndex = Math.max(0, this.activeIndex - 1);
      this.checkpointIndex = this.checkpointIndex === null || this.checkpointIndex === 0 ? null : this.checkpointIndex - 1;
      if (!this.units.length) break;
    }
  }

  moved(id: string, direction: 'undo' | 'redo'): void {
    const index = direction === 'undo' ? this.activeIndex - 1 : this.activeIndex;
    if (this.units[index]?.id !== id) throw new Error('document history operation order is stale');
    for (const artifact of this.units[index].linkedArtifacts) if (artifact.storage === 'editor') {
      const previous = this.editorCheckpoints.get(key(artifact.target));
      this.editorCheckpoints.set(key(artifact.target), { ...artifact, before: previous?.before ?? artifact.before,
        after: direction === 'undo' ? artifact.before : artifact.after });
    }
    this.activeIndex += direction === 'undo' ? -1 : 1;
  }

  /** Native callbacks outlive the bounded backup window. Crossing that boundary must preserve their actual data,
   * rather than reject after a successful callback or pretend a retained checkpoint still describes it. */
  alignAfterNativeMove(id: string, direction: 'undo' | 'redo', source: string): void {
    const index = this.units.findIndex((unit) => unit.id === id);
    if (index < 0) { this.reset(source, false); return; }
    const desired = direction === 'undo' ? index : index + 1;
    if (this.activeIndex === desired) return;
    this.moved(id, direction);
  }

  checkpoint(source: string, token?: DocumentHistoryCheckpoint): void {
    if (!token) { if (source === this.currentSource) this.checkpointIndex = this.activeIndex; return; }
    const index = token.operationId === null ? token.generation === this.generation ? 0 : -1
      : this.units.findIndex((unit) => unit.id === token.operationId) + 1;
    const valid = index >= 0 && (token.operationId === null || index > 0);
    const atSource = index > 0 ? this.units[index - 1]?.after : this.baseSource;
    this.checkpointIndex = valid && atSource === source ? index : null;
  }

  reset(source: string, clean = true): void {
    this.baseSource = source; this.units = []; this.activeIndex = 0; this.checkpointIndex = clean ? 0 : null; this.generation++;
    if (clean) this.editorCheckpoints.clear();
  }

  /** A native saved marker cannot be imported through the public API. Restore its applied suffix, and retain the
   * older prefix and the pre-existing redo branch as data. A new Undo creates a normal native Redo after restore. */
  recoverableUnits(savedSource: string): readonly DocumentHistoryUnit[] {
    if (this.checkpointIndex !== null && this.checkpointIndex <= this.activeIndex) {
      const checkpointSource = this.checkpointIndex ? this.units[this.checkpointIndex - 1].after : this.baseSource;
      if (checkpointSource === savedSource) return clone(this.units.slice(this.checkpointIndex, this.activeIndex));
    }
    return clone(this.units.slice(0, this.activeIndex));
  }

  serialize(currentSource: string, savedSource: string, editorImages = this.editorImages): string {
    if (currentSource !== this.currentSource) throw new Error('document history does not match the current source');
    if (Buffer.byteLength(JSON.stringify(editorImages), 'utf8') > DOCUMENT_HISTORY_EDITOR_MAX_BYTES) throw new Error('current code-buffer checkpoints exceed the backup byte budget');
    const state = signed({ format: 'winforms-designer-history-v1' as const, documentId: this.documentId, root: this.root,
      currentSourceSha256: digest(currentSource), savedSourceSha256: digest(savedSource), baseSource: this.baseSource,
      activeIndex: this.activeIndex, checkpointIndex: this.checkpointIndex, units: this.units, editorCheckpoints: editorImages });
    const serialized = JSON.stringify(state);
    if (Buffer.byteLength(serialized, 'utf8') > DOCUMENT_HISTORY_BACKUP_MAX_BYTES) throw new Error('document history exceeds the total backup byte budget');
    return serialized;
  }

  static restore(serialized: string, documentId: string, root: string, currentSource: string, savedSource?: string): DocumentHistory {
    if (Buffer.byteLength(serialized, 'utf8') > DOCUMENT_HISTORY_BACKUP_MAX_BYTES) throw new Error('document history exceeds its byte limit');
    const value = JSON.parse(serialized) as SerializedDocumentHistory;
    if (!value || typeof value !== 'object' || !verifySignature(value as unknown as Record<string, unknown>)
      || value.format !== 'winforms-designer-history-v1' || value.documentId !== documentId || key(value.root) !== key(root)
      || value.currentSourceSha256 !== digest(currentSource) || typeof value.baseSource !== 'string'
      || typeof value.savedSourceSha256 !== 'string' || (savedSource !== undefined && value.savedSourceSha256 !== digest(savedSource))
      || !Array.isArray(value.units) || value.units.length > DOCUMENT_HISTORY_LIMIT
      || !Number.isInteger(value.activeIndex) || value.activeIndex < 0 || value.activeIndex > value.units.length
      || (value.checkpointIndex !== null && (!Number.isInteger(value.checkpointIndex) || value.checkpointIndex < 0 || value.checkpointIndex > value.units.length))) {
      throw new Error('document history is corrupt or belongs to another document');
    }
    let previousSource = value.baseSource;
    const ids = new Set<string>();
    for (const unit of value.units) {
      if (!unit || typeof unit !== 'object' || !verifySignature(unit as unknown as Record<string, unknown>)
        || typeof unit.id !== 'string' || ids.has(unit.id) || typeof unit.label !== 'string'
        || unit.before !== previousSource || typeof unit.after !== 'string' || !Array.isArray(unit.linkedArtifacts)
        || (unit.beforeEventAuthorized !== undefined && typeof unit.beforeEventAuthorized !== 'boolean')
        || (unit.afterEventAuthorized !== undefined && typeof unit.afterEventAuthorized !== 'boolean')
        || (unit.sourceOnDisk !== undefined && typeof unit.sourceOnDisk !== 'boolean')) throw new Error('document history operation is corrupt');
      ids.add(unit.id);
      const targets = new Set<string>();
      for (const artifact of unit.linkedArtifacts) {
        if (!artifact || typeof artifact.target !== 'string' || !validDocumentHistoryTarget(root, artifact.target)
          || targets.has(key(artifact.target)) || ![artifact.before, artifact.after].every((text) => text === null || typeof text === 'string')
          || typeof artifact.bom !== 'boolean' || !['disk', 'editor'].includes(artifact.storage)
          || (artifact.storage === 'editor' && (artifact.before === null || artifact.after === null))
          || !ownedDocumentHistoryArtifact(documentId, artifact)) throw new Error('document history artifact is corrupt or has no proven form ownership');
        targets.add(key(artifact.target));
      }
      const generated = unit.linkedArtifacts.find((artifact) => artifact.storage === 'disk' && /\.Designer\.cs$/i.test(artifact.target));
      if (!!unit.sourceOnDisk !== !!generated || (generated && generated.after !== unit.after)) throw new Error('document history generated source ownership is inconsistent');
      previousSource = unit.after;
    }
    const history = new DocumentHistory(documentId, root, value.baseSource);
    history.units = clone(value.units); history.activeIndex = value.activeIndex; history.checkpointIndex = value.checkpointIndex;
    const checkpoints = value.editorCheckpoints ?? [];
    if (!Array.isArray(checkpoints) || Buffer.byteLength(JSON.stringify(checkpoints), 'utf8') > DOCUMENT_HISTORY_EDITOR_MAX_BYTES) throw new Error('code-buffer checkpoints exceed their byte limit');
    for (const artifact of checkpoints) {
      if (!artifact || typeof artifact.target !== 'string' || !validDocumentHistoryTarget(root, artifact.target)
        || !ownedDocumentHistoryArtifact(documentId, artifact) || artifact.storage !== 'editor' || artifact.bom !== false
        || typeof artifact.before !== 'string' || typeof artifact.after !== 'string'
        || history.editorCheckpoints.has(key(artifact.target))) throw new Error('unowned or corrupt code-buffer checkpoint');
      history.editorCheckpoints.set(key(artifact.target), clone(artifact));
    }
    const retainedEditorStates = new Map<string, DocumentHistoryArtifact>();
    for (let index = 0; index < history.units.length; index++) for (const artifact of history.units[index].linkedArtifacts) {
      if (artifact.storage !== 'editor') continue;
      const previous = retainedEditorStates.get(key(artifact.target));
      retainedEditorStates.set(key(artifact.target), { ...artifact, before: previous?.before ?? artifact.before,
        after: index < history.activeIndex ? artifact.after : previous?.after ?? artifact.before });
    }
    for (const [target, expected] of retainedEditorStates) {
      const checkpoint = history.editorCheckpoints.get(target);
      if (value.editorCheckpoints === undefined) history.editorCheckpoints.set(target, expected);
      else if (!checkpoint || checkpoint.after !== expected.after) throw new Error('code-buffer checkpoint coverage or current image is inconsistent');
    }
    if (history.currentSource !== currentSource) throw new Error('document history cursor does not match its source');
    return history;
  }
}
