export interface TaskDescriptor {
  groupId?: string;
  name?: string;
  definitionType?: string;
  source?: string;
}

/** VS Code does not expose a cancellable "before task" hook. onDidStartTask is its earliest lifecycle event, so the
 * extension uses this pure classifier there and starts releasing net48 AppDomains before the task process event. */
export function isBuildOrTestTask(task: TaskDescriptor): boolean {
  const group = (task.groupId ?? '').toLowerCase();
  if (group === 'build' || group === 'test') return true;
  const type = (task.definitionType ?? '').toLowerCase();
  const name = (task.name ?? '').toLowerCase();
  if (type === 'dotnet' || type === 'msbuild') return /\b(build|rebuild|test)\b/.test(name);
  return /\b(build|rebuild|test)\b/.test(name);
}

/** Stable-enough correlation key between fetchTasks()/executeTask() and onDidStartTask. VS Code may surface a
 * different Task object instance in the lifecycle event, so object identity would run the release twice and leave
 * the net48 task-depth latch stuck. Source/name/type/group are the task identity VS Code itself exposes here. */
export function taskCoordinationKey(task: TaskDescriptor): string {
  return [task.source, task.name, task.definitionType, task.groupId]
    .map((part) => (part ?? '').trim().toLowerCase())
    .join('\u0000');
}
