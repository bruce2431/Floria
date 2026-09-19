import type { Command } from '../../commands.js'

// No subscribers without OAuth — remote teleport sessions are unreachable.
export default {
  type: 'local-jsx',
  name: 'remote-env',
  description: 'Configure the default remote environment for teleport sessions',
  isEnabled: () => false,
  isHidden: true,
  load: () => import('./remote-env.js'),
} satisfies Command
