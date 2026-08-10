/** Complete bytes-relevant state of one .resx file. `text:null` means the file does not exist. */
export interface ResourceFileState {
  text: string | null;
  bom: boolean;
}

export interface ResourceFileTransition<T> {
  target: T;
  before: ResourceFileState;
  after: ResourceFileState;
}

export interface ResourceTransactionIo<T> {
  read(target: T): Promise<ResourceFileState>;
  write(target: T, state: ResourceFileState): Promise<void>;
  /** Stable identity used both for duplicate rejection and actionable errors. */
  describe(target: T): string;
}

export type ResourceTransitionDirection = 'forward' | 'undo' | 'redo';

export function sameResourceState(left: ResourceFileState, right: ResourceFileState): boolean {
  if (left.text === null || right.text === null) return left.text === right.text;
  return left.text === right.text && left.bom === right.bom;
}

/**
 * Strongest set-level transaction available over VS Code's non-transactional filesystem API:
 *
 * 1. reject duplicate targets;
 * 2. preflight every exact source state before any write;
 * 3. write each target;
 * 4. if a write fails, compensate already-written targets in reverse order, but only when each still contains the
 *    bytes this transition wrote (never overwrite a concurrent external edit).
 */
export async function transitionResourceSetAtomic<T>(
  transitions: readonly ResourceFileTransition<T>[],
  direction: ResourceTransitionDirection,
  io: ResourceTransactionIo<T>,
): Promise<void> {
  if (!transitions.length) return;
  const fromAfter = direction === 'undo';
  const source = (tx: ResourceFileTransition<T>): ResourceFileState => fromAfter ? tx.after : tx.before;
  const target = (tx: ResourceFileTransition<T>): ResourceFileState => fromAfter ? tx.before : tx.after;

  const seen = new Set<string>();
  for (const tx of transitions) {
    const name = io.describe(tx.target);
    if (seen.has(name)) throw new Error(`resource transaction has duplicate target: ${name}`);
    seen.add(name);
    if (!sameResourceState(await io.read(tx.target), source(tx)))
      throw new Error(`resource transaction conflict: ${name} changed on disk`);
  }

  const applied: Array<ResourceFileTransition<T>> = [];
  try {
    for (const tx of transitions) {
      // Close the window between the set-wide preflight and this target as far as the filesystem API permits. There is
      // no compare-and-swap write in vscode.workspace.fs, so this is still optimistic concurrency, but an edit that
      // lands while earlier targets are being written is detected before this target is replaced.
      const name = io.describe(tx.target);
      if (!sameResourceState(await io.read(tx.target), source(tx)))
        throw new Error(`resource transaction conflict: ${name} changed before write`);
      await io.write(tx.target, target(tx));
      applied.push(tx);
    }
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const tx of applied.reverse()) {
      const name = io.describe(tx.target);
      try {
        if (!sameResourceState(await io.read(tx.target), target(tx))) {
          rollbackFailures.push(`${name} changed during rollback`);
          continue;
        }
        await io.write(tx.target, source(tx));
      } catch (rollbackError) {
        rollbackFailures.push(`${name}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    const suffix = rollbackFailures.length ? `; compensation incomplete: ${rollbackFailures.join(', ')}` : '';
    throw new Error(`${message}${suffix}`);
  }
}
