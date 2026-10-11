/**
 * `ImageGeneration` 工具 —— **主模型编排生图**入口（direct / orchestrated 分层）。
 *
 * 直连链（会话模型 = 生图模型，经 fetch 覆写）见 `services/imagegen/service.ts`
 * 的 `createImageGenDispatchFetch`；本工具服务**文本模型会话**：模型调它 → 转调
 * 同一生图核心 `generateImages`（共享输入装配 / 落盘 / 记上下文 / 审计）。
 *
 * 运行态门控（`isEnabled`）：存在一个可出图的**生图目标** + **当前会话主循环模型**
 * 本身非生图模型（与直连链互斥）。生图目标**会话 provider 优先**（自有 `imageModel`
 * 可出图即用），否则回落凭据池 `tools.image` 绑定的 provider——文本会话 provider 无
 * 生图能力（如只有 deepseek）时仍能编排另一 provider 的生图模型；两者都不行则关闭。
 * 会话模型取自 `getMainLoopModel()`——它含 `/model` 会话 override / web 切换结果，而非
 * provider 启动快照（`getActiveModel()` 只看绑定 provider 的 activeModel，会漏掉本会话
 * 切换）。未配置的会话该工具**不出现**，文本链路零影响（同 client.ts 按能力判定的既有模式）。
 *
 * 可见性 = **靠模型回显**：工具结果文本含 `![](文件名)` 行 + 一行指示；web 只渲染
 * assistant 文本（不渲染工具结果的 markdown）⇒ 模型须在回复中原样输出该行，用户才
 * 能看到图片。零前端改动。
 */

import { readFileSync } from 'fs'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { getSessionId } from '../../bootstrap/state.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getPortableRoot } from '../../utils/envUtils.js'
import { detectImageFormatFromBuffer } from '../../utils/imageResizer.js'
import {
  getActiveApiKey,
  getActiveBaseUrl,
  getActiveProviderImageCapabilities,
  getActiveProviderImageModel,
  getProviderApiKey,
  getSessionProviderName,
  getToolProviderConfig,
} from '../../utils/credentials/pool.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import type { PermissionResult } from '../../utils/permissions/PermissionResult.js'
import { resolveRealWithinRoot } from '../../services/imagegen/mentionImages.js'
import {
  generateImages,
  isImageGenerationToolEnabled,
  selectImageTarget,
  type ImageGenTarget,
  type ImageGenRunContext,
} from '../../services/imagegen/service.js'
import type { ImageCapabilities, InputImage } from '../../services/imagegen/types.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseRejectedMessage,
} from './UI.js'

export const IMAGE_GENERATION_TOOL_NAME = 'ImageGeneration'

/**
 * 本会话的生图目标 + 运行凭据。**会话 provider 优先**（自有 `imageModel` 可出图即用），
 * 否则回落凭据池 `tools.image` 绑定的 provider（其 `imageCapabilities` / `imageModel` /
 * `baseUrl` / 钥匙）。都没有 ⇒ null（工具关闭）。凭据随目标来源取——回落 provider 的
 * 端点/钥匙由该 provider 自己的配置给出，与会话绑定无关（会话访问器够不着它）。
 */
