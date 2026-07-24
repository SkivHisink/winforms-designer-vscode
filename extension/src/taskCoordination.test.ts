import { describe, expect, it } from 'vitest';
import { isBuildOrTestTask, taskCoordinationKey } from './taskCoordination';

describe('isBuildOrTestTask', () => {
  it('accepts explicit VS Code build and test groups', () => {
    expect(isBuildOrTestTask({ groupId: 'build', name: 'compile' })).toBe(true);
    expect(isBuildOrTestTask({ groupId: 'test', name: 'verify' })).toBe(true);
  });

  it('recognizes common ungrouped dotnet task names', () => {
    expect(isBuildOrTestTask({ definitionType: 'process', name: 'dotnet build App.csproj' })).toBe(true);
    expect(isBuildOrTestTask({ definitionType: 'shell', name: 'Rebuild solution' })).toBe(true);
    expect(isBuildOrTestTask({ name: 'test net48' })).toBe(true);
  });

  it('does not release previews for unrelated run/watch tasks', () => {
    expect(isBuildOrTestTask({ groupId: 'none', name: 'Run application' })).toBe(false);
    expect(isBuildOrTestTask({ name: 'watch assets' })).toBe(false);
  });

  it('correlates equivalent fetched and started task objects without relying on object identity', () => {
    const fetched = { groupId: 'build', name: 'Build App', definitionType: 'process', source: 'workspace' };
    const started = { groupId: 'BUILD', name: ' build app ', definitionType: 'PROCESS', source: 'WORKSPACE' };
    expect(taskCoordinationKey(started)).toBe(taskCoordinationKey(fetched));
    expect(taskCoordinationKey({ ...fetched, name: 'Build Other' })).not.toBe(taskCoordinationKey(fetched));
  });
});
