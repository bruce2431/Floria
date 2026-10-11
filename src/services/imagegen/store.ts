/**
 * 生图落盘层（provider-neutral，纯逻辑便于探针直测）。
 *
 * 负责：文件名生成（白名单合规）→ 原子写盘 → 网关 4MB 上限兜底压缩 →
 * 审计日志追加。与厂商无关：任何 adapter 出的 `{bytes, mimeType}` 都走这里。
 *
 * 目录口径与展示链（`/gateway/file`）一致：`getCwd()/.claude/images/`——
 * 项目会话 cwd = 项目根、全局散装会话 cwd = 工作区根。
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import { compressImageBuffer } from '../../utils/imageResizer.js'

/** 网关读侧上限（`/gateway/file` 拒绝 > 4MB）；超限先压缩再落盘。 */
export const MAX_VIEWABLE_BYTES = 4 * 1024 * 1024

/** 展示链白名单：`^[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpe?g|webp|gif)$`。 */
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** MIME → 扩展名；未知一律 png（与 `detectImageFormatFromBuffer` 默认一致）。 */
export function extensionForMime(mimeType: string): string {
  return EXT_BY_MIME[mimeType.toLowerCase()] ?? 'png'
}

/**
 * 段清洗：非 `[A-Za-z0-9._-]` 换成 `-`，去掉开头非字母数字字符，截断到 32 字。
 * 保证拼出的文件名满足白名单首字符为字母数字。
 */
export function sanitizeSegment(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '')
  const capped = cleaned.slice(0, 32)
  return capped.replace(/[._-]+$/, '') || 'image'
}

/** 本地时间 `YYYYMMDDHHmmss`。 */
export function timestampLocal(date: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  )
}

/** 生图落盘目录（cwd 相对，与展示链同口径）。 */
export function imagesDir(): string {
  return join(getCwd(), '.claude', 'images')
}

/**
 * 原图目录（展示图目录下的隐藏子目录）。仅当展示图被压缩时才写原图，
 * 供多轮改图回注**全保真**图（见 service.ts persistImages / sessionContext.ts）。
 * 该目录**永不被 markdown 引用**（展示链白名单只认扁平文件名）。
 */
export function sourceDirOf(dir: string = imagesDir()): string {
  return join(dir, '.source')
}

/**
 * 生成 `{provider}-{模型短名}-{时间戳}[-{n}].{ext}`。
 * 模型短名去尾 `-preview`（人读更短，不影响唯一性——时间戳已保证）。
 * `seq > 0` 时加显式序号后缀；同秒/同名冲突由 `writeImageFileAtomic` 递增兜底。
 */
export function buildImageFilename(opts: {
  provider: string
  model: string
  mimeType: string
  date?: Date
  seq?: number
}): string {
  const provider = sanitizeSegment(opts.provider)
  const model = sanitizeSegment(opts.model.replace(/-preview$/i, ''))
  const ts = timestampLocal(opts.date)
  const suffix = opts.seq && opts.seq > 0 ? `-${opts.seq}` : ''
  return `${provider}-${model}-${ts}${suffix}.${extensionForMime(opts.mimeType)}`
}

/**
 * 落盘到 `<dir>/<filename>`；同名已存在则依次试 `<名>-2`、`-3`… 直到取到空闲名。
 * 名字以 `open(..., 'wx')`（O_EXCL）原子占位——同秒连发生图、同批多图都不互相覆盖，
 * 且无「先查后写」竞态。返回实际落盘的文件名与绝对路径（调用方按返回名回填 `![](名)`）。
 */
export async function writeImageFileAtomic(
  bytes: Uint8Array,
  filename: string,
  dir: string = imagesDir(),
): Promise<{ name: string; path: string }> {
  await fs.mkdir(dir, { recursive: true })
  const dot = filename.lastIndexOf('.')
  const stem = dot > 0 ? filename.slice(0, dot) : filename
  const ext = dot > 0 ? filename.slice(dot) : ''
  for (let n = 1; ; n++) {
    const name = n === 1 ? filename : `${stem}-${n}${ext}`
    const full = join(dir, name)
    let handle
    try {
      handle = await fs.open(full, 'wx')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw e
    }
    try {
      await handle.writeFile(bytes)
    } catch (e) {
      await handle.close()
      await fs.unlink(full).catch(() => {})
      throw e
    }
    await handle.close()
    return { name, path: full }
  }
}

/**
 * 确保可被网关预览（≤ 4MB）。超限用 `compressImageBuffer` 压；压缩失败/仍超限
 * 则原样返回（调用方在文本里标注「图片过大，预览可能失败」，不静默丢图）。
 * `compressed` = 是否**真的**重编码过（供调用方决定要不要另存全保真原图）。
 */
export async function fitForViewer(
  bytes: Uint8Array,
  mimeType: string,
): Promise<{ bytes: Uint8Array; mimeType: string; ok: boolean; compressed: boolean }> {
  if (bytes.byteLength <= MAX_VIEWABLE_BYTES) {
    return { bytes, mimeType, ok: true, compressed: false }
  }
  try {
    const out = await compressImageBuffer(Buffer.from(bytes), MAX_VIEWABLE_BYTES, mimeType)
    const compressed = Buffer.from(out.base64, 'base64')
    const ok = compressed.byteLength <= MAX_VIEWABLE_BYTES
    return { bytes: compressed, mimeType: out.mediaType, ok, compressed: true }
  } catch (e) {
    logForDebugging(`[imagegen] compress failed: ${e instanceof Error ? e.message : String(e)}`)
    return { bytes, mimeType, ok: false, compressed: false }
  }
}

/** 审计条目（一行一条 JSONL）。 */
export interface ImageGenAuditEntry {
  ts: string
  provider: string
  model: string
  promptSummary: string
  files: string[]
  durationMs: number
  outcome: 'ok' | 'error'
  error?: string
  /** 本轮为多轮改图、自动回注的上一张生成图文件名（见 service.ts）。 */
  contextImage?: string
}

/**
 * 追加审计日志到 `<dir>/.imagegen-log.jsonl`。
 * 只追加、失败不致命（记 debug 日志），绝不因日志问题中断生图。
 */
export async function appendAuditLog(
  entry: ImageGenAuditEntry,
  dir: string = imagesDir(),
): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.appendFile(join(dir, '.imagegen-log.jsonl'), `${JSON.stringify(entry)}\n`)
  } catch (e) {
    logForDebugging(`[imagegen] audit log failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}
