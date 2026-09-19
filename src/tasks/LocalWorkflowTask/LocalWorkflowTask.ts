// LocalWorkflowTask — the task type behind the Workflow tool.
//
// Minimal single-agent model: a workflow script (.claude/workflows/*.md, see
// tools/WorkflowTool/workflowScripts.ts) is run by spawning a child claude
// process in print mode ("the background sub-agent"). The child's stdout is
// streamed as a background task; kill/skip/retry operate on that child.
//
// skipWorkflowAgent / retryWorkflowAgent target the current agent (identified
// by currentAgentId). In the single-agent model there is exactly one, so skip
// ends the workflow early ("skipped") and retry restarts it as a fresh task.

import { unlink, writeFile } from 'fs/promises'
import { OUTPUT_FILE_TAG, STATUS_TAG, SUMMARY_TAG, TASK_ID_TAG, TASK_NOTIFICATION_TAG, TOOL_USE_ID_TAG } from '../../constants/xml.js'
import type { AppState } from '../../state/AppState.js'
import {
  createTaskStateBase,
  isTerminalTaskStatus,
  type Task,
  type TaskContext,
  type TaskHandle,
  type TaskStateBase,
} from '../../Task.js'
import type { AgentId } from '../../types/ids.js'
import { quote } from '../../utils/bash/shellQuote.js'
import { isInBundledMode } from '../../utils/bundledMode.js'
import { generateTempFilePath } from '../../utils/tempfile.js'
import { windowsPathToPosixPath } from '../../utils/windowsPaths.js'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { logForDebugging } from '../../utils/debug.js'
import { logError } from '../../utils/log.js'
import { enqueuePendingNotification } from '../../utils/messageQueueManager.js'
import { exec } from '../../utils/Shell.js'
import type { ShellCommand } from '../../utils/ShellCommand.js'
import { evictTaskOutput, getTaskOutputPath } from '../../utils/task/diskOutput.js'
import { registerTask, updateTaskState } from '../../utils/task/framework.js'
import { escapeXml } from '../../utils/xml.js'
import type { WorkflowScript } from '../../tools/WorkflowTool/workflowScripts.js'

export type LocalWorkflowTaskState = TaskStateBase & {
  type: 'local_workflow'
  workflow: WorkflowScript
  args: string
  /** Full child-claude command that was spawned. */
  command: string
  /** One-line status shown in the background-task list. */
  summary?: string
  shellCommand: ShellCommand | null
  // True from registration so isBackgroundTask() treats spawned workflows as
  // background tasks immediately (mirrors MonitorMcpTaskState).
  isBackgrounded: boolean
  // Identifies the agent currently executing the workflow. skip/retry target
  // this. Synthetic id in the single-agent model.
  currentAgentId?: string
  // Agent that spawned this task. Undefined = main thread.
  agentId?: AgentId
}

export function isLocalWorkflowTask(task: unknown): task is LocalWorkflowTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    task.type === 'local_workflow'
  )
}

type SetAppStateFn = (updater: (prev: AppState) => AppState) => void

export type LocalWorkflowSpawnInput = {
  workflow: WorkflowScript
  args?: string
  toolUseId?: string
  agentId?: AgentId
}

/**
 * Args that must precede CLI flags when spawning a child claude process.
 * Compiled binary: process.execPath is the claude binary and args go straight
 * to it. npm install: execPath is node, so argv[1] (the script) must come first
 * (see bridgeMain.ts spawnScriptArgs, anthropics/claude-code#28334).
 */
function cliCommandPrefix(): string[] {
  if (isInBundledMode() || !process.argv[1]) return []
  return [process.argv[1]]
}

