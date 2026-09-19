// Pure (non-React) task definition + kill helpers for the monitor_mcp task type.
// Extracted so runAgent.ts can kill agent-scoped monitor tasks without pulling
// React/Ink into its module graph (same rationale as LocalShellTask's guards.ts
// and killShellTasks.ts). The actual Monitor tool (tools/MonitorTool) spawns its
// process through spawnShellTask with kind='monitor', producing a local_bash
// state — the monitor_mcp type is registered here so the BackgroundTasksDialog /
// task-dispatch paths have a kill target regardless of which spawn path fires.

import type { AppState } from '../../state/AppState.js'
import type { Task, TaskStateBase } from '../../Task.js'
import type { AgentId } from '../../types/ids.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { dequeueAllMatching } from '../../utils/messageQueueManager.js'
import { evictTaskOutput } from '../../utils/task/diskOutput.js'
import { updateTaskState } from '../../utils/task/framework.js'
import type { ShellCommand } from '../../utils/ShellCommand.js'

export type MonitorMcpTaskState = TaskStateBase & {
  type: 'monitor_mcp'
  command: string
  shellCommand: ShellCommand | null
  // Whether the task has been backgrounded. Kept true for spawned monitors so
  // isBackgroundTask() treats them as background tasks from registration.
  isBackgrounded: boolean
  // Agent that spawned this task. Used to kill orphaned monitor tasks when the
  // agent exits (see killMonitorMcpTasksForAgent). Undefined = main thread.
  agentId?: AgentId
}

export function isMonitorMcpTask(task: unknown): task is MonitorMcpTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'monitor_mcp'
  )
}

type SetAppStateFn = (updater: (prev: AppState) => AppState) => void

export function killMonitorMcp(
  taskId: string,
  setAppState: SetAppStateFn,
): void {
  updateTaskState(taskId, setAppState, task => {
    if (task.status !== 'running' || !isMonitorMcpTask(task)) {
      return task
    }

    try {
      logForDebugging(`MonitorMcpTask ${taskId} kill requested`)
      task.shellCommand?.kill()
      task.shellCommand?.cleanup()
    } catch (error) {
      logError(error)
    }

    return {
      ...task,
      status: 'killed',
      notified: true,
      shellCommand: null,
      endTime: Date.now(),
    }
  })
  void evictTaskOutput(taskId)
}

/**
 * Kill all running monitor_mcp tasks spawned by a given agent.
 * Called from runAgent.ts finally block so background monitors don't outlive
 * the agent that started them.
 */
export function killMonitorMcpTasksForAgent(
  agentId: AgentId,
  getAppState: () => AppState,
  setAppState: SetAppStateFn,
): void {
  const tasks = getAppState().tasks ?? {}
  for (const [taskId, task] of Object.entries(tasks)) {
    if (
      isMonitorMcpTask(task) &&
      task.agentId === agentId &&
      task.status === 'running'
    ) {
      logForDebugging(
        `killMonitorMcpTasksForAgent: killing orphaned monitor task ${taskId} (agent ${agentId} exiting)`,
      )
      killMonitorMcp(taskId, setAppState)
    }
  }
  // Purge any queued notifications addressed to this agent — its query loop
  // has exited and won't drain them. Same rationale as killShellTasksForAgent.
  dequeueAllMatching(cmd => cmd.agentId === agentId)
}

export const MonitorMcpTask: Task = {
  name: 'MonitorMcpTask',
  type: 'monitor_mcp',
  kill: async (taskId, setAppState) => {
    killMonitorMcp(taskId, setAppState)
  },
}
