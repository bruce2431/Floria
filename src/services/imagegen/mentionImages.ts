/**
 * `@文件:图片` 令牌 → 真图片字节（**服务端**解析，前端中立、单点）。
 *
 * web 的 `@` 路径 chip 产出纯文本令牌 `[@文件:<工作区相对路径>]`（见
 * `gateway/web-src/core/mention-syntax.js` 的 `MENTION_PATH_RE`），而生图模型会话
 * **不传 tools** ⇒ 模型拿不到该路径的字节。此模块在**请求装配期**把指向图片的令牌
 * 解析成 `InputImage`，让 `@图片路径 把背景改成黄昏` 真正生效。
 *
 * 仅当 `capabilities.inputImage` 为真时调用。非图片扩展名的令牌**静默跳过**——那是给
 * Read 工具的普通 `@文件`，不在生图范围。路径基准 = 工作区根（`getPortableRoot()`，
 * 与 `/gateway/fs` 同基准）；先词法校验（越界/绝对路径拒绝），再 `resolveRealWithinRoot`
 * 做**真实路径**复核（挡符号链接/junction 逃逸）并强制为普通文件。解析失败**不静默**：
 * 进 `warnings` 由调用方回填正文。
 */

import { readFileSync, realpathSync, statSync } from 'fs'
import { isAbsolute, resolve, sep } from 'path'
import { getPortableRoot } from '../../utils/envUtils.js'
import { detectImageFormatFromBuffer } from '../../utils/imageResizer.js'
import type { ImageCapabilities, InputImage } from './types.js'

/** 只认 `[@文件:<路径>]`（`[@目录:]` 非文件；引用/回复/PDF 令牌不参与）。
 *  路径转义与前端同文法（`]`→`\]`、`\`→`\\`），否则含 `]` 的文件名令牌会在此提前收口（2026-10-25）。 */
export const MENTION_IMAGE_PATH_RE = /\[@文件:((?:[^\]\\\n]|\\.)+)\]/g

/** 令牌内的路径解码（`\X` → `X`；序列化侧已把反斜杠成对转义）。 */
function unescapeMentionPath(p: string): string {
  return p.replace(/\\(.)/g, '$1')
}

/** 图片扩展名白名单（与展示链一致）。 */
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)$/i

/** 单张引用图字节上限（网关读侧 4MB 同量级，略放宽）。 */
export const MAX_MENTIONED_IMAGE_BYTES = 8 * 1024 * 1024

/** 单轮最多带入的引用图数（防滥用）。 */
const MAX_MENTIONED_IMAGES = 8

export interface MentionResolveOptions {
  capabilities: ImageCapabilities
  /** 工作区根（缺省 `getPortableRoot()`；探针注入临时根）。 */
  root?: string
  maxBytes?: number
  /** 读文件（探针注入）。 */
  readFile?: (abs: string) => Uint8Array
  /** 取文件大小（探针注入）。 */
  statSize?: (abs: string) => number
}

/** 在工作区根内**词法**解析相对路径；越界/绝对路径/空串 ⇒ null。 */
export function resolveWithinRoot(root: string, rel: string): string | null {
  if (!rel || isAbsolute(rel)) return null
  const base = resolve(root)
  const abs = resolve(base, rel)
  return abs === base || abs.startsWith(base + sep) ? abs : null
}

/** `resolveRealWithinRoot` 的结局：成功取真实路径，失败带**原因**（供 caller 分类告警）。 */
export type RealPathOutcome =
  | { ok: true; path: string }
  | { ok: false; reason: 'escape' | 'not-file' | 'unreadable' }

/**
 * 词法校验 + **真实路径**校验 + 普通文件校验：挡符号链接/junction 逃逸、挡目录。
 * 词法越界 ⇒ `escape`；realpath/stat 抛（不存在/无权限）⇒ `unreadable`；
 * 真实路径逃出根 ⇒ `escape`；非普通文件 ⇒ `not-file`。
 */
export function resolveRealWithinRoot(root: string, rel: string): RealPathOutcome {
  const lex = resolveWithinRoot(root, rel)
  if (!lex) return { ok: false, reason: 'escape' }
  let realRoot: string
  let realAbs: string
  try {
    realRoot = realpathSync(root)
    realAbs = realpathSync(lex)
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  if (realAbs !== realRoot && !realAbs.startsWith(realRoot + sep)) {
    return { ok: false, reason: 'escape' }
  }
  try {
    if (!statSync(realAbs).isFile()) return { ok: false, reason: 'not-file' }
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  return { ok: true, path: realAbs }
}

/** 从 prompt 文本里抽出指向图片的引用路径（按出现顺序去重）。 */
export function extractImageMentionPaths(prompt: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of prompt.matchAll(MENTION_IMAGE_PATH_RE)) {
    const raw = unescapeMentionPath(m[1] ?? '').trim().replace(/^["']|["']$/g, '')
    if (!IMAGE_EXT_RE.test(raw) || seen.has(raw)) continue
    seen.add(raw)
    out.push(raw)
  }
  return out
}

/**
 * 解析 prompt 中的 `@文件:图片` 令牌为输入图。
 * 非图片扩展名静默跳过；缺文件/读失败/超限/越界进 `warnings`（不静默丢）。
 */
export async function resolveMentionedImages(
  prompt: string,
  opts: MentionResolveOptions,
): Promise<{ images: InputImage[]; warnings: string[] }> {
  const images: InputImage[] = []
  const warnings: string[] = []
  if (opts.capabilities.inputImage !== true) return { images, warnings }

  const root = opts.root ?? getPortableRoot()
  const maxBytes = opts.maxBytes ?? MAX_MENTIONED_IMAGE_BYTES
  const readFile = opts.readFile ?? ((abs: string) => readFileSync(abs))
  const statSize = opts.statSize ?? ((abs: string) => statSync(abs).size)

  for (const rel of extractImageMentionPaths(prompt)) {
    if (images.length >= MAX_MENTIONED_IMAGES) {
      warnings.push(`引用图片过多，仅取前 ${MAX_MENTIONED_IMAGES} 张`)
      break
    }
    const real = resolveRealWithinRoot(root, rel)
    // 注意：`=== false` 而非 `!real.ok`——tsconfig `strict:false` 下真值收窄不拆
    // `{ok:true}|{ok:false}` 判别联合（TS7），`!real.ok` 会丢 `reason` 的类型。
    if (real.ok === false) {
      warnings.push(
        real.reason === 'escape'
          ? `引用路径越界，已忽略：${rel}`
          : real.reason === 'not-file'
            ? `引用目标不是文件，已忽略：${rel}`
            : `引用图读取失败，已忽略：${rel}`,
      )
      continue
    }
    try {
      const size = statSize(real.path)
      if (size > maxBytes) {
        warnings.push(`引用图过大（${Math.round(size / 1024)} KB），已忽略：${rel}`)
        continue
      }
      const bytes = readFile(real.path)
      images.push({ bytes, mimeType: detectImageFormatFromBuffer(Buffer.from(bytes)) })
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      warnings.push(`引用图读取失败，已忽略：${rel}（${why}）`)
    }
  }
  return { images, warnings }
}
