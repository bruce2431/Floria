import type { Command } from '../../commands.js'
import { shouldInferenceConfigCommandBeImmediate } from '../../utils/immediateCommand.js'
import { getMainLoopModel, renderModelName } from '../../utils/model/model.js'
import { loadCredentials } from '../../utils/credentials/pool.js'

export default {
  type: 'local-jsx',
  name: 'model',
  get description() {
    return `Set the AI model for Claude Code (currently ${renderModelName(getMainLoopModel())})`
  },
  argumentHint: '[model]',
  // 2026-08-29 直接切模型自动切供应商：补全聚合凭据池全部供应商模型（当前供应商排最前），跨商模型可直接 Tab 补全
  getArgumentCompletions: () => {
    const creds = loadCredentials()
    const names = creds.activeProvider
      ? [creds.activeProvider, ...Object.keys(creds.providers).filter(n => n !== creds.activeProvider)]
      : Object.keys(creds.providers)
    const seen = new Set<string>()
    const out: string[] = []
    for (const n of names) {
      const models = creds.providers[n]?.models
      if (!Array.isArray(models)) continue
      for (const m of models) {
        if (m && !seen.has(m)) {
          seen.add(m)
          out.push(m)
        }
      }
    }
    return out
  },
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('./model.js'),
} satisfies Command
