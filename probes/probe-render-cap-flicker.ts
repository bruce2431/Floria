/**
 * probe-render-cap-flicker.ts —— 取证：渲染投影「顶部内容变化」是否必然触发
 * Ink 的 fullReset（clearTerminal = 清屏 + 清 scrollback + 光标归零）。
 *
 * 背景：非全屏模式下（USER_TYPE 编译期 = 'external'，fullscreen.ts 恒 false），
 * 消息列表是普通动态 Ink 内容、靠终端原生 scrollback。log-update.ts 在检测到
 * 「已滚出视口的行（y < viewportY）发生变化」时无法就地改写 scrollback，
 * 只能 fullResetSequence_CAUSES_FLICKER —— 终端会清空 scrollback 并把视口拉回顶部。
 *
 * 假设：renderCap.capRenderedMessages 采用 count-based 逐条滑动
 * （`[placeholder, ...body.slice(excess)]`），消息数一旦超过 CAP，每追加一条
 * 就把整个投影窗口前移一条 ⇒ 顶部行每帧都变 ⇒ 每追加一条就 fullReset 一次。
 *
 * 判据：用 ink 的 onFrame 收集 flickers（Ink 自带归因），
 *       在不改变顶部内容时 flickers 应为空；让顶部变化则应出现 flicker。
 *
 * 用法：bun probes/probe-render-cap-flicker.ts
 */
import { PassThrough } from 'node:stream'
import { createElement as h, type ReactNode } from 'react'
// 导入序：conversationDisplay 先（其依赖链完成 sessionStorage 的模块级常量初始化），renderCap 后
// ——反序触发 ARCHIVE_PLACEHOLDER_PREFIX 的 TDZ（探针环境循环导入差异，同 probe-cap-head.ts）。
import '../src/utils/conversationDisplay.ts'
import { capRenderedMessages, MAX_RENDER_MESSAGES, ARCHIVE_PLACEHOLDER_PREFIX } from '../src/utils/renderCap.ts'
import type { SliceAnchorRef } from '../src/utils/renderCap.ts'

const COLS = 80
const ROWS = 24

function fakeStream(isTTY: boolean): NodeJS.WriteStream {
  const s = new PassThrough() as unknown as NodeJS.WriteStream
  ;(s as unknown as { isTTY: boolean }).isTTY = isTTY
  ;(s as unknown as { columns: number }).columns = COLS
  ;(s as unknown as { rows: number }).rows = ROWS
  // 吞掉输出，避免污染探针自身 stdout
  ;(s as unknown as { write: (...a: unknown[]) => boolean }).write = () => true
  return s
}

// The real bootstrap opens the config-reading gate before the first render;
// ThemeProvider reads the global config on mount, so without this every frame
// throws "Config accessed before allowed" into App's error boundary → unmount.
const { enableConfigs } = await import('../src/utils/config.js')
enableConfigs()

const { render, Box, Text } = await import('../src/ink.js')

type Flicker = { reason: string; triggerY?: number }

async function runCase(
  name: string,
  frames: string[][],
): Promise<{ name: string; flickerCount: number; reasons: string[]; frames: number; patches: number[] }> {
  const flickers: Flicker[] = []
  const out = fakeStream(true)
  const inp = fakeStream(false)
  let frameCount = 0
  const patchesSeen: number[] = []

  const renderFrame = (lines: string[]): ReactNode =>
    h(
      Box,
      { flexDirection: 'column' },
      ...lines.map((l, i) => h(Text, { key: i }, l)),
    )

  const inst = await render(renderFrame(frames[0]!), {
    stdout: out,
    stdin: inp as unknown as NodeJS.ReadStream,
    stderr: out,
    exitOnCtrlC: false,
    patchConsole: false,
    onFrame: (e: { flickers?: Flicker[]; phases?: { patches?: number } }) => {
      frameCount++
      patchesSeen.push(e.phases?.patches ?? -1)
      for (const f of e.flickers ?? []) {
        flickers.push({ reason: f.reason, triggerY: f.triggerY })
      }
    },
  })

  for (let i = 1; i < frames.length; i++) {
    inst.rerender(renderFrame(frames[i]!))
    // 让 React 的异步渲染循环落地
    await new Promise(r => setTimeout(r, 30))
  }
  await new Promise(r => setTimeout(r, 50))
  inst.unmount()

  return {
    name,
    flickerCount: flickers.length,
    reasons: [...new Set(flickers.map(f => f.reason))],
    frames: frameCount,
    patches: patchesSeen,
  }
}

const pad = (s: string, n: number): string => s.padEnd(n, ' ')
const line = (i: number): string => pad(`line-${i}`, COLS - 1)

