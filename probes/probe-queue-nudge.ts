/**
 * probe-queue-nudge.ts —— 排队消息催办标记的自取证探针（2026-09-10）。
 *
 * 验证 messageQueueManager 的催办语义（REPL 判活 / query.ts 断流收口都依赖它）：
 *   ① 队列里有可 drain 的用户消息时，getDrainableQueuedPrompt 命中它；
 *   ② requestQueueNudge → peek 为真（生成流每个增量都能看到）；
 *   ③ consumeQueueNudge 一次性消费（消费后 peek 转假，不会无限断流）；
 *   ④ 队列清空（被 remove / 被 drain）→ 标记自动失效（不误伤下一轮生成）；
 *   ⑤ 斜杠命令 / task-notification / 子代理命令都不算可催办对象。
 * 运行：cd Floria && bun probes/run probe-queue-nudge.ts
 */
import {
  enqueue,
  remove as removeFromQueue,
  requestQueueNudge,
  peekQueueNudge,
  consumeQueueNudge,
  getDrainableQueuedPrompt,
  getCommandQueueLength,
  clearCommandQueue,
} from '../src/utils/messageQueueManager.js'

let failed = 0
function check(name: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (actual=${String(actual)} expected=${String(expected)})`)
}

// ① 队列空 → 无催办对象，且标记恒假
clearCommandQueue()
check('空队列无可催办对象', getDrainableQueuedPrompt(), undefined)
check('空队列标记假', peekQueueNudge(), false)

// ② 普通用户输入（mode prompt，无 agentId）→ 命中
enqueue({ value: 'hello', mode: 'prompt' } as never)
check('prompt 命中可催办对象', getDrainableQueuedPrompt()?.value, 'hello')
check('队列长度 1', getCommandQueueLength(), 1)

// ③ 置位 → peek 真 → 重复 peek 仍真（断流判定要能反复看到）
requestQueueNudge()
check('置位后 peek 真', peekQueueNudge(), true)
check('重复 peek 仍真', peekQueueNudge(), true)

// ④ 一次性消费
check('首次 consume 真', consumeQueueNudge(), true)
check('消费后 peek 假', peekQueueNudge(), false)
check('二次 consume 假', consumeQueueNudge(), false)

// ⑤ 置位后队列清空 → 标记自动失效（不误伤下一轮生成）。
// remove 按引用匹配（引擎 drain 传的就是快照里的原对象），故此处同样取原对象。
requestQueueNudge()
check('清空前 peek 真', peekQueueNudge(), true)
const drained = getDrainableQueuedPrompt()
check('取到队列原对象', drained?.value, 'hello')
removeFromQueue(drained ? [drained] : [])
check('队列已空', getCommandQueueLength(), 0)
check('清空后标记失效', peekQueueNudge(), false)

// ⑥ 斜杠命令不算催办对象
enqueue({ value: '/help', mode: 'prompt' } as never)
check('斜杠命令不可催办', getDrainableQueuedPrompt(), undefined)
clearCommandQueue()

// ⑦ task-notification（非 prompt）不算催办对象
enqueue({ value: 'task done', mode: 'task-notification' } as never)
check('task-notification 不可催办', getDrainableQueuedPrompt(), undefined)
clearCommandQueue()

// ⑧ 子代理命令（带 agentId）不算主线程催办对象
enqueue({ value: 'sub', mode: 'prompt', agentId: 'agent-1' } as never)
check('子代理命令不可催办', getDrainableQueuedPrompt(), undefined)
clearCommandQueue()

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
