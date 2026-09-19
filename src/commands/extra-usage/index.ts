import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'

// Overage provisioning required OAuth subscription state; no subscribers
// without OAuth, so both entry points are permanently disabled.
export const extraUsage = {
  type: 'local-jsx',
  name: 'extra-usage',
  description: 'Configure extra usage to keep working when limits are hit',
  isEnabled: () => false,
  load: () => import('./extra-usage.js'),
} satisfies Command

export const extraUsageNonInteractive = {
  type: 'local',
  name: 'extra-usage',
  supportsNonInteractive: true,
  description: 'Configure extra usage to keep working when limits are hit',
  isEnabled: () => false,
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  load: () => import('./extra-usage-noninteractive.js'),
} satisfies Command
