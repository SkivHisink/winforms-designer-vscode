import { describe, expect, it } from 'vitest';
import { EngineRegistry } from './engineRegistry';
import { withEngineRequestContext } from './engineRequestContext';

const context = { sessionId: 'session-a', documentId: 'Form1.Designer.cs', documentRevision: 1,
  renderGeneration: 1, sourceText: '', ownerProject: 'D:\\workspace\\App.csproj',
  dependencyFingerprint: 'a'.repeat(64), configuration: 'Release', targetFramework: 'net10.0-windows', platform: 'AnyCPU' };

describe('project worker registry', () => {
  it('reuses an identical graph and separates effective owner, target, dependencies and trust policy', () => {
    const registry = new EngineRegistry<object>();
    const value = {};
    withEngineRequestContext(context, () => {
      registry.set('modern', value);
      expect(registry.get('modern')).toBe(value);
      expect(registry.get('net48')).toBeUndefined();
    });
    for (const changed of [{ ownerProject: 'D:\\workspace\\Other.csproj' }, { configuration: 'Debug' },
      { targetFramework: 'net9.0-windows' }, { platform: 'x64' }, { dependencyFingerprint: 'b'.repeat(64) },
      { workspaceTrust: 'untrusted' as const }, { designTimeTrust: 'hostedDesignTime' as const }]) {
      withEngineRequestContext({ ...context, ...changed }, () => expect(registry.get('modern')).toBeUndefined());
    }
    expect(registry.get('modern')).toBe(value);
    expect(registry.deleteValue(value)).toBe(true);
    expect(registry.size).toBe(0);
  });

  it('removes the exact owned process independently of a different active project context', () => {
    const registry = new EngineRegistry<object>();
    const first = {};
    const second = {};
    withEngineRequestContext(context, () => registry.set('net48', first));
    withEngineRequestContext({ ...context, dependencyFingerprint: 'b'.repeat(64) }, () => {
      registry.set('net48', second);
      expect(registry.deleteValue(first)).toBe(true);
      expect(registry.get('net48')).toBe(second);
    });
    expect([...registry.entries()]).toEqual([['net48', second]]);
  });

  it('uses the most recently requested project for runtime-only status and fault hooks', () => {
    const registry = new EngineRegistry<object>();
    const first = {};
    const second = {};
    withEngineRequestContext(context, () => registry.set('modern', first));
    withEngineRequestContext({ ...context, dependencyFingerprint: 'b'.repeat(64) }, () => registry.set('modern', second));
    withEngineRequestContext(context, () => expect(registry.get('modern')).toBe(first));
    expect(registry.get('modern')).toBe(first);
  });
});
