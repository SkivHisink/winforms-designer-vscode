import * as fs from 'node:fs';
import * as path from 'node:path';
import { atomicWriteLocalFile, durableDeleteLocalFile } from './atomicFile';
import { runDesignerResourceTransaction } from './resourceTransactionCoordinator';
import { TransactionCrashPoint } from './transactionRunner';

interface CrashChildConfig {
  workspaceRoot: string;
  journalRoot: string;
  transactionId: string;
  crashPoint: TransactionCrashPoint;
  crashOccurrence: number;
  targets: Array<{ filePath: string; before: string | null; after: string; bom: boolean }>;
}

async function readBytes(filePath: string): Promise<Uint8Array | null> {
  try { return await fs.promises.readFile(filePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (!raw) throw new Error('missing crash child config');
  const config = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as CrashChildConfig;
  let occurrences = 0;
  await runDesignerResourceTransaction({
    label: 'real process crash recovery proof',
    workspaceRoot: config.workspaceRoot,
    journalRoot: config.journalRoot,
    transactionId: config.transactionId,
    targets: config.targets,
    readBytes,
    writeBytes: async (filePath, bytes) => {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await atomicWriteLocalFile(filePath, bytes);
    },
    deleteFile: durableDeleteLocalFile,
    registerUndo: () => true,
    crashHook: async (point) => {
      if (point !== config.crashPoint || ++occurrences !== config.crashOccurrence) return;
      process.send?.({ type: 'crash-point-ready', point, occurrence: occurrences });
      // The parent calls TerminateProcess/kill while this await keeps the real transaction stack suspended at the
      // requested boundary. No exception/catch compensation runs in this child.
      await new Promise<void>(() => { /* killed by parent */ });
    },
  });
  throw new Error(`transaction completed without reaching ${config.crashPoint} #${config.crashOccurrence}`);
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
