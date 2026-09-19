export default {
  type: 'local',
  name: 'force-snip',
  description: 'Force-snip messages from conversation history',
  isEnabled: () => false,
  supportsNonInteractive: false,
  load: () =>
    Promise.resolve({
      call: async () => ({
        type: 'text',
        value: 'Force-snip is not available in this build.',
      }),
    }),
}
