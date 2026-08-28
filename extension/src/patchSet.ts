import * as fs from 'node:fs';
import * as path from 'node:path';
import { EolKind } from './documentStore';

export type PatchLane = 'A' | 'B';

export interface PatchSpan {
  start: number;
  length: number;
}

export interface OwnedRegion extends PatchSpan {
  id: string;
  target: string;
}

export interface PatchPreview {
  beforeSha256: string;
  afterSha256: string;
  summary: string;
}

export interface TextPreservationMetadata {
  beforeBom: boolean;
  afterBom: boolean;
  beforeEol: EolKind;
  afterEol: EolKind;
  allowBomChange?: boolean;
  allowEolChange?: boolean;
}

export type PatchOperationKind =
  | 'replaceTextSpan'
  | 'replaceOwnedText'
  | 'writeResourceText'
  | 'createFile'
  | 'deleteFile';

export interface PatchOperation {
  kind: PatchOperationKind;
  target: string;
  span?: PatchSpan;
  preview?: PatchPreview;
  ownedRegionId?: string;
  preservation?: TextPreservationMetadata;
}

export interface PatchSet {
  id: string;
  lane: PatchLane;
  workspaceRoot: string;
  operations: readonly PatchOperation[];
  ownedRegions?: readonly OwnedRegion[];
}

export interface PatchSetValidationResult {
  ok: boolean;
  errors: string[];
  normalizedTargets: string[];
}

interface NormalizedOperation {
  operation: PatchOperation;
  target: string;
  wholeTarget: boolean;
  start: number;
  end: number;
}

function isSafeRelativePath(candidate: string): boolean {
  if (!candidate || path.isAbsolute(candidate)) return false;
  const parts = candidate.split(/[\\/]+/);
  return !parts.some((part) => part === '..' || part === '');
}

function normalizeInsideRoot(root: string, target: string): string | null {
  if (!path.isAbsolute(root)) return null;
  if (!isSafeRelativePath(target)) return null;
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolvedTarget;
}

function normalizeSpan(span: PatchSpan | undefined): { wholeTarget: boolean; start: number; end: number } | string {
  if (!span) return { wholeTarget: true, start: 0, end: Number.POSITIVE_INFINITY };
  if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.length) || span.start < 0 || span.length < 0) {
    return 'span must use non-negative safe integers';
  }
  const end = span.start + span.length;
  if (!Number.isSafeInteger(end)) return 'span end exceeds the safe integer range';
  return { wholeTarget: false, start: span.start, end };
}

function containsSpan(region: OwnedRegion, op: NormalizedOperation): boolean {
  if (op.wholeTarget) return false;
  return region.start <= op.start && op.end <= region.start + region.length;
}

function validatePreservation(op: PatchOperation, index: number, errors: string[]): void {
  const preservation = op.preservation;
  if (!preservation) {
    errors.push(`operation ${index} missing BOM/EOL preservation metadata`);
    return;
  }
  if (preservation.beforeBom !== preservation.afterBom && !preservation.allowBomChange) {
    errors.push(`operation ${index} changes BOM without allowBomChange`);
  }
  if (
    preservation.beforeEol !== 'none'
    && preservation.afterEol !== 'none'
    && preservation.beforeEol !== preservation.afterEol
    && !preservation.allowEolChange
  ) {
    errors.push(`operation ${index} changes EOL without allowEolChange`);
  }
}