function resolveImageTarget(): {
  target: ImageGenTarget
  sessionCaps: Record<string, ImageCapabilities> | null | undefined
  baseUrl: string
  apiKey: string
} | null {
  const sessionCaps = getActiveProviderImageCapabilities()
  const designated = getToolProviderConfig('image')
  const target = selectImageTarget({
    session: {
      provider: getSessionProviderName(),
      capabilities: sessionCaps,
      imageModel: getActiveProviderImageModel(),
    },
    designated: designated
      ? {
          provider: designated.name,
          capabilities: designated.config.imageCapabilities,
          imageModel: designated.model ?? designated.config.imageModel,
        }
      : null,
  })
  if (!target) return null
  if (target.source === 'session') {
    return {
      target,
      sessionCaps,
      baseUrl: getActiveBaseUrl() ?? '',
      apiKey: getActiveApiKey() ?? '',
    }
  }
  const cfg = designated!.config
  return { target, sessionCaps, baseUrl: cfg.baseUrl, apiKey: getProviderApiKey(cfg) ?? '' }
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    prompt: z.string().min(1).describe('生图提示词（可含 `[@文件:图片]` 令牌引用工作区内的图）'),
    image_path: z
      .string()
      .optional()
      .describe('可选：工作区相对路径的参考图 / 待改图（如 `.claude/images/x.png`）'),
    aspect_ratio: z
      .string()
      .optional()
      .describe('可选：宽高比，如 `16:9`、`1:1`（厂商支持时生效）'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    ok: z.boolean().describe('是否成功生成图片'),
    text: z.string().describe('给模型的可见结果文本（含 ![](文件名) 行）'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

/** 参考图不可用的可见原因（不静默）。 */
function unusableReason(reason: 'escape' | 'not-file' | 'unreadable', rel: string): string {
  const why =
    reason === 'escape'
      ? '越界（须为工作区内的相对路径）'
      : reason === 'not-file'
        ? '不是文件'
        : '不存在或不可读'
  return `[生图失败] 参考图不可用（${why}）：${rel}`
}

export const ImageGenerationTool = buildTool({
  isMcp: false,
  name: IMAGE_GENERATION_TOOL_NAME,
  searchHint: 'generate or edit an image from a text prompt',
  maxResultSizeChars: 100_000,
  async description(input) {
    return `生成图片：${input.prompt.slice(0, 120)}`
  },
  userFacingName() {
    return 'Image Generation'
  },
  isEnabled() {
    // sessionModel 取**主循环真实模型**（含 /model override / web 切换），
    // 不用 provider 启动快照 getActiveModel()——否则本会话切到文本模型后工具仍关。
    // 目标源：会话 provider 自有生图优先，回落凭据池 tools.image（见 resolveImageTarget）。
    const r = resolveImageTarget()
    return isImageGenerationToolEnabled({
      target: r?.target ?? null,
      sessionCaps: r?.sessionCaps ?? null,
      sessionModel: getMainLoopModel(),
    })
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  isOpenWorld() {
    return true
  },
  async checkPermissions(input): Promise<PermissionResult> {
    // 工具仅在用户已显式声明 imageCapabilities 时出现；与 WebSearch 同为放行型能力工具。
    return { behavior: 'allow', updatedInput: input }
  },
  async prompt() {
    return `生成或编辑图片。prompt 写清画面内容；若用户提供了工作区内的图片（如上一轮生成图、\`@文件\` 引用），用 image_path 传入作为参考 / 待改图。
结果文本里会给出 \`![](文件名)\` 行——**你必须在最终回复中原样输出这些行**，用户才能看到图片。`
  },
  async call({ prompt, image_path, aspect_ratio }) {
    const r = resolveImageTarget()
    if (!r) {
      return {
        data: {
          ok: false,
          text: '[生图失败] 未启用生图：当前会话 provider 与回落 provider 都没有可出图的 imageModel / imageCapabilities。',
        },
      }
    }

    // 可选参考图：走与 `@文件:图片` 同一真实路径校验（越界/非文件/不可读 → 明确报错）。
    const images: InputImage[] = []
    if (image_path) {
      const real = resolveRealWithinRoot(getPortableRoot(), image_path)
      // `=== false` 而非 `!real.ok`：strict:false 下真值收窄不拆判别联合（见 mentionImages）。
      if (real.ok === false) {
        return { data: { ok: false, text: unusableReason(real.reason, image_path) } }
      }
      try {
        const bytes = new Uint8Array(readFileSync(real.path))
        images.push({ bytes, mimeType: detectImageFormatFromBuffer(Buffer.from(bytes)) })
      } catch (e) {
        return {
          data: {
            ok: false,
            text: `[生图失败] 参考图读取失败：${image_path}（${e instanceof Error ? e.message : String(e)}）`,
          },
        }
      }
    }

    const rc: ImageGenRunContext = {
      provider: r.target.provider,
      model: r.target.model,
      baseUrl: r.baseUrl,
      apiKey: r.apiKey,
      capabilities: r.target.capabilities,
      sessionId: getSessionId(),
    }

    try {
      const g = await generateImages(rc, {
        prompt,
        images,
        ...(aspect_ratio ? { options: { aspectRatio: aspect_ratio } } : {}),
      })
      const lines = g.files.map(f => `![](${f.name})`)
      const parts: string[] = []
      if (g.text) parts.push(g.text)
      parts.push(...lines)
      if (g.oversized) parts.push('（图片过大，预览可能失败）')
      parts.push(...g.notes)
      if (lines.length > 0) {
        parts.push('请在最终回复中原样输出上面每一行 `![](文件名)`，用户才能看到图片。')
      }
      return { data: { ok: g.files.length > 0, text: parts.join('\n\n') } }
    } catch (e) {
      return { data: { ok: false, text: `[生图失败] ${e instanceof Error ? e.message : String(e)}` } }
    }
  },
  renderToolUseMessage(input) {
    return input.prompt
  },
  // 三者返回 React 元素（见 UI.tsx）——返回值会被裸插进 <Box>/作为组件根，
  // 返回字符串会触发 Ink "Text string … must be rendered inside <Text>" 崩溃。
  renderToolResultMessage,
  renderToolUseRejectedMessage,
  renderToolUseErrorMessage,
  renderToolUseProgressMessage() {
    return null
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: output.text,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
