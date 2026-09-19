/**
 * 名册渲染 — 会话起点注入（v2 §5.1 定案）
 *
 * 形态：
 *   - cwd 根库进正文（触发条件直读各库 prompts.should_search）
 *   - 全局根只留一行指针（发现权在 AI，经 neuron_list 主动发现）
 *   - 内联上限 8 个，超出折叠一行
 *   - 中途不回改（会话内新建不入本轮名册，护 prompt cache）——由调用方缓存保证
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getCwdRoot, getGlobalRoot, listNeurons } from './config.js'

const INLINE_LIMIT = 8

export function renderNeuronRoster(cwd?: string): string {
  const neurons = listNeurons(cwd)
  if (!neurons.length) return ''

  const cwdRoot = getCwdRoot(cwd)
  const globalRoot = getGlobalRoot()
  const cwdNeurons = neurons.filter(n => n.root === cwdRoot)
  const globalCount = neurons.length - cwdNeurons.length

  const lines: string[] = []
  lines.push('【记忆神经元】本项目可检索的知识库（recall 检索 / remember 记入）：')
  const inline = cwdNeurons.slice(0, INLINE_LIMIT)
  for (const n of inline) {
    const label = n.name && n.name !== n.id ? `${n.id}(${n.name})` : n.id
    lines.push(`- ${label}: ${n.description || '（无触发说明）'}`)
  }
  if (cwdNeurons.length > INLINE_LIMIT) {
    lines.push(`- …另有 ${cwdNeurons.length - INLINE_LIMIT} 个项目库，经 neuron_list 查看`)
  }
  if (globalCount > 0) {
    lines.push(
      `另有全局库 ${globalCount} 个（${globalRoot}，跨项目通用），检索前先经 neuron_list 发现。`,
    )
  }
  lines.push(
    '新经验随手 remember 入对应神经元，拿不准宁记勿弃；发现旧记忆与现实不符→remember update 修正。',
  )
  return lines.join('\n')
}

/** 名册是否可用（有 cwd 根或全局根神经元）——供注入点快速短路 */
export function hasNeuronRoster(cwd?: string): boolean {
  if (existsSync(join(getCwdRoot(cwd), 'neurons'))) return true
  if (existsSync(join(getGlobalRoot(), 'neurons'))) return true
  return false
}
