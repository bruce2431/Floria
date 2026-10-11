/**
 * 生图能力层 —— 公共层（provider-neutral）。
 *
 * 职责：能力判定 → 选 adapter → 生成（超时/重试）→ 落盘 → `![](文件名)` 回填 →
 * 合成 Anthropic 响应（JSON / 伪造 SSE）→ 错误映射 → 审计日志。
 * **零厂商分支**：厂商差异全在 adapters/*.ts（本文件 import 它们仅为触发自注册）。
 *
 * 展示链（`.claude/images/` + `![](文件名)` + `/gateway/file` + CLI/web 渲染）
 * 与厂商无关，天然复用、零改动。
 */

import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { getSessionId } from '../../bootstrap/state.js'
import { logForDebugging } from '../../utils/debug.js'
import { detectImageFormatFromBuffer } from '../../utils/imageResizer.js'
import {
  getActiveApiKey,
  getActiveBaseUrl,
  getActiveProviderImageCapabilities,
  getSessionProviderName,
} from '../../utils/credentials/pool.js'
import { selectImageAdapter } from './registry.js'
import { resolveMentionedImages } from './mentionImages.js'
import { getLastImage, isUsable, setLastImage } from './sessionContext.js'
// 副作用导入：注册 gemini adapter（新增厂商只需在此加一行 import）。
import './adapters/gemini.js'
import {
  ImageGenerationError,
  type ImageCapabilities,
  type ImageGenerationContext,
  type ImageGenerationOptions,
  type ImageGenerationRequest,
  type ImageGenerationResult,
  type ImageGenerationUsage,
  type InputImage,
} from './types.js'
import {
  appendAuditLog,
  buildImageFilename,
  extensionForMime,
  fitForViewer,
  sourceDirOf,
  writeImageFileAtomic,
} from './store.js'

/** 单次生图超时（图片生成较慢，给足；超时后至多重试一次）。 */
const GENERATE_TIMEOUT_MS = 180_000

/** 供响应合成用的 usage（缺省 0——生图模型常不报 token）。 */
interface Usage {
  input_tokens: number
  output_tokens: number
}

// ── 能力判定 ─────────────────────────────────────────────────────────

/** 归一化后的生图能力解析结果：`model` 为**裸模型 id**（已去 `provider/` 前缀）。 */
export interface ResolvedImageCaps {
  model: string
  capabilities: ImageCapabilities
}

/**
 * **单一真源**：把请求里的模型 id 解析成「裸 id + 该模型能力声明」。
 * 容错 `provider/model` 形态（先原样查表，未命中再查尾段）；命中即返回**裸 id**
 * （直送 adapter 拼 URL 时不再带 provider 前缀）；非生图模型（`outputImage !== true`
 * 或未声明）⇒ null。纯函数——判据 / 请求装配 / adapter 选型三处共用，不各自实现。
 */
export function resolveImageCapabilities(
  caps: Record<string, ImageCapabilities> | null | undefined,
  model: string | undefined,
): ResolvedImageCaps | null {
  if (!caps || !model) return null
  const direct = caps[model]
  if (direct?.outputImage === true) return { model, capabilities: direct }
  const tail = model.split('/').pop()
  if (tail && tail !== model && caps[tail]?.outputImage === true) {
    return { model: tail, capabilities: caps[tail]! }
  }
  return null
}

/**
 * 请求体的 `model` 是否声明了「能出图」——**聊天链路唯一新增判据**，且是
 * provider-neutral 的（只查能力声明，不含任何厂商分支）。字段缺省 = 功能关闭。
 */
export function isImageOutputModel(model: string | undefined): boolean {
  return resolveImageCapabilities(getActiveProviderImageCapabilities(), model) !== null
}

/** 一个生图候选源：provider 名 + 其能力声明 + 该 provider 指定的生图模型。 */
export interface ImageTargetSource {
  provider: string
  capabilities: Record<string, ImageCapabilities> | null | undefined
  imageModel: string | null | undefined
}

/** 选定的生图目标：**裸模型 id** + 其能力 + 来源 provider（供装配运行上下文）。 */
export interface ImageGenTarget {
  /** 'session' = 本会话 provider 自有生图；'designated' = 回落凭据池 `tools.image`。 */
  source: 'session' | 'designated'
  provider: string
  model: string
  capabilities: ImageCapabilities
}

