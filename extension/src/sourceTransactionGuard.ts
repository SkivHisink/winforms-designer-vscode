export interface SourceTransactionImage {
  text: string | null;
  bom: boolean;
}

export interface SourceReadSnapshot {
  epoch: number;
  revision: number;
}

/** A generated-source watcher may see a journaled write before the owning document adopts it. Only exact images
 * owned by a pending transaction are exempt; scope boundaries invalidate reads of transient images. */
export class SourceTransactionGuard {
  private epoch = 0;
  private readonly pending = new Set<readonly SourceTransactionImage[]>();

  begin(images: readonly SourceTransactionImage[]): () => void {
    const owned = images.map((image) => ({ ...image }));
    this.pending.add(owned);
    this.invalidateReads();
    return () => { if (this.pending.delete(owned)) this.invalidateReads(); };
  }

  owns(image: SourceTransactionImage): boolean {
    return [...this.pending].some((images) => images.some((owned) =>
      owned.text === image.text && (image.text === null || owned.bom === image.bom)));
  }

  beginRead(revision: number): SourceReadSnapshot { return { epoch: ++this.epoch, revision }; }
  isLatest(read: SourceReadSnapshot): boolean { return read.epoch === this.epoch; }
  isCurrent(read: SourceReadSnapshot, revision: number): boolean {
    return this.isLatest(read) && read.revision === revision;
  }
  invalidateReads(): void { this.epoch++; }
}