export async function buildWorkflowCommand(
  workflow: WorkflowScript,
  args: string,
): Promise<{ command: string; tempPath: string }> {
  const prompt = args
    ? `${workflow.prompt}\n\nArguments:\n${args}`
    : workflow.prompt
  // The prompt (workflow body) is a multi-line CJK markdown doc. Inline
  // quote() embeds it into the command; through git-bash → MSYS argv→Windows
  // command-line conversion the escaped/mangled bytes get split into 2 args
  // for the native Windows exe (commander: "too many arguments. Expected 1
  // argument but got 2."). Bypass quote() for the prompt: write it to a temp
  // file and read it back via `$(cat ...)` — command substitution keeps it a
  // single raw argv element that MSYS converts correctly (verified working).
  // Note: content containing `"` would break the quoted eval string; the
  // built-in workflow scripts don't use double quotes.
  const tempPath = generateTempFilePath('workflow-prompt', '.md')
  await writeFile(tempPath, prompt, 'utf8')
  const posixPath = windowsPathToPosixPath(tempPath)
  const prefix = quote([
    process.execPath,
    ...cliCommandPrefix(),
    '--print',
    // Print-mode children otherwise persist a full session transcript to
    // .claude/projects/<id>.jsonl, polluting the /resume list (one record per
    // workflow run). --no-session-persistence requires --print, which we have.
    '--no-session-persistence',
  ])
  return { command: `${prefix} "$(cat '${posixPath}')"`, tempPath }
}

export async function spawnLocalWorkflowTask(
  input: LocalWorkflowSpawnInput,
  context: TaskContext,
): Promise<TaskHandle> {
  const { workflow, args = '', toolUseId, agentId } = input
  const { abortController, setAppState } = context
  const description = `Workflow: ${workflow.name}`
  const { command, tempPath } = await buildWorkflowCommand(workflow, args)

  const shellCommand = await exec(command, abortController.signal, 'bash', {
    // Start backgrounded immediately — the workflow never touches the foreground.
    shouldAutoBackground: true,
    preventCwdChanges: true,
  })

  // TaskOutput owns the data — use its taskId so disk writes are consistent.
  const taskId = shellCommand.taskOutput.taskId
  const unregisterCleanup = registerCleanup(async () => {
    killWorkflowTask(taskId, setAppState)
  })

  const state: LocalWorkflowTaskState = {
    ...createTaskStateBase(taskId, 'local_workflow', description, toolUseId),
    type: 'local_workflow',
    status: 'running',
    workflow,
    args,
    command,
    currentAgentId: `agent-${taskId}`,
    isBackgrounded: true,
    shellCommand,
    agentId,
  }
  registerTask(state, setAppState)

  shellCommand.background(taskId)

  void shellCommand.result.then(async result => {
    shellCommand.cleanup()
    let shouldEnqueue = false
    updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
      // Already killed/skipped/retried via kill path — leave terminal state.
      if (isTerminalTaskStatus(task.status)) return task
      shouldEnqueue = true
      return {
        ...task,
        status: result.code === 0 ? 'completed' : 'failed',
        summary:
          result.code === 0
            ? `Workflow "${workflow.name}" completed`
            : `Workflow "${workflow.name}" failed${
                result.code !== undefined ? ` (exit ${result.code})` : ''
              }`,
        shellCommand: null,
        endTime: Date.now(),
      }
    })
    if (shouldEnqueue) {
      enqueueWorkflowNotification(
        taskId,
        workflow.name,
        result.code === 0 ? 'completed' : 'failed',
        result.code,
        setAppState,
        toolUseId,
        agentId,
      )
    }
    void evictTaskOutput(taskId)
  }).finally(() => {
    // Prompt temp file was read by the child at spawn; best-effort cleanup.
    void unlink(tempPath).catch(() => {})
  })

  return { taskId }
}

/**
 * Kill a workflow task. No-op if already in a terminal state.
 */
export function killWorkflowTask(
  taskId: string,
  setAppState: SetAppStateFn,
): void {
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running' || !isLocalWorkflowTask(task)) {
      return task
    }
    try {
      logForDebugging(`LocalWorkflowTask ${taskId} kill requested`)
      task.shellCommand?.kill()
      task.shellCommand?.cleanup()
    } catch (error) {
      logError(error)
    }
    return {
      ...task,
      status: 'killed',
      summary: `Workflow "${task.workflow.name}" stopped`,
      shellCommand: null,
      endTime: Date.now(),
    }
  })
  void evictTaskOutput(taskId)
}

