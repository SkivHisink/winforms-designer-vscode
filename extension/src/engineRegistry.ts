import { currentEngineRequestContext, engineWorkerKey } from './engineRequestContext';
import { WorkerKey, WorkerRuntime, workerKeyId } from './workerSelection';

/** Preserve runtime-facing lifecycle callers while keeping incompatible project workers separate. */
export class EngineRegistry<T> {
  private readonly slots = new Map<string, { kind: WorkerRuntime; value: T }>();
  private readonly lastUsed = new Map<WorkerRuntime, string>();

  get size(): number { return this.slots.size; }
  get(kind: WorkerRuntime): T | undefined {
    if (currentEngineRequestContext()) {
      const id = workerKeyId(engineWorkerKey(kind));
      const slot = this.slots.get(id);
      if (slot) this.lastUsed.set(kind, id);
      return slot?.value;
    }
    const recent = this.lastUsed.get(kind);
    if (recent && this.slots.has(recent)) return this.slots.get(recent)?.value;
    return [...this.slots.values()].reverse().find((slot) => slot.kind === kind)?.value;
  }
  set(kind: WorkerRuntime, value: T, key: WorkerKey = engineWorkerKey(kind)): this {
    const id = workerKeyId(key);
    this.slots.set(id, { kind, value });
    this.lastUsed.set(kind, id);
    return this;
  }
  has(kind: WorkerRuntime): boolean { return this.get(kind) !== undefined; }
  delete(kind: WorkerRuntime): boolean {
    const value = this.get(kind);
    return value === undefined ? false : this.deleteValue(value);
  }
  deleteValue(value: T): boolean {
    for (const [id, slot] of this.slots) if (slot.value === value) return this.slots.delete(id);
    return false;
  }
  clear(): void { this.slots.clear(); this.lastUsed.clear(); }
  *values(): IterableIterator<T> { for (const slot of this.slots.values()) yield slot.value; }
  *entries(): IterableIterator<[WorkerRuntime, T]> {
    for (const slot of this.slots.values()) yield [slot.kind, slot.value];
  }
  forEach(callback: (value: T, kind: WorkerRuntime) => void): void {
    for (const slot of this.slots.values()) callback(slot.value, slot.kind);
  }
}
