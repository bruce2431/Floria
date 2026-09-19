export default {
  type: 'local',
  name: 'torch',
  description: 'Light a torch (placeholder)',
  isEnabled: () => false,
  supportsNonInteractive: false,
  load: () =>
    Promise.resolve({
      call: async () => ({
        type: 'text',
        value: 'Torch is not available in this build.',
      }),
    }),
}
