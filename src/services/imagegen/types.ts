/**
 * Image generation capability layer — provider-neutral contracts.
 *
 * 生图能力层与「协议适配」正交：聊天链路只按能力判定分流（见
 * services/imagegen/service.ts），厂商差异一律下沉到 adapters/*.ts。
 * 新增一家生图供应商 = 实现 ImageGenerationAdapter + registerImageAdapter()，
 * 公共层（选型 / 下载 / 解码 / 落盘 / `![](文件名)` 回填 / 错误 / 审计）不再改。
 *
 * 展示链（落盘 `.claude/images/` + `![](文件名)` + `/gateway/file` + CLI/web 渲染）
 * 与厂商无关，天然复用。
 */

/** 生图相关能力维度（与 `modelVision` 的输入侧识图并列，互不覆盖）。 */
export interface ImageCapabilities {
  /** 能吃图（图片作为输入） */
  inputImage?: boolean
  /** 能出图 —— 也是「请求是否交给生图能力层」的唯一判据 */
  outputImage?: boolean
  /** 能改图（带图编辑） */
  imageEdit?: boolean
  /** 支持多轮带图编辑（本版不启用自动回灌，仅作声明维度保留） */
  multiTurnImage?: boolean
}

/** 一张输入图片（字节 + MIME）。 */
export interface InputImage {
  bytes: Uint8Array
  mimeType: string
}

/** 一张生成图片（字节 + MIME）。 */
export interface GeneratedImage {
  bytes: Uint8Array
  mimeType: string
}

/** 各厂商通用的生成参数（可选；adapter 自行决定支持哪些）。 */
export interface ImageGenerationOptions {
  size?: string
  quality?: string
  aspectRatio?: string
}

/** 统一输入。 */
export interface ImageGenerationRequest {
  model: string
  prompt: string
  images?: InputImage[]
  options?: ImageGenerationOptions
}

export interface ImageGenerationUsage {
  inputTokens?: number
  outputTokens?: number
}

/** 统一输出。 */
export interface ImageGenerationResult {
  images: GeneratedImage[]
  text?: string
  usage?: ImageGenerationUsage
}

/** 选型上下文：公共层据此挑 adapter，adapter 据此发请求。 */
export interface ImageGenerationContext {
  /** 供应商名，如 'gemini' | 'openai' | 'glm' | 'grok' */
  provider: string
  model: string
  baseUrl: string
  apiKey: string
  capabilities: ImageCapabilities
  /** 发请求手段（默认 globalThis.fetch；探针注入假实现）。 */
  fetchImpl?: typeof globalThis.fetch
  signal?: AbortSignal
}

/** 一家厂商只负责协议差异。 */
export interface ImageGenerationAdapter {
  name: string
  /** 本 adapter 是否认得这个上下文。 */
  supports(ctx: ImageGenerationContext): boolean
  /** 生成（可含多图）。失败一律抛 ImageGenerationError。 */
  generate(
    req: ImageGenerationRequest,
    ctx: ImageGenerationContext,
  ): Promise<ImageGenerationResult>
}

/**
 * 生图错误。`httpStatus` 存在 = 上游 HTTP 失败 → 上层回非 2xx Anthropic error
 * JSON；不存在 = 业务失败（版权/安全/空响应）→ 上层回 assistant 文本，保证
 * CLI/web 都能看见。
 */
export class ImageGenerationError extends Error {
  readonly code: string
  readonly httpStatus?: number

  constructor(code: string, message: string, httpStatus?: number) {
    super(message)
    this.name = 'ImageGenerationError'
    this.code = code
    this.httpStatus = httpStatus
  }
}
