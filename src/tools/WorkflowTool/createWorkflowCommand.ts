// Registers each workflow script in .claude/workflows/ as a /<name> slash
// command (badged as workflow-backed via CommandBase.kind). Invoked from
// commands.ts loadAllCommands under the WORKFLOW_SCRIPTS gate.
//
// Running /<name> expands the workflow script's body into the conversation as
// a prompt (inline context). The Workflow *tool* is the background-sub-agent
// path; the slash command is the lightweight path.

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { ToolUseContext } from '../../Tool.js'
import type { Command } from '../../types/command.js'
import { listWorkflowScripts, type WorkflowScript } from './workflowScripts.js'

export async function getWorkflowCommands(cwd: string): Promise<Command[]> {
  const scripts = await listWorkflowScripts(cwd)
  return scripts.map(script => workflowToCommand(script))
}

function workflowToCommand(script: WorkflowScript): Command {
  return {
    name: script.name,
    description: script.description,
    hasUserSpecifiedDescription: false,
    userInvocable: true,
    kind: 'workflow',
    type: 'prompt',
    progressMessage: `Running workflow ${script.name}`,
    contentLength: script.prompt.length,
    argNames: ['args'],
    source: 'builtin',
    async getPromptForCommand(
      args: string,
      _context: ToolUseContext,
    ): Promise<ContentBlockParam[]> {
      const text = args
        ? `${script.prompt}\n\nArguments:\n${args}`
        : script.prompt
      return [{ type: 'text', text }]
    },
  }
}
