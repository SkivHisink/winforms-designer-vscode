export interface DocumentSaveImage { text: string; hadBom: boolean; }

export class DocumentSaveBaselineError extends Error {
  constructor(readonly code: 'COMPANION_CHANGED' | 'GENERATED_BASELINE_MISSING') {
    super(code);
  }
}

/** A missing new generated file is permitted only after every required companion has been verified. The first
 * rejection of Promise.all cannot establish that: it can hide a later missing companion or a successful stale read. */
export async function readDocumentSaveBaselines(
  generatedRead: Promise<DocumentSaveImage>,
  companionReads: readonly { read: Promise<DocumentSaveImage>; expectedText: string }[],
  generatedExisted: boolean,
  isMissing: (error: unknown) => boolean,
): Promise<DocumentSaveImage | null> {
  const results = await Promise.allSettled([generatedRead, ...companionReads.map((companion) => companion.read)]);
  for (let index = 0; index < companionReads.length; index++) {
    const result = results[index + 1];
    if (result.status === 'rejected' || result.value.text !== companionReads[index].expectedText) {
      throw new DocumentSaveBaselineError('COMPANION_CHANGED');
    }
  }
  const generated = results[0];
  if (generated.status === 'fulfilled') return generated.value;
  if (!isMissing(generated.reason)) throw generated.reason;
  if (generatedExisted) throw new DocumentSaveBaselineError('GENERATED_BASELINE_MISSING');
  return null;
}
