const subscribePr = {
  type: 'local',
  name: 'subscribe-pr',
  description: 'Subscribe to PR notifications (not available in this build)',
  isEnabled: () => false,
  supportsNonInteractive: false,
  load: () => Promise.resolve({
    call: async () => ({ type: 'text', value: 'Subscribe-PR is not available in this build.' }),
  }),
}

export default subscribePr
