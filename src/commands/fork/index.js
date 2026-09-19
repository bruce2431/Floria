export default {
  type: 'local',
  name: 'fork',
  description: 'Fork a sub-agent',
  isEnabled: () => false,
  supportsNonInteractive: false,
  load: () =>
    Promise.resolve({
      call: async () => ({
        type: 'text',
        value: 'Fork is not available in this build.',
      }),
    }),
}
