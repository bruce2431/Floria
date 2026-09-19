export default {
  type: 'local',
  name: 'buddy',
  description: 'Pair programming buddy',
  isEnabled: () => false,
  supportsNonInteractive: false,
  load: () =>
    Promise.resolve({
      call: async () => ({
        type: 'text',
        value: 'Buddy is not available in this build.',
      }),
    }),
}