// A. 纯追加（顶部不变）：应当零 flicker
const appendFrames: string[][] = []
for (let n = 30; n <= 45; n++) {
  appendFrames.push(Array.from({ length: n }, (_, i) => line(i)))
}

// B. 顶部滑动（模拟 cap 窗口前移：总行数不变，顶部丢一行、底部加一行）
const slideFrames: string[][] = []
for (let k = 0; k < 8; k++) {
  slideFrames.push(Array.from({ length: 40 }, (_, i) => line(i + k)))
}

const results: Array<{
  name: string
  flickerCount: number
  reasons: string[]
  frames: number
  patches: number[]
}> = []
results.push(await runCase('A 纯追加（顶部不变）', appendFrames))
results.push(await runCase('B 顶部滑动（cap 窗口前移）', slideFrames))

// ---- C. 真实 cap 算法驱动：旧（计数滑动）vs 新（UUID 锚点 + 步长量化）----
// 输入 = 逐条追加的消息流，每帧渲染「该项目前状态的投影」，与生产中 REPL 的
// setMessages→capRenderedMessages→<Messages> 逐帧路径同类。
type Msg = { type: string; subtype?: string; content: string; uuid: string; timestamp: number }
const mkMsg = (i: number): Msg => ({ type: 'user', content: `msg-${i}`, uuid: `u-${String(i).padStart(6, '0')}`, timestamp: i })

// 修复前实现（count-based 计数滑动）——仅作对照基准，非生产路径。
const legacyCap = (list: Msg[]): Msg[] => {
  const body = list.filter(m => !(m.type === 'system' && m.subtype === 'informational' && m.content.startsWith(ARCHIVE_PLACEHOLDER_PREFIX)))
  const excess = body.length - MAX_RENDER_MESSAGES
  if (excess <= 0) return body
  return [{ type: 'system', subtype: 'informational', content: `${ARCHIVE_PLACEHOLDER_PREFIX}${excess} 条消息已归档`, uuid: `ph-${excess}`, timestamp: -1 }, ...body.slice(excess)]
}

const CAP_FRAMES = 260 // 跨过首次进档（n = cap + step = 250 后的第 1 条）
function capFrames(cap: (l: Msg[]) => Msg[]): string[][] {
  const msgs: Msg[] = []
  const frames: string[][] = []
  for (let n = 1; n <= CAP_FRAMES; n++) {
    msgs.push(mkMsg(n - 1))
    frames.push(cap(msgs).map(m => pad(m.content, 40)))
  }
  return frames
}
const anchorRef: SliceAnchorRef = { current: null }
const fixedFrames = capFrames(l => capRenderedMessages(l, anchorRef) as Msg[])
const legacyFrames = capFrames(legacyCap)

results.push(await runCase(`C1 计数滑动（修复前，cap=${MAX_RENDER_MESSAGES}）`, legacyFrames))
results.push(await runCase(`C2 锚点+步长 ${MAX_RENDER_MESSAGES}/50（修复后）`, fixedFrames))

console.log('=== Ink fullReset(flicker) 取证 ===')
for (const r of results) {
  console.log(
    `${r.name}: frames=${r.frames} flicker=${r.flickerCount}${r.reasons.length ? ` reasons=[${r.reasons.join(',')}]` : ''}`,
  )
  console.log(`    patches/frame=${JSON.stringify(r.patches)}`)
}

const appendOk = results[0]!.flickerCount === 0
const slideHits = results[1]!.flickerCount > 0
// C1/C2 同为 260 帧追加：修复前每帧都进档（≈60 次重置），修复后只在 n=251 进档一次。
const legacy = results[2]!.flickerCount
const fixed = results[3]!.flickerCount
const legacyBad = legacy >= CAP_FRAMES - MAX_RENDER_MESSAGES - 5
const fixedOk = fixed <= 2
console.log('---')
console.log(
  `A 纯追加零 flicker: ${appendOk ? 'PASS' : 'FAIL（追加也 flicker，另有触发源）'}`,
)
console.log(
  `B 顶部滑动触发 flicker: ${slideHits ? 'PASS（假设成立）' : 'FAIL（顶部滑动未触发，假设不成立）'}`,
)
console.log(
  `C1 计数滑动逐帧重置: ${legacyBad ? `PASS（${legacy} 次 / ${CAP_FRAMES} 帧）` : `FAIL（仅 ${legacy} 次）`}`,
)
console.log(
  `C2 锚点量化后重置收敛: ${fixedOk ? `PASS（${fixed} 次 / ${CAP_FRAMES} 帧）` : `FAIL（仍有 ${fixed} 次）`}`,
)
process.exit(appendOk && slideHits && legacyBad && fixedOk ? 0 : 1)