export function validatePatchSet(patchSet: PatchSet): PatchSetValidationResult {
  const errors: string[] = [];
  const normalized: NormalizedOperation[] = [];

  const root = path.isAbsolute(patchSet.workspaceRoot) ? path.resolve(patchSet.workspaceRoot) : '';
  if (!root) errors.push('workspaceRoot must be absolute');
  if (!patchSet.id || patchSet.id.length > 128) errors.push('patchSet id must contain 1-128 characters');
  if (patchSet.operations.length === 0 || patchSet.operations.length > 256) {
    errors.push('PatchSet must contain 1-256 operations');
  }

  patchSet.operations.forEach((operation, index) => {
    if (operation.target.length > 1024) {
      errors.push(`operation ${index} target exceeds 1024 characters`);
      return;
    }
    const target = root ? normalizeInsideRoot(root, operation.target) : null;
    if (!target) {
      errors.push(`operation ${index} target is outside workspace root: ${operation.target}`);
      return;
    }
    const span = normalizeSpan(operation.span);
    if (typeof span === 'string') {
      errors.push(`operation ${index} ${span}`);
      return;
    }
    const spanKind = operation.kind === 'replaceTextSpan' || operation.kind === 'replaceOwnedText';
    if (spanKind !== !span.wholeTarget) {
      errors.push(`operation ${index} kind/span shape is inconsistent`);
      return;
    }
    if (patchSet.lane === 'A' && operation.kind === 'replaceOwnedText') {
      errors.push(`operation ${index} uses a Lane B operation kind in Lane A`);
    }
    if (patchSet.lane === 'B' && operation.kind !== 'replaceOwnedText') {
      errors.push(`Lane B operation ${index} must be replaceOwnedText`);
    }
    validatePreservation(operation, index, errors);
    normalized.push({ operation, target, ...span });
  });

  const byTarget = new Map<string, NormalizedOperation[]>();
  for (const op of normalized) {
    const key = process.platform === 'win32' ? op.target.toLowerCase() : op.target;
    const group = byTarget.get(key);
    if (group) group.push(op);
    else byTarget.set(key, [op]);
  }

  for (const ops of byTarget.values()) {
    const whole = ops.filter((op) => op.wholeTarget);
    if (whole.length > 1 || (whole.length === 1 && ops.length > 1)) {
      errors.push(`duplicate whole-target patch: ${ops[0].operation.target}`);
      continue;
    }
    const spans = ops.filter((op) => !op.wholeTarget).sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < spans.length; i++) {
      if (spans[i].start < spans[i - 1].end) {
        errors.push(`overlapping patch spans: ${spans[i - 1].operation.target}`);
        break;
      }
    }
  }

  if (patchSet.lane === 'B') {
    const regionById = new Map<string, OwnedRegion>();
    for (const region of patchSet.ownedRegions ?? []) {
      const target = root ? normalizeInsideRoot(root, region.target) : null;
      const span = normalizeSpan(region);
      if (!region.id || region.id.length > 128 || regionById.has(region.id)) {
        errors.push(`Lane B owned region id is empty, too long, or duplicated: ${region.id}`);
        continue;
      }
      if (!target || typeof span === 'string' || span.wholeTarget) {
        errors.push(`Lane B owned region is invalid: ${region.id}`);
        continue;
      }
      regionById.set(region.id, { ...region, target });
    }

    normalized.forEach((op, index) => {
      const preview = op.operation.preview;
      const sha256 = /^[0-9a-f]{64}$/i;
      if (!preview || !sha256.test(preview.beforeSha256) || !sha256.test(preview.afterSha256)
        || !preview.summary || preview.summary.length > 512) {
        errors.push(`Lane B operation ${index} missing preview`);
      }
      const id = op.operation.ownedRegionId;
      const region = id ? regionById.get(id) : undefined;
      const sameTarget = region && (process.platform === 'win32'
        ? region.target.toLowerCase() === op.target.toLowerCase()
        : region.target === op.target);
      if (!region || !sameTarget || !containsSpan(region, op)) {
        errors.push(`Lane B operation ${index} is outside an owned region`);
      }
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    normalizedTargets: Array.from(new Set(normalized.map((op) => op.target))),
  };
}

export async function authorizePatchSetTargets(patchSet: PatchSet): Promise<PatchSetValidationResult> {
  const validation = validatePatchSet(patchSet);
  if (!validation.ok) return validation;

  const errors: string[] = [];
  const lexicalRoot = path.resolve(patchSet.workspaceRoot);
  let realRoot: string;
  try {
    realRoot = await fs.promises.realpath(lexicalRoot);
  } catch (error) {
    errors.push(`workspaceRoot cannot be resolved: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`);
    return { ...validation, ok: false, errors };
  }

  for (const normalizedTarget of validation.normalizedTargets) {
    const relative = path.relative(lexicalRoot, normalizedTarget);
    let current = realRoot;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      try {
        const stat = await fs.promises.lstat(current);
        if (stat.isSymbolicLink()) {
          errors.push(`target crosses a symbolic link or junction: ${relative}`);
          break;
        }
        const resolved = await fs.promises.realpath(current);
        if (!isInsideOrSame(realRoot, resolved)) {
          errors.push(`target resolves outside workspace root: ${relative}`);
          break;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        errors.push(`target authorization failed for ${relative}: ${(error as NodeJS.ErrnoException).code ?? 'unknown'}`);
        break;
      }
    }
  }

  return { ...validation, ok: errors.length === 0, errors };
}

function isInsideOrSame(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  if (process.platform === 'win32') {
    const normalized = relative.toLowerCase();
    return normalized === '' || (!normalized.startsWith('..') && !path.isAbsolute(normalized));
  }
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function assertValidPatchSet(patchSet: PatchSet): void {
  const result = validatePatchSet(patchSet);
  if (!result.ok) throw new Error(result.errors.join('; '));
}

export async function assertAuthorizedPatchSetTargets(patchSet: PatchSet): Promise<void> {
  const result = await authorizePatchSetTargets(patchSet);
  if (!result.ok) throw new Error(result.errors.join('; '));
}
