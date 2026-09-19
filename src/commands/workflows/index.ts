// /workflows — list the workflow scripts in .claude/workflows/ and print a
// template for creating new ones. Implementation is lazy-loaded so the
// fs-scanning code isn't pulled into startup.
import type { Command } from '../../commands.js'

const workflows: Command = {
  type: 'local',
  name: 'workflows',
  aliases: ['workflow'],
  description: 'List workflow scripts in .claude/workflows/ and show how to create one',
  argumentHint: '',
  supportsNonInteractive: true,
  load: () => import('./workflows.js'),
}

export default workflows