/**
 * **单一真源**：为本会话选出生图目标（纯函数，便于探针）。**会话 provider 优先**
 * ——本会话 provider 声明了可出图的 `imageModel` 就用它；否则回落到 `designated`
 * （凭据池 `tools.image`）——让无生图能力的文本会话（如只有 deepseek）仍能编排另
 * 一 provider 的生图模型。都没有 ⇒ null（工具关闭）。
 */
export function selectImageTarget(o: {
  session: ImageTargetSource
  designated: ImageTargetSource | null
}): ImageGenTarget | null {
  const s = resolveImageCapabilities(o.session.capabilities, o.session.imageModel ?? undefined)
  if (s) {
    return { source: 'session', provider: o.session.provider, model: s.model, capabilities: s.capabilities }
  }
  if (o.designated) {
    const d = resolveImageCapabilities(o.designated.capabilities, o.designated.imageModel ?? undefined)
    if (d) {
      return { source: 'designated', provider: o.designated.provider, model: d.model, capabilities: d.capabilities }
    }
  }
  return null
}

/**
 * `ImageGeneration` 工具是否对当前会话可用（纯函数，便于探针）。规则：存在一个可
 * 出图的生图目标（`selectImageTarget`——会话 provider 优先，回落凭据池 `tools.image`）；
 * 且**会话模型本身不是生图模型**——否则请求已由直连链（fetch 覆写）接管，工具只是
 * 重复入口。两模式互斥。
 */
export function isImageGenerationToolEnabled(o: {
  target: ImageGenTarget | null
  sessionCaps: Record<string, ImageCapabilities> | null | undefined
  sessionModel: string | null | undefined
}): boolean {
  if (!o.target) return false
  return resolveImageCapabilities(o.sessionCaps, o.sessionModel ?? undefined) === null
}

// ── 请求装配 ─────────────────────────────────────────────────────────

/**
 * 从 Anthropic 请求体取出生图所需：末条 user 消息的文本 → prompt、
 * image block → 输入图；tool_result 的文本一并降级为可见文本（本版不传工具）。
 */
export function extractPromptAndImages(body: any): {
  prompt: string
  images: InputImage[]
} {
  const msgs: any[] = Array.isArray(body?.messages) ? body.messages : []
  let lastUser: any = null
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === 'user') {
      lastUser = msgs[i]
      break
    }
  }

  const texts: string[] = []
  const images: InputImage[] = []
  const content = lastUser?.content
  const blocks: any[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []

  for (const b of blocks) {
    if (b?.type === 'text' && typeof b.text === 'string') {
      texts.push(b.text)
    } else if (b?.type === 'image' && b?.source?.type === 'base64' && b.source.data) {
      images.push({
        bytes: new Uint8Array(Buffer.from(String(b.source.data), 'base64')),
        mimeType: String(b.source.media_type || 'image/png'),
      })
    } else if (b?.type === 'tool_result') {
      texts.push(toolResultText(b))
    }
  }

  return { prompt: texts.filter(Boolean).join('\n').trim(), images }
}

/** tool_result 内容 → 文本（降级，不静默）。 */
function toolResultText(block: any): string {
  const c = block?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c
      .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
      .map((p: any) => p.text)
      .join('\n')
  }
  return ''
}

// ── 生成（超时 + 至多重试一次） ───────────────────────────────────────

/** 仅网络/5xx 可重试；生图非幂等，重试至多一次，避免重复计费。 */
function isRetryable(e: unknown, userAborted: boolean): boolean {
  if (userAborted) return false
  if (e instanceof ImageGenerationError) return (e.httpStatus ?? 0) >= 500
  return true // 网络/未知
}

async function generateWithRetry(
  req: ImageGenerationRequest,
  ctx: ImageGenerationContext,
): Promise<ImageGenerationResult> {
  const adapter = selectImageAdapter(ctx)
  if (!adapter) {
    throw new ImageGenerationError(
      'NO_ADAPTER',
      `无可用生图 adapter（provider=${ctx.provider}, model=${ctx.model}）`,
    )
  }

  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    const ac = new AbortController()
    const onAbort = () => ac.abort()
    ctx.signal?.addEventListener('abort', onAbort)
    const timer = setTimeout(() => ac.abort(), GENERATE_TIMEOUT_MS)
    try {
      return await adapter.generate(req, { ...ctx, signal: ac.signal })
    } catch (e) {
      lastErr = e
      if (attempt === 1 || !isRetryable(e, ctx.signal?.aborted === true)) throw e
    } finally {
      clearTimeout(timer)
      ctx.signal?.removeEventListener('abort', onAbort)
    }
  }
  throw lastErr
}

