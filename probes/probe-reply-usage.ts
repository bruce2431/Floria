// 只读探针（2026-10-04）：验证 filterConversationForDisplay 为 assistant 消息输出 usage 明细
// （{input,cacheRead,cacheWrite,output}；web 回复操作条「用量 X tok」按钮 + 弹出面板数据源）+ model
// （弹出面板「提供方 / 模型」行数据源）。读项目根真实转录跑投影，统计覆盖并抽样。不写盘、不建会话。
// 运行：bun probes/probe-reply-usage.ts
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { filterConversationForDisplay } from '../src/utils/conversationDisplay.js'

// probes/ → Floria/ → Pj16 项目根
const root = join(import.meta.dir, '..', '..', '.claude', 'projects')
const files = readdirSync(root)
  .filter((f) => f.endsWith('.jsonl'))
  .map((f) => ({ f: join(root, f), m: statSync(join(root, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m)
  .slice(0, 6)

type UsageD = { input: number; cacheRead: number; cacheWrite: number; output: number }
let withUsage = 0
let withModel = 0
let totalAsst = 0
const samples: unknown[] = []
for (const { f } of files) {
  const raw = readFileSync(f, 'utf8')
  const records: unknown[] = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const r = JSON.parse(s) as { type?: string }
      if (r && typeof r.type === 'string' && ['user', 'assistant', 'system', 'attachment', 'progress'].includes(r.type)) records.push(r)
    } catch {}
  }
  const msgs = filterConversationForDisplay(records as never, 'prompt-tail-think') as Array<{
    role: string
    usage?: UsageD
    model?: string
    timestamp?: number
    stopReason?: string
    blocks: Array<{ kind: string; text?: string }>
  }>
  for (const m of msgs) {
    if (m.role !== 'assistant') continue
    totalAsst++
    const d = m.usage
    const total = d ? d.input + d.cacheRead + d.cacheWrite + d.output : 0
    if (d && total > 0) withUsage++
    if (typeof m.model === 'string' && m.model) withModel++
    if (d && total > 0 && samples.length < 400) {
      samples.push({
        file: f.split(/[\\/]/).pop(),
        total,
        ...d,
        model: m.model,
        ts: m.timestamp,
        stop: m.stopReason,
        txt: m.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('').slice(0, 24),
      })
    }
  }
}
console.log('scanned:', files.map((x) => x.f.split(/[\\/]/).pop()).join(', '))
console.log('assistant total:', totalAsst, '| with usage:', withUsage, '| with model:', withModel)
console.log('samples:', JSON.stringify(samples.slice(-4), null, 1))
if (totalAsst === 0 || withUsage !== totalAsst || withModel !== totalAsst) {
  console.error(`FAIL: usage/model 未覆盖全部 assistant（total=${totalAsst} withUsage=${withUsage} withModel=${withModel}）`)
  process.exit(1)
}
console.log('PASS: 全部 assistant 消息带 usage 明细 + model')
