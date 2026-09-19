import { buildTool } from '../../Tool.js'

export const SUBSCRIBE_PR_TOOL_NAME = 'SubscribePR'

const inputSchema = { type: 'object', properties: {}, required: [] }

export const SubscribePRTool = buildTool({
  name: SUBSCRIBE_PR_TOOL_NAME,
  description: 'Subscribe to PR notifications (not available in this build)',
  inputSchema,
  async prompt() { return 'Subscribe PR tool' },
  isEnabled() { return false },
  isConcurrencySafe() { return true },
  userFacingName() { return '' },
})
