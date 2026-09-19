import { buildTool } from '../../Tool.js'

export const OVERFLOW_TEST_TOOL_NAME = 'OverflowTest'

const inputSchema = { type: 'object', properties: {}, required: [] }

export const OverflowTestTool = buildTool({
  name: OVERFLOW_TEST_TOOL_NAME,
  description: 'Overflow test tool (not available in this build)',
  inputSchema,
  async prompt() { return 'Overflow test tool' },
  isEnabled() { return false },
  isConcurrencySafe() { return true },
  userFacingName() { return '' },
})
