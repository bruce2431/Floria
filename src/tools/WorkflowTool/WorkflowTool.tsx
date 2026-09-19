// Workflow tool — runs a reusable workflow script as a background sub-agent.
//
// A workflow script is a markdown file in `<cwd>/.claude/workflows/*.md` whose
// body is the instruction set handed to a child claude (print mode) process
// running as a background task (LocalWorkflowTask). The tool call itself just
// returns the background task id; output streams as task notifications and is
// inspectable in the background-tasks dialog.

import type { ReactNode } from 'react'
import { z } from 'zod/v4'
import type { ToolDef, ToolResult, ToolUseContext } from '../../Tool.js'
import { buildTool } from '../../Tool.js'
import { getProjectRoot } from '../../bootstrap/state.js'
import { Text } from '../../ink.js'
import { spawnLocalWorkflowTask } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import { getWorkflowScript } from './workflowScripts.js'

const workflowInputSchema = lazySchema(() =>
  z.strictObject({
    workflow: z
      .string()
      .min(1)
      .describe(
        'Name of the workflow script to run (a file in .claude/workflows/, without the .md extension).',
      ),
    args: z
      .string()
      .optional()
      .describe(
        'Optional arguments passed to the workflow script (appended to its instruction set).',
      ),
  }),
)

type WorkflowInput = z.infer<typeof workflowInputSchema>

type WorkflowOutput = {
  backgroundTaskId: string
}

export const WorkflowTool = buildTool({
  name: 'Workflow',
  searchHint: 'run a reusable workflow script',
  // The workflow sub-agent is untrusted input like Bash — destructive actions
  // still prompt. Reading state only here.
  isConcurrencySafe: () => true,
  async description({ workflow }) {
    return `Run the "${workflow}" workflow`
  },
  async prompt() {
    return `Use this tool to run a reusable workflow script defined in .claude/workflows/. Each workflow is a markdown file whose body is the instruction set for a background sub-agent. The workflow runs as a background task; its output streams to the user as notifications and is inspectable in the background-tasks dialog.`
  },
  get inputSchema(): WorkflowInput {
    return workflowInputSchema()
  },
  userFacingName(input) {
    if (!input?.workflow) return 'Workflow'
    return `Workflow: ${input.workflow}`
  },
  getToolUseSummary(input) {
    if (!input?.workflow) return null
    return `Running workflow ${input.workflow}`
  },
  getActivityDescription(input) {
    if (!input?.workflow) return 'Running workflow'
    return `Running workflow ${input.workflow}`
  },
  renderToolUseMessage(input): ReactNode {
    return (
      <Text>
        <Text bold>Workflow</Text>
        <Text dimColor> running </Text>
        <Text>{input.workflow}</Text>
      </Text>
    )
  },
  mapToolResultToToolResultBlockParam(data: WorkflowOutput, toolUseID) {
    const outputPath = getTaskOutputPath(data.backgroundTaskId)
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: [
        {
          type: 'text' as const,
          text:
            `Workflow started as background task ${data.backgroundTaskId}. ` +
            `Output streams to the user as notifications and is written to: ${outputPath}.`,
        },
      ],
    }
  },
  renderToolResultMessage(data) {
    return (
      <Text dimColor>
        Workflow running ({data.backgroundTaskId})
      </Text>
    )
  },
  extractSearchText(data) {
    return `Workflow started as background task ${data.backgroundTaskId}`
  },
  async call(
    input: WorkflowInput,
    toolUseContext: ToolUseContext,
  ): Promise<ToolResult<WorkflowOutput>> {
    const { abortController, setAppState } = toolUseContext
    const script = await getWorkflowScript(getProjectRoot(), input.workflow)
    if (!script) {
      throw new Error(
        `Unknown workflow "${input.workflow}". Create .claude/workflows/${input.workflow}.md or run /workflows to list available workflows.`,
      )
    }

    const handle = await spawnLocalWorkflowTask(
      {
        workflow: script,
        args: input.args ?? '',
        toolUseId: toolUseContext.toolUseId,
        agentId: toolUseContext.agentId,
      },
      {
        abortController,
        getAppState: () => {
          // spawnLocalWorkflowTask doesn't call getAppState during spawn.
          throw new Error('getAppState not available in WorkflowTool call context')
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
} satisfies ToolDef<WorkflowInput, WorkflowOutput>)