// ── 后处理：落盘 + 回填 ───────────────────────────────────────────────

const KNOWN_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function resolveMime(declared: string | undefined, bytes: Uint8Array): string {
  const d = (declared ?? '').toLowerCase()
  if (KNOWN_MIME.has(d)) return d
  return detectImageFormatFromBuffer(Buffer.from(bytes))
}

export interface PersistedImage {
  /** 展示图文件名（回填 `![](名)` 用；扁平，符合展示链白名单）。 */
  name: string
  /** 展示图绝对路径。 */
  path: string
  /** 全保真原图绝对路径；未压缩时 === `path`。多轮改图回注读它。 */
  sourcePath: string
  /** 展示图 MIME。 */
  mimeType: string
  /** 原图 MIME（未压缩时 === `mimeType`）。 */
  sourceMimeType: string
}

async function persistImages(
  result: ImageGenerationResult,
  provider: string,
  model: string,
  date: Date,
  dir?: string,
): Promise<{ entries: PersistedImage[]; oversized: boolean }> {
  const entries: PersistedImage[] = []
  let oversized = false
  for (const img of result.images) {
    const srcMime = resolveMime(img.mimeType, img.bytes)
    const fit = await fitForViewer(img.bytes, srcMime)
    if (!fit.ok) oversized = true
    const name = buildImageFilename({ provider, model, mimeType: fit.mimeType, date })
    const written = await writeImageFileAtomic(fit.bytes, name, dir)
    // 仅在展示图被压缩时另存全保真原图（未压缩则展示图即原图，零额外写盘）。
    // 原图按**源 MIME** 定扩展名（压缩可能改格式：png→jpg），故源名可能与展示名不同。
    let sourcePath = written.path
    let sourceMimeType = fit.mimeType
    if (fit.compressed) {
      const dot = written.name.lastIndexOf('.')
      const stem = dot > 0 ? written.name.slice(0, dot) : written.name
      const srcName = `${stem}.${extensionForMime(srcMime)}`
      const src = await writeImageFileAtomic(img.bytes, srcName, sourceDirOf(dir))
      sourcePath = src.path
      sourceMimeType = srcMime
    }
    entries.push({
      name: written.name,
      path: written.path,
      sourcePath,
      mimeType: fit.mimeType,
      sourceMimeType,
    })
  }
  return { entries, oversized }
}

/** 组装可见文本（direct 与 tool 两入口共用）。 */
function composeText(o: {
  text?: string
  files: string[]
  oversized: boolean
  failure?: string
  notes?: string[]
}): string {
  const lines: string[] = []
  if (o.failure) lines.push(`[生图失败] ${o.failure}`)
  else if (o.text) lines.push(o.text)
  for (const f of o.files) lines.push(`![](${f})`)
  if (o.oversized) lines.push('（图片过大，预览可能失败）')
  for (const n of o.notes ?? []) lines.push(n)
  return lines.join('\n\n')
}

// ── 共用核心（direct 与 tool 两入口都转调它） ─────────────────────────

/** 生图能力层运行上下文（由调用方从凭据池装配；探针可直连）。 */
export interface ImageGenRunContext {
  provider: string
  model: string
  baseUrl: string
  apiKey: string
  capabilities: ImageCapabilities
  /** 发请求手段（探针注入假实现；缺省 globalThis.fetch）。 */
  fetchImpl?: typeof globalThis.fetch
  signal?: AbortSignal
  /** 落盘目录覆盖（探针）；缺省 `.claude/images/`。 */
  dir?: string
  /** 会话 id——多轮改图上下文（最近生成图）按它存取；缺省 = 不启用上下文回注。 */
  sessionId?: string
  /** `@文件:图片` 令牌的解析根（缺省 `getPortableRoot()`；探针注入临时根）。 */
  mentionRoot?: string
}

/** 生图核心产物（**结构化**，不夹带 Anthropic 响应形态）。 */
export interface GeneratedImages {
  files: PersistedImage[]
  /** adapter 附带解说文本（可无）。 */
  text?: string
  usage?: ImageGenerationUsage
  oversized: boolean
  /** 非静默提示（mention 告警 + 上下文标记），调用方并入可见文本。 */
  notes: string[]
  /** 本轮自动回注的上一张生成图文件名（无则缺省）。 */
  contextImage?: string
}

