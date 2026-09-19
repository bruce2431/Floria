import type { Command } from '../../commands.js'

const privacySettings = {
  type: 'local-jsx',
  name: 'privacy-settings',
  description: 'View and update your privacy settings',
  // Consumer-subscriber screen; no subscribers without OAuth.
  isEnabled: () => false,
  load: () => import('./privacy-settings.js'),
} satisfies Command

export default privacySettings
