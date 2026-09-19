import { buildTool } from '../../Tool.js'

const inputSchema = { type: 'object', properties: {}, required: [] }

export const SnipTool = buildTool({
  name: 'Snip',
  description: 'Snip messages (not available in this build)',
  inputSchema,
  async prompt() { return 'Snip tool' },
  isEnabled() { return false },
  isConcurrencySafe() { return true },
  userFacingName() { return '' },
})