/**
 * 跑一次生图核心：输入装配（显式附图 + `@文件:图片` + 会话上下文回注）→
 * 生成（超时/重试）→ 落盘（展示图 + 原图）→ 记会话上下文 → 审计。
 * 失败抛 `ImageGenerationError`（已记 error 审计）——两条入口各自负责把错误
 * 映射成各自的形态（Anthropic 响应 / 工具结果文本）。
 */
export async function generateImages(
  rc: ImageGenRunContext,
  req: { prompt: string; images?: InputImage[]; options?: ImageGenerationOptions },
): Promise<GeneratedImages> {
  const prompt = req.prompt
  const started = Date.now()
  const date = new Date()

  // 输入图组装（优先级：显式附图 > `@文件:图片` 令牌 > 会话上下文回注）。
  // B：把 web 的 `[@文件:<图片>]` 文本令牌解析成真字节（仅 inputImage 能力有）。
  const mentioned = await resolveMentionedImages(prompt, {
    capabilities: rc.capabilities,
    ...(rc.mentionRoot ? { root: rc.mentionRoot } : {}),
  })
  const inputImages: InputImage[] = [...(req.images ?? []), ...mentioned.images]

  // A：本轮无任何附图、且模型声明可改图 ⇒ 回注上一张生成图（读**原图**）。
  let contextImage: string | undefined
  if (
    inputImages.length === 0 &&
    (rc.capabilities.imageEdit === true || rc.capabilities.multiTurnImage === true) &&
    rc.sessionId
  ) {
    const last = getLastImage(rc.sessionId, rc.dir)
    if (last && isUsable(last)) {
      try {
        inputImages.push({
          bytes: new Uint8Array(readFileSync(last.sourcePath ?? last.path)),
          mimeType: last.mimeType,
        })
        contextImage = last.fileName
      } catch (e) {
        logForDebugging(
          `[imagegen] context image unreadable: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
    }
  }

  const notes = [...mentioned.warnings]

  const audit = async (
    files: string[],
    outcome: 'ok' | 'error',
    error?: string,
  ): Promise<void> => {
    await appendAuditLog(
      {
        ts: date.toISOString(),
        provider: rc.provider,
        model: rc.model,
        promptSummary: prompt.slice(0, 80),
        files,
        durationMs: Date.now() - started,
        outcome,
        ...(error ? { error } : {}),
        ...(contextImage ? { contextImage } : {}),
      },
      rc.dir,
    )
  }

  const ctx: ImageGenerationContext = {
    provider: rc.provider,
    model: rc.model,
    baseUrl: rc.baseUrl,
    apiKey: rc.apiKey,
    capabilities: rc.capabilities,
    ...(rc.fetchImpl ? { fetchImpl: rc.fetchImpl } : {}),
    ...(rc.signal ? { signal: rc.signal } : {}),
  }

  let result: ImageGenerationResult
  try {
    result = await generateWithRetry(
      { model: rc.model, prompt, images: inputImages, ...(req.options ? { options: req.options } : {}) },
      ctx,
    )
    if (result.images.length === 0) {
      throw new ImageGenerationError('EMPTY_RESPONSE', result.text || '模型未返回图片')
    }
  } catch (e) {
    const err =
      e instanceof ImageGenerationError
        ? e
        : new ImageGenerationError('UNKNOWN', e instanceof Error ? e.message : String(e))
    logForDebugging(`[imagegen] failed: ${err.code} ${err.message}`)
    await audit([], 'error', `${err.code}: ${err.message}`)
    throw err
  }

  const { entries, oversized } = await persistImages(result, rc.provider, rc.model, date, rc.dir)
  if (rc.sessionId && entries.length > 0) {
    const last = entries[entries.length - 1]!
    setLastImage(
      rc.sessionId,
      {
        fileName: last.name,
        path: last.path,
        sourcePath: last.sourcePath,
        mimeType: last.sourceMimeType,
        provider: rc.provider,
        model: rc.model,
        ts: date.getTime(),
      },
      rc.dir,
    )
  }

  const outNotes = [...notes]
  if (contextImage) outNotes.push('（基于上一张图继续编辑）')
  await audit(entries.map(e => e.name), 'ok')

  return {
    files: entries,
    ...(result.text ? { text: result.text } : {}),
    ...(result.usage ? { usage: result.usage } : {}),
    oversized,
    notes: outNotes,
    ...(contextImage ? { contextImage } : {}),
  }
}

// ── 响应合成（Anthropic 形态） ────────────────────────────────────────

function anthropicMessage(model: string, text: string, usage: Usage): Response {
  return new Response(
    JSON.stringify({
      id: `msg_${randomUUID().replace(/-/g, '')}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

/** 伪造严格 Anthropic SSE 序（index 单调），确保真 SDK 能解析。 */
function anthropicSSE(model: string, text: string, usage: Usage): Response {
  const id = `msg_${randomUUID().replace(/-/g, '')}`
  const frame = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  const body =
    frame('message_start', {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: usage.input_tokens, output_tokens: 0 },
      },
    }) +
    frame('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }) +
    frame('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    }) +
    frame('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    frame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: usage.output_tokens },
    }) +
    frame('message_stop', { type: 'message_stop' })
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

function errorResponse(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ type: 'error', error: { type: 'api_error', message } }),
    { status, headers: { 'Content-Type': 'application/json' } },
  )
}

function emit(
  stream: boolean,
  model: string,
  text: string,
  usage: Usage,
): Response {
  return stream ? anthropicSSE(model, text, usage) : anthropicMessage(model, text, usage)
}

// ── 主入口（direct：薄壳，转调 generateImages 后合成 Anthropic 响应） ──

/**
 * 跑一次生图能力层，返回合成的 Anthropic Response（**纯函数式**，凭据/目录全由
 * `rc` 传入——探针可离线直测，不经全局凭据池）。
 */
export async function runImageGeneration(
  body: any,
  rc: ImageGenRunContext,
): Promise<Response> {
  const model: string = rc.model || body?.model || ''
  const stream: boolean = body?.stream === true

  const { prompt, images } = extractPromptAndImages(body)

  let g: GeneratedImages
  try {
    g = await generateImages(rc, { prompt, images })
  } catch (e) {
    const err =
      e instanceof ImageGenerationError
        ? e
        : new ImageGenerationError('UNKNOWN', e instanceof Error ? e.message : String(e))
    if (err.httpStatus) return errorResponse(err.httpStatus, err.message)
    return emit(stream, model, composeText({ files: [], oversized: false, failure: err.message }), {
      input_tokens: 0,
      output_tokens: 0,
    })
  }

  const text = composeText({
    ...(g.text ? { text: g.text } : {}),
    files: g.files.map(f => f.name),
    oversized: g.oversized,
    notes: g.notes,
  })
  const usage: Usage = {
    input_tokens: g.usage?.inputTokens ?? 0,
    output_tokens: g.usage?.outputTokens ?? 0,
  }
  return emit(stream, model, text, usage)
}

export interface ImageGenDispatchOptions {
  /** 生图请求所用 fetch（探针注入；缺省 globalThis.fetch）。 */
  fetchImpl?: typeof globalThis.fetch
  signal?: AbortSignal
}

/**
 * 处理一次生图请求（凭据池装配上下文后转 runImageGeneration）。
 * 只有 `isImageOutputModel(body.model)` 为真时才被调用（见 client.ts 分流）。
 */
export async function handleImageGeneration(
  body: any,
  opts: ImageGenDispatchOptions = {},
): Promise<Response> {
  // 统一能力解析：`provider/model` 也能拿到正确能力，且模型归一化为**裸 id**
  // （直送 adapter 拼 URL 不带 provider 前缀）。
  const resolved = resolveImageCapabilities(getActiveProviderImageCapabilities(), body?.model)
  return runImageGeneration(body, {
    provider: getSessionProviderName(),
    model: resolved?.model ?? body?.model ?? '',
    baseUrl: getActiveBaseUrl() ?? '',
    apiKey: getActiveApiKey() ?? '',
    capabilities: resolved?.capabilities ?? {},
    sessionId: getSessionId(),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
}

/**
 * 构造 client.ts 用的 fetch 覆写：命中生图模型转能力层，否则逐字透传给 inner。
 * **零厂商分支**：只查 `isImageOutputModel`（能力声明）。
 */
export function createImageGenDispatchFetch(opts: {
  inner?: typeof globalThis.fetch
  fetchImpl?: typeof globalThis.fetch
}): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const bodyText = typeof init?.body === 'string' ? init.body : null
    if (bodyText && url.includes('/v1/messages') && !url.includes('/count_tokens')) {
      let body: any = null
      try {
        body = JSON.parse(bodyText)
      } catch {
        body = null
      }
      if (body && isImageOutputModel(body.model)) {
        return handleImageGeneration(body, {
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
          ...(init?.signal ? { signal: init.signal } : {}),
        })
      }
    }
    const inner = opts.inner ?? globalThis.fetch
    return inner(input, init)
  }) as typeof globalThis.fetch
}
