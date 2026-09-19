// Implementation for /workflows: list scripts in .claude/workflows/ and print
// a creation template.
import { join } from 'path'
import { getProjectRoot } from '../../bootstrap/state.js'
import type { LocalCommandCall } from '../../types/command.js'
import { listWorkflowScripts } from '../../tools/WorkflowTool/workflowScripts.js'

const TEMPLATE = `---\nname: my-workflow\ndescription: What this workflow does\n---\nYour workflow instructions for the background sub-agent...`

export const call: LocalCommandCall = async () => {
  const cwd = getProjectRoot()
  const scripts = await listWorkflowScripts(cwd)
  const dir = join(cwd, '.claude', 'workflows')

  if (scripts.length === 0) {
    return {
      type: 'text',
      value:
        `No workflow scripts found in ${dir}. ` +
        `Create a markdown file there, e.g. .claude/workflows/my-workflow.md:\n\n${TEMPLATE}`,
    }
  }

  const list = scripts
    .map(script => `- ${script.name}: ${script.description}`)
    .join('\n')
  return {
    type: 'text',
    value:
      `Available workflows in ${dir}:\n${list}\n\n` +
      `Run one with /<name> or ask the model to use the Workflow tool. ` +
      `Create new ones by dropping a markdown file in ${dir}:\n\n${TEMPLATE}`,
  }
}