/**
 * Skip the current workflow agent. Ends the workflow early and records it as
 * completed-with-a-skip-summary rather than killed.
 */
export function skipWorkflowAgent(
  taskId: string,
  agentId: string,
  setAppState: SetAppStateFn,
): void {
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    if (
      task.status !== 'running' ||
      !isLocalWorkflowTask(task) ||
      task.currentAgentId !== agentId
    ) {
      return task
    }
    try {
      task.shellCommand?.kill()
      task.shellCommand?.cleanup()
    } catch (error) {
      logError(error)
    }
    return {
      ...task,
      status: 'completed',
      summary: `Workflow "${task.workflow.name}" skipped`,
      notified: true,
      shellCommand: null,
      endTime: Date.now(),
    }
  })
  void evictTaskOutput(taskId)
}

/**
 * Retry the current workflow agent. In the single-agent model this stops the
 * current run and spawns a fresh workflow task with the same script/args.
 */
export function retryWorkflowAgent(
  taskId: string,
  agentId: string,
  setAppState: SetAppStateFn,
): void {
  let src: LocalWorkflowTaskState | undefined
  setAppState(prev => {
    const task = prev.tasks[taskId]
    if (
      isLocalWorkflowTask(task) &&
      task.status === 'running' &&
      task.currentAgentId === agentId
    ) {
      src = task
    }
    return prev
  })
  if (!src) return

  killWorkflowTask(taskId, setAppState)

  void spawnLocalWorkflowTask(
    {
      workflow: src.workflow,
      args: src.args,
      toolUseId: src.toolUseId,
      agentId: src.agentId,
    },
    {
      abortController: new AbortController(),
      getAppState: () => {
        throw new Error('getAppState not available in retryWorkflowAgent')
      },
      setAppState,
    },
  )
    .then(handle => {
      enqueuePendingNotification({
        value: `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${handle.taskId}</${TASK_ID_TAG}>
<${SUMMARY_TAG}>Retrying workflow "${src!.workflow.name}"</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`,
        mode: 'task-notification',
        priority: 'later',
        agentId: src!.agentId,
      })
    })
    .catch(error => logError(error))
}

function enqueueWorkflowNotification(
  taskId: string,
  workflowName: string,
  status: 'completed' | 'failed' | 'killed',
  exitCode: number | undefined,
  setAppState: SetAppStateFn,
  toolUseId?: string,
  agentId?: AgentId,
): void {
  // Atomically check and set the notified flag to avoid duplicate notifications.
  let shouldEnqueue = false
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    if (task.notified) return task
    shouldEnqueue = true
    return { ...task, notified: true }
  })
  if (!shouldEnqueue) return

  const summary =
    status === 'completed'
      ? `Workflow "${workflowName}" completed`
      : status === 'failed'
        ? `Workflow "${workflowName}" failed${
            exitCode !== undefined ? ` (exit ${exitCode})` : ''
          }`
        : `Workflow "${workflowName}" stopped`
  const outputPath = getTaskOutputPath(taskId)
  const toolUseIdLine = toolUseId
    ? `\n<${TOOL_USE_ID_TAG}>${toolUseId}</${TOOL_USE_ID_TAG}>`
    : ''
  const message = `<${TASK_NOTIFICATION_TAG}>
<${TASK_ID_TAG}>${taskId}</${TASK_ID_TAG}>${toolUseIdLine}
<${OUTPUT_FILE_TAG}>${outputPath}</${OUTPUT_FILE_TAG}>
<${STATUS_TAG}>${status}</${STATUS_TAG}>
<${SUMMARY_TAG}>${escapeXml(summary)}</${SUMMARY_TAG}>
</${TASK_NOTIFICATION_TAG}>`
  enqueuePendingNotification({
    value: message,
    mode: 'task-notification',
    priority: 'later',
    agentId,
  })
}

export const LocalWorkflowTask: Task = {
  name: 'LocalWorkflowTask',
  type: 'local_workflow',
  kill: async (taskId, setAppState) => {
    killWorkflowTask(taskId, setAppState)
  },
}
