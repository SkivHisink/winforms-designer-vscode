import type { MessageWriter } from 'vscode-jsonrpc';

/** Absorb the writer's duplicate internal rejection only after tearing down its physical owner. */
export function guardEngineMessageWriter(writer: MessageWriter, closePhysicalOwner: () => void): void {
  const write = writer.write.bind(writer);
  let failed = false;
  writer.write = async (message) => {
    try { await write(message); }
    catch {
      if (failed) return;
      failed = true;
      closePhysicalOwner();
    }
  };
}
