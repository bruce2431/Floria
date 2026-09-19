import { registerBundledSkill } from '../bundledSkills.js'

/**
 * Register the run-skill-generator bundled skill.
 * Feature-gated behind RUN_SKILL_GENERATOR.
 */
export function registerRunSkillGeneratorSkill() {
  registerBundledSkill({
    name: 'run-skill-generator',
    description: 'Run skill generator (not available in this build)',
    userInvocable: false,
    isEnabled: () => false,
    getPromptForCommand: async () => [{ type: 'text', text: 'Not available.' }],
  })
}
