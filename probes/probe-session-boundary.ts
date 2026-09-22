/**
 * 探针：会话边界标记（session-boundary）的解析与续接提示文案。
 *
 * 不变量：
 *   1. 只认行首的 {"type":"session-boundary" —— 嵌套在消息 JSON 字符串里的
 *      同名字面量不得被误判为边界；
 *   2. 尾部最后一条边界是 end ⇒ 上次正常退出；是 start ⇒ 上次异常终止；
 *   3. 续接提示的措辞随间隔分级（分钟/小时/天），且上次异常终止必须显式声明；
 *   4. 拿不到上次活动时间时不产出提示（宁缺毋滥）。
 *
 * 用法：bun probes/probe-session-boundary.ts
 */
import {
  buildSessionBoundaryEntry,
  buildSessionContinuityNote,
  formatGap,
  parseLastSessionBoundaryFromTail,
} from '../src/utils/sessionBoundary.js'

let pass = 0
let fail = 0

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const SID = '11111111-2222-3333-4444-555555555555' as const
const startEntry = buildSessionBoundaryEntry(
  SID as never,
  'start',
  'resume',
  new Date('2026-09-18T10:00:00.000Z'),
)
const endEntry = buildSessionBoundaryEntry(
  SID as never,
  'end',
  'graceful',
  new Date('2026-09-18T14:30:00.000Z'),
)

console.log('--- parseLastSessionBoundaryFromTail ---')

check('空 tail → null', parseLastSessionBoundaryFromTail('') === null)
check(
  '无边界内容 → null',
  parseLastSessionBoundaryFromTail('{"type":"custom-title","customTitle":"x"}\n') ===
    null,
)

const startOnly = JSON.stringify(startEntry) + '\n'
const parsedStart = parseLastSessionBoundaryFromTail(startOnly)
check('start-only → 解析出 start', parsedStart?.event === 'start')

const startThenEnd =
  JSON.stringify(startEntry) + '\n' + JSON.stringify(endEntry) + '\n'
const parsedEnd = parseLastSessionBoundaryFromTail(startThenEnd)
check(
  'start+end → 取最后一条（end）',
  parsedEnd?.event === 'end' && parsedEnd?.timestamp === endEntry.timestamp,
)

// 消息体内部出现同名字面量（作为字符串值被转义），不得被误判
const decoy =
  '{"type":"user","message":{"role":"user","content":"see {\\"type\\":\\"session-boundary\\"} here"}}\n'
check('消息内嵌同名字面量 → 不误匹配', parseLastSessionBoundaryFromTail(decoy) === null)

// 边界写在文末但前面有其它条目
const mixed =
  '{"type":"tag","tag":"t"}\n' + startThenEnd + '{"type":"last-prompt"}\n'
check('尾部混杂其它条目 → 仍取最后边界', parseLastSessionBoundaryFromTail(mixed)?.event === 'end')

console.log('--- formatGap ---')
check('45s', formatGap(45_000) === '45 seconds', formatGap(45_000))
check('30min', formatGap(30 * 60_000) === '30 minutes', formatGap(30 * 60_000))
check('5h', formatGap(5 * 3_600_000) === '5h', formatGap(5 * 3_600_000))
check(
  '3d5h',
  formatGap(3 * 86_400_000 + 5 * 3_600_000) === '3 days 5h',
  formatGap(3 * 86_400_000 + 5 * 3_600_000),
)

console.log('--- buildSessionContinuityNote ---')

check(
  '无 lastActivityTs → null',
  buildSessionContinuityNote({ lastActivityTs: undefined, prevBoundary: null }) ===
    null,
)

const base = Date.parse('2026-09-18T14:30:00.000Z')
const shortNote = buildSessionContinuityNote({
  lastActivityTs: '2026-09-18T14:30:00.000Z',
  prevBoundary: endEntry,
  now: new Date(base + 45_000),
})!
check('分钟级 → 短间隔措辞', shortNote.includes('still likely current'))
check('正常退出 → graceful exit', shortNote.includes('graceful exit'))
check('含上次活动时间', shortNote.includes('2026-09-18T14:30:00.000Z'))

const hoursNote = buildSessionContinuityNote({
  lastActivityTs: '2026-09-18T14:30:00.000Z',
  prevBoundary: endEntry,
  now: new Date(base + 5 * 3_600_000),
})!
check('小时级 → 中等警告', hoursNote.includes('Some time has passed'))

const daysNote = buildSessionContinuityNote({
  lastActivityTs: '2026-09-18T14:30:00.000Z',
  prevBoundary: endEntry,
  now: new Date(base + 3 * 86_400_000 + 5 * 3_600_000),
})!
check('天级 → 强警告', daysNote.includes('A long time has passed'))
check('天级 → 报告间隔', daysNote.includes('3 days 5h'))

const crashedNote = buildSessionContinuityNote({
  lastActivityTs: '2026-09-18T10:00:00.000Z',
  prevBoundary: startEntry,
  now: new Date(base + 86_400_000),
})!
check('上次只有 start → 声明异常终止', crashedNote.includes('NOT recorded'))

const legacyNote = buildSessionContinuityNote({
  lastActivityTs: '2026-09-18T10:00:00.000Z',
  prevBoundary: null,
  now: new Date(base + 86_400_000),
})!
check('无边界记录 → 声明 unknown', legacyNote.includes('unknown'))

console.log('---')
console.log(`PASS ${pass} / FAIL ${fail}`)
process.exit(fail === 0 ? 0 : 1)
