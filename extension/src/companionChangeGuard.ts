interface PendingCompanionChange {
  documentKey: string;
  version: number;
  after: string;
  observed: boolean;
  invalidated: boolean;
}

/** Only an exact notification produced by the currently awaited code-buffer edit may keep the previous render's
 * authority. A different image or version still invalidates it immediately, including an interleaved manual edit. */
export class CompanionChangeGuard {
  private readonly pending = new Map<string, PendingCompanionChange>();

  begin(documentKey: string, beforeVersion: number, after: string): () => void {
    if (this.pending.has(documentKey)) throw new Error('another companion buffer transition is already pending');
    const change = { documentKey, version: beforeVersion + 1, after, observed: false, invalidated: false };
    this.pending.set(documentKey, change);
    return () => { if (this.pending.get(documentKey) === change) this.pending.delete(documentKey); };
  }

  isOwnChange(documentKey: string, version: number, text: string): boolean {
    const change = this.pending.get(documentKey);
    if (!change || change.invalidated || change.observed) return false;
    if (change.version !== version || change.after !== text) {
      change.invalidated = true;
      return false;
    }
    change.observed = true;
    return true;
  }
}
