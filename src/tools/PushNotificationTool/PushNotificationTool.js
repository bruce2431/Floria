import { buildTool } from '../../Tool.js'

const inputSchema = { type: 'object', properties: {}, required: [] }

export const PushNotificationTool = buildTool({
  name: 'PushNotification',
  description: 'Send push notifications (not available in this build)',
  inputSchema,
  async prompt() { return 'Push notification tool' },
  isEnabled() { return false },
  isConcurrencySafe() { return true },
  userFacingName() { return '' },
})
