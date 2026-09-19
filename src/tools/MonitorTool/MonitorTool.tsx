// Monitor tool — runs a shell command as a streaming background monitor.
//
// Unlike Bash (which waits for completion and returns the full output), Monitor
// is streaming-only: the process is backgrounded immediately, each stdout line
// is surfaced as a background-task notification, and the monitor ends when the
// script exits ("Monitor ... stream ended/failed/stopped"). The tool call
// itself returns just the background task id.
//
// The background task is spawned via spawnShellTask with kind='monitor', which
// produces a local_bash task state flagged kind='monitor' — that's what makes
// the UI show the description as the label, use the "Monitor details" dialog
// title (ShellDetailDialog), and use the distinct monitor status-bar pill and
// completion copy. The permission surface is the generic system: checkPermissions
// defaults to allow → delegates to allow rules, prompting MonitorPermissionRequest
// when no rule matches.

import type { ReactNode } from 'react'
import { z } from 'zod/v4'
import type { ToolDef, ToolResult, ToolUseContext } from '../../Tool.js'
import { buildTool } from '../../Tool.js'
import { spawnShellTask } from '../../tasks/LocalShellTask/LocalShellTask.js'
import { Text } from '../../ink.js'
import { exec } from '../../utils/Shell.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'

const MAX_DESCRIPTION_LENGTH = 120

function truncateDescription(s: string): string {
  return s.length > MAX_DESCRIPTION_LENGTH
    ? `${s.slice(0, MAX_DESCRIPTION_LENGTH)}…`
    : s
}

const monitorInputSchema = lazySchema(() =>
  z.strictObject({
    command: z
      .string()
      .min(1)
      .describe(
        'Shell command to run in the background and monitor. Each stdout line is delivered as a notification. The monitor ends when the script exits.',
      ),
    description: z
      .string()
      .optional()
      .describe(
        'Short human-readable description of what is being monitored, shown in the UI instead of the raw command.',
      ),
  }),
)

type MonitorInput = z.infer<typeof monitorInputSchema>

type MonitorOutput = {
  backgroundTaskId: string
}

export const MonitorTool = buildTool({
  name: 'Monitor',
  searchHint: 'stream background process output',
  // Reading output only; the spawned command is untrusted input like Bash, so
  // isReadOnly stays false (default) — destructive commands still prompt.
  isConcurrencySafe: () => true,
  async description({ description }) {
    return description || 'Run a command in the background and stream its output'
  },
  async prompt() {
    return `Use this tool to run a long-running shell command in the background and stream its stdout to the user. Each line of output is delivered as a notification, and the monitor ends when the script exits. Prefer it over run_in_background Bash for watching logs, tailing processes, or polling APIs where you want streaming events rather than a single completion.`
  },
  get inputSchema(): MonitorInput {
    return monitorInputSchema()
  },
  userFacingName(input) {
    if (!input?.description) return 'Monitor'
    return `Monitor: ${truncateDescription(input.description)}`
  },
  getToolUseSummary(input) {
    if (!input?.description) return null
    return `Monitoring ${input.description}`
  },
  getActivityDescription(input) {
    if (!input?.description) return 'Monitoring output'
    return `Monitoring ${input.description}`
  },
  renderToolUseMessage(
    input,
    _options,
  ): ReactNode {
    const label = input.description ?? input.command ?? ''
    return (
      <Text>
        <Text bold>Monitor</Text>
        <Text dimColor> monitoring </Text>
        <Text>{truncateDescription(label)}</Text>
      </Text>
    )
  },
  mapToolResultToToolResultBlockParam(
    data: MonitorOutput,
    toolUseID,
  ): {
    tool_use_id: string
    type: 'tool_result'
    content: Array<{ type: 'text'; text: string }>
  } {
    const outputPath = getTaskOutputPath(data.backgroundTaskId)
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: [
        {
          type: 'text',
          text:
            `Monitoring started as background task ${data.backgroundTaskId}. ` +
            `Output streams to the user as notifications; the monitor ends when the script exits. ` +
            `Output is being written to: ${outputPath}.`,
        },
      ],
    }
  },
  renderToolResultMessage(data) {
    return (
      <Text dimColor>
        Monitoring active ({data.backgroundTaskId})
      </Text>
    )
  },
  extractSearchText(data) {
    return `Monitoring started as background task ${data.backgroundTaskId}`
  },
  async call(
    input: MonitorInput,
    toolUseContext: ToolUseContext,
  ): Promise<ToolResult<MonitorOutput>> {
    const { abortController, setAppState } = toolUseContext
    const command = input.command
    const description = input.description?.trim() || command

    const shellCommand = await exec(command, abortController.signal, 'bash', {
      // Monitors never touch the foreground — start in a state that can be
      // backgrounded immediately, and don't let the script mutate session cwd.
      shouldAutoBackground: true,
      preventCwdChanges: true,
    })

    const handle = await spawnShellTask(
      {
        command,
        description,
        shellCommand,
        toolUseId: toolUseContext.toolUseId,
        agentId: toolUseContext.agentId,
        kind: 'monitor',
      },
      {
        abortController,
        getAppState: () => {
          // spawnShellTask doesn't call getAppState during spawn (mirrors
          // BashTool's run_in_background path).
          throw new Error('getAppState not available in MonitorTool call context')
        },
        setAppState: toolUseContext.setAppStateForTasks ?? setAppState,
      },
    )

    return {
      data: {
        backgroundTaskId: handle.taskId,
      },
    }
  },
} satisfies ToolDef<MonitorInput, MonitorOutput>)
