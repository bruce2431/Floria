/**
 * 会话生图上下文（provider-neutral）：记住本会话**最近生成的一张图**，使
 * 「继续把刚才那张改成夜景」这类自然多轮改图无需用户重新附图。
 *
 * 存储 = 进程内存 Map + 写透盘 sidecar `<dir>/.imagegen-context.json`（`{ [sid]: entry }`），
 * 后者让 `/resume` 起的新进程仍能续上。`dir` 口径与落盘层一致（`imagesDir()`；探针可覆写）。
 * 条目存**绝对路径**，`isUsable` 用 `existsSync` 挡陈旧/丢失——cwd/worktree 漂移不致误读。
 *
 * key 一律由调用方显式传入 sessionId（CLI 传 `getSessionId()`；探针传真 sid），
 * 本模块不自行取 session —— 便于离线直测、且无隐式全局耦合。
 */

import { existsSync, readFileSync } from 'fs'
import { promises as fs } from 'fs'
import { join } from 'path'
import { imagesDir } from './store.js'

/** 本会话最近生成的一张图。 */
export interface ImageContextEntry {
  /** 落盘文件名（即回填 `![](文件名)` 用的名字）。 */
  fileName: string
  /** 展示图绝对路径——跨进程可读，cwd 漂移不影响。 */
  path: string
  /**
   * 全保真原图绝对路径（仅当展示图被压缩时才与 `path` 不同；缺省/相等 = 展示图即原图）。
   * 多轮改图回注**优先读它**（`sourcePath ?? path`），避免用降质预览做输入。
   */
  sourcePath?: string
  mimeType: string
  provider: string
  model: string
  /** 记录时刻（epoch ms）。 */
  ts: number
}

const SIDECAR = '.imagegen-context.json'

/** sessionId → 最近生成图。 */
const memory = new Map<string, ImageContextEntry>()

function sidecarPath(dir?: string): string {
  return join(dir ?? imagesDir(), SIDECAR)
}

/** 惰性读盘：内存未命中时回填（只认结构完整的条目）。 */
function loadSidecar(dir?: string): void {
  try {
    const obj = JSON.parse(readFileSync(sidecarPath(dir), 'utf8')) as Record<
      string,
      ImageContextEntry
    >
    for (const [sid, entry] of Object.entries(obj)) {
      if (!memory.has(sid) && entry && typeof entry.path === 'string') {
        memory.set(sid, entry)
      }
    }
  } catch {
    /* 缺失/损坏：忽略——内存值仍有效 */
  }
}

/** 记录本会话最近生成的图（覆盖式，只留最新一张）。 */
export function setLastImage(
  sessionId: string | undefined,
  entry: ImageContextEntry,
  dir?: string,
): void {
  if (!sessionId) return
  memory.set(sessionId, entry)
  void persistSidecar(dir).catch(() => {})
}

/** 取本会话最近生成的图；内存未命中则尝试读盘一次。 */
export function getLastImage(
  sessionId: string | undefined,
  dir?: string,
): ImageContextEntry | null {
  if (!sessionId) return null
  if (!memory.has(sessionId)) loadSidecar(dir)
  return memory.get(sessionId) ?? null
}

/** 条目是否仍可用（其文件仍在盘上）。 */
export function isUsable(entry: ImageContextEntry): boolean {
  try {
    return existsSync(entry.path)
  } catch {
    return false
  }
}

/** 清空（缺省清全部；传 sid 只清该会话）。 */
export function clearImageContext(sessionId?: string): void {
  if (sessionId) memory.delete(sessionId)
  else memory.clear()
}

async function persistSidecar(dir?: string): Promise<void> {
  const obj: Record<string, ImageContextEntry> = {}
  for (const [sid, entry] of memory) obj[sid] = entry
  const target = dir ?? imagesDir()
  await fs.mkdir(target, { recursive: true })
  await fs.writeFile(sidecarPath(dir), JSON.stringify(obj), 'utf8')
}
