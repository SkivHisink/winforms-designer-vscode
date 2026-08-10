import { describe, expect, it } from 'vitest';
import { ResourceFileState, ResourceFileTransition, transitionResourceSetAtomic } from './resourceTransaction';

const state = (text: string | null, bom = false): ResourceFileState => ({ text, bom });

function memoryIo(initial: Record<string, ResourceFileState>) {
  const files = new Map(Object.entries(initial).map(([key, value]) => [key, { ...value }]));
  const writes: string[] = [];
  return {
    files,
    writes,
    io: {
      read: async (target: string) => ({ ...(files.get(target) ?? state(null)) }),
      write: async (target: string, value: ResourceFileState) => {
        writes.push(target);
        files.set(target, { ...value });
      },
      describe: (target: string) => target,
    },
  };
}

describe('resource transaction', () => {
  const transitions: Array<ResourceFileTransition<string>> = [
    { target: 'Form.fr.resx', before: state('fr-before', true), after: state('fr-after', true) },
    { target: 'Form.ar.resx', before: state(null), after: state('ar-after') },
  ];

  it('moves the whole set forward, undo and redo including create/delete', async () => {
    const mem = memoryIo({ 'Form.fr.resx': state('fr-before', true) });
    await transitionResourceSetAtomic(transitions, 'forward', mem.io);
    expect(mem.files.get('Form.fr.resx')).toEqual(state('fr-after', true));
    expect(mem.files.get('Form.ar.resx')).toEqual(state('ar-after'));

    await transitionResourceSetAtomic(transitions, 'undo', mem.io);
    expect(mem.files.get('Form.fr.resx')).toEqual(state('fr-before', true));
    expect(mem.files.get('Form.ar.resx')).toEqual(state(null));

    await transitionResourceSetAtomic(transitions, 'redo', mem.io);
    expect(mem.files.get('Form.fr.resx')).toEqual(state('fr-after', true));
    expect(mem.files.get('Form.ar.resx')).toEqual(state('ar-after'));
  });

  it('preflights every file before writing and rejects duplicates', async () => {
    const conflict = memoryIo({
      'Form.fr.resx': state('fr-before', true),
      'Form.ar.resx': state('external'),
    });
    await expect(transitionResourceSetAtomic(transitions, 'forward', conflict.io)).rejects.toThrow('conflict');
    expect(conflict.writes).toEqual([]);

    const duplicate = memoryIo({ 'Form.fr.resx': state('fr-before', true) });
    await expect(transitionResourceSetAtomic([transitions[0], transitions[0]], 'forward', duplicate.io))
      .rejects.toThrow('duplicate target');
    expect(duplicate.writes).toEqual([]);
  });

  it('compensates the first file when the second write fails', async () => {
    const mem = memoryIo({ 'Form.fr.resx': state('fr-before', true) });
    const write = mem.io.write;
    mem.io.write = async (target, value) => {
      if (target === 'Form.ar.resx') throw new Error('disk full');
      await write(target, value);
    };
    await expect(transitionResourceSetAtomic(transitions, 'forward', mem.io)).rejects.toThrow('disk full');
    expect(mem.files.get('Form.fr.resx')).toEqual(state('fr-before', true));
  });

  it('rechecks each target after set preflight and compensates when a later target changed', async () => {
    const mem = memoryIo({ 'Form.fr.resx': state('fr-before', true) });
    const read = mem.io.read;
    let arReads = 0;
    mem.io.read = async (target) => {
      if (target === 'Form.ar.resx' && ++arReads === 2)
        mem.files.set(target, state('external-change'));
      return read(target);
    };

    await expect(transitionResourceSetAtomic(transitions, 'forward', mem.io))
      .rejects.toThrow('changed before write');
    expect(mem.files.get('Form.fr.resx')).toEqual(state('fr-before', true));
    expect(mem.files.get('Form.ar.resx')).toEqual(state('external-change'));
  });

  it('never overwrites an external edit that lands during compensation', async () => {
    const mem = memoryIo({ 'Form.fr.resx': state('fr-before', true) });
    const write = mem.io.write;
    mem.io.write = async (target, value) => {
      if (target === 'Form.ar.resx') {
        mem.files.set('Form.fr.resx', state('external-change', true));
        throw new Error('second write failed');
      }
      await write(target, value);
    };
    await expect(transitionResourceSetAtomic(transitions, 'forward', mem.io))
      .rejects.toThrow('compensation incomplete');
    expect(mem.files.get('Form.fr.resx')).toEqual(state('external-change', true));
  });
});
