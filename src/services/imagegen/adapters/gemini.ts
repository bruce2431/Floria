/**
 * Gemini 生图 adapter —— 全项目**唯一**含 Gemini 特殊逻辑处。
 *
 * 走原生 `POST {base}/models/<model>:generateContent`（**非流式**——图片是原子
 * 产物，流式无收益），读 `candidates[0].content.parts[].inlineData`。
 * 绕过 `chat/completions` 的原因：Google 的 OpenAI 兼容层不回传生成图（有时
 * 200 但 `message.content` 为空＝静默丢图），图其实生成了但序列化不出。
 *
 * 公共层（选型 / 落盘 / 回填 / 错误 / 审计）见 ../service.ts、../store.ts。
 * 本文件只做协议差异：进料装配 + 响应解析 + 上游错误映射。
 */

import {
  ImageGenerationError,
  type ImageGenerationAdapter,
  type ImageGenerationContext,
  type ImageGenerationRequest,
  type ImageGenerationResult,
} from '../types.js'
import { registerImageAdapter } from '../registry.js'

/** 上游 finishReason 中表示「被拦/无有效图」的值 → 明确失败（业务失败，回 assistant 文本）。 */
const BLOCKED_REASONS: Record<string, string> = {
  IMAGE_RECITATION: '图片因版权/重复内容限制未能生成（IMAGE_RECITATION），请调整提示词后重试。',
  RECITATION: '内容被判定为复述已有素材（RECITATION），请改写提示词后重试。',
  SAFETY: '内容被安全策略拦截（SAFETY），请调整提示词后重试。',
  PROHIBITED_CONTENT: '内容被禁止（PROHIBITED_CONTENT）。',
  BLOCKLIST: '提示词命中屏蔽词表（BLOCKLIST）。',
  SPII: '提示词含敏感个人信息（SPII）。',
}

/** 原生 base：去尾 `/`，再去尾 `/openai`（配置里是 OpenAI 兼容端点）。 */
export function nativeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/openai$/i, '')
}

/** 去 `models/` 前缀，防 `models/models/…`。 */
function normalizeModel(model: string): string {
  return model.replace(/^models\//i, '')
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

/** 上游 parts → 统一结果。 */
function parseResponse(json: any, model: string): ImageGenerationResult {
  const candidate = json?.candidates?.[0]
  const finishReason: string | undefined = candidate?.finishReason
  const parts: any[] = candidate?.content?.parts ?? []

  const images: { bytes: Uint8Array; mimeType: string }[] = []
  const texts: string[] = []
  for (const p of parts) {
    const inline = p?.inlineData ?? p?.inline_data
    if (inline?.data) {
      images.push({
        bytes: new Uint8Array(Buffer.from(String(inline.data), 'base64')),
        mimeType: String(inline.mimeType ?? inline.mime_type ?? 'image/png'),
      })
    } else if (typeof p?.text === 'string' && p.text.length > 0) {
      texts.push(p.text)
    }
  }

  // 有图 ⇒ 成功（即便同时带文字，如解说）。
  if (images.length > 0) {
    const um = json?.usageMetadata
    return {
      images,
      text: texts.join('\n').trim() || undefined,
      usage: um
        ? {
            inputTokens: um.promptTokenCount,
            outputTokens: um.candidatesTokenCount,
          }
        : undefined,
    }
  }

  // 无图 ⇒ 明确失败：先看拦截面，再看空响应。
  const blocked = finishReason && BLOCKED_REASONS[finishReason]
  if (blocked) {
    throw new ImageGenerationError(finishReason!, blocked)
  }
  const promptBlock = json?.promptFeedback?.blockReason
  if (promptBlock) {
    throw new ImageGenerationError(
      String(promptBlock),
      `提示词被上游拦截（${promptBlock}），请调整后重试。`,
    )
  }
  const detail = texts.join('\n').trim()
  throw new ImageGenerationError(
    'EMPTY_RESPONSE',
    `模型未返回图片${finishReason ? `（finishReason=${finishReason}）` : ''}${detail ? `：${detail}` : ''}`,
  )
}

export const geminiImageAdapter: ImageGenerationAdapter = {
  name: 'gemini',

  supports(ctx: ImageGenerationContext): boolean {
    return (
      ctx.provider === 'gemini' ||
      /generativelanguage\.googleapis\.com/i.test(ctx.baseUrl)
    )
  },

  async generate(
    req: ImageGenerationRequest,
    ctx: ImageGenerationContext,
  ): Promise<ImageGenerationResult> {
    const fetchImpl = ctx.fetchImpl ?? globalThis.fetch
    const base = nativeBaseUrl(ctx.baseUrl)
    const model = normalizeModel(req.model)
    const url = `${base}/models/${model}:generateContent`

    const parts: any[] = [{ text: req.prompt }]
    for (const img of req.images ?? []) {
      parts.push({ inlineData: { mimeType: img.mimeType, data: b64(img.bytes) } })
    }

    const generationConfig: Record<string, unknown> = {}
    if (req.options?.aspectRatio) {
      generationConfig.imageConfig = { aspectRatio: req.options.aspectRatio }
    }

    const body = {
      contents: [{ role: 'user', parts }],
      ...(Object.keys(generationConfig).length > 0 && { generationConfig }),
    }

    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': ctx.apiKey,
      },
      body: JSON.stringify(body),
      signal: ctx.signal,
    })

    if (!res.ok) {
      const raw = await res.text().catch(() => '')
      let msg = raw
      try {
        msg = JSON.parse(raw)?.error?.message ?? raw
      } catch {
        /* keep raw */
      }
      throw new ImageGenerationError(
        'UPSTREAM_HTTP',
        `Gemini 生图请求失败（HTTP ${res.status}）：${msg || 'no body'}`,
        res.status,
      )
    }

    const json = await res.json()
    return parseResponse(json, model)
  },
}

registerImageAdapter(geminiImageAdapter)
