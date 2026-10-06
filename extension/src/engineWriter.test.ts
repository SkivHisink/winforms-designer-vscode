import { spawn } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import { expect, it, vi } from 'vitest';
import { guardEngineMessageWriter } from './engineWriter';

it('tears down a still-live physical child when the request writer fails and rejects all pending requests', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(new Error('BROKEN_PIPE')); } });
  const input = new PassThrough(); const writer = new StreamMessageWriter(output);
  const connection = createMessageConnection(new StreamMessageReader(input), writer);
  const close = vi.fn(() => { connection.dispose(); output.destroy(); child.kill(); });
  guardEngineMessageWriter(writer, close); connection.listen();
  try {
    expect(child.exitCode).toBeNull();
    const requests = [connection.sendRequest('ordinary-rpc-a'), connection.sendRequest('ordinary-rpc-b')];
    const outcomes = await Promise.allSettled(requests);
    expect(outcomes.every((outcome) => outcome.status === 'rejected')).toBe(true);
    await exited;
    expect(close).toHaveBeenCalledOnce();
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  } finally { connection.dispose(); input.destroy(); output.destroy(); child.kill(); }
}, 10_000);
