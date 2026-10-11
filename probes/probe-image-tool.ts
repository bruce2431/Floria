/**
 * probe-image-tool.ts —— 主模型编排生图入口（`ImageGeneration` 工具）契约探针。
 *
 * 覆盖：
 *  - 运行态门控 `isImageGenerationToolEnabled` 真值矩阵（与直连链互斥）；
 *  - **生图目标回落** `selectImageTarget`：会话 provider 自有 `imageModel` 优先，缺失
 *    时回落顶层 `imageProvider`（工具在其上取该 provider 的 baseUrl/钥匙）；
 *  - **门控会话模型来源**：`ImageGenerationTool.isEnabled()` 取主循环真实模型
 *    `getMainLoopModel()`（含 /model override / web 切换），而非 provider 启动快照
 *    `getActiveModel()`——临时配置根 + setSessionProviderOverride/setMainLoopModelOverride
 *    解耦「provider activeModel」与「会话 override」两维，钉住四态真值；
 *  - **职责分离**：工具调用把 `imageModel` 交给 adapter（断言 adapter ctx.model ===
 *    imageModel），不把文本 sessionModel 当生图模型；
 *  - 生图核心 `generateImages` 经 `image_path`（真实路径校验）组装显式图 → 落盘
 *    + 产出 `![](文件名)`（工具结果文本即据此拼装，靠模型回显）；
 *  - 工具壳接线：名称、默认环境 `isEnabled()===false`、未启用 provider 时 call 报错分支。
 *
 * 离线，不触网、不动全局凭据池（门控段用临时 CLAUDE_CONFIG_DIR；核心调用注入假
 * fetch + 临时目录，落盘经 runWithCwdOverride 隔离到 tmp，不污染工作区 images/）。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { setMainLoopModelOverride } from '../src/bootstrap/state.js'
import { resolveRealWithinRoot } from '../src/services/imagegen/mentionImages.js'
import { registerImageAdapter } from '../src/services/imagegen/registry.js'
import {
  generateImages,
  isImageGenerationToolEnabled,
  isImageOutputModel,
  resolveImageCapabilities,
  selectImageTarget,
  type ImageGenRunContext,
} from '../src/services/imagegen/service.js'
import { ImageGenerationTool } from '../src/tools/ImageGenerationTool/ImageGenerationTool.js'
import { setSessionProviderOverride } from '../src/utils/credentials/pool.js'
import { runWithCwdOverride } from '../src/utils/cwd.js'
import { detectImageFormatFromBuffer } from '../src/utils/imageResizer.js'
import { getMainLoopModel } from '../src/utils/model/model.js'

let pass = 0
let fail = 0
function ok(cond: boolean, msg: string) {
  if (cond) {
    pass++
  } else {
    fail++
    console.error(`  ✗ ${msg}`)
  }
}

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai'
const CAPS = { inputImage: true, outputImage: true, imageEdit: true, multiTurnImage: true }

/**
 * 门控便捷壳（对齐工具内部解析）：生图目标 = 会话 provider 优先、回落顶层
 * `imageProvider`（此处以 `designated` 注入）；会话模型本身是生图模型时关闭。
 */
function gate(o: {
  caps: Record<string, any> | null | undefined
  sessionModel: string | null | undefined
  imageModel: string | null | undefined
  designated?: { provider: string; capabilities: any; imageModel: string | null | undefined } | null
}): boolean {
  return isImageGenerationToolEnabled({
    target: selectImageTarget({
      session: { provider: 'sess', capabilities: o.caps, imageModel: o.imageModel },
      designated: o.designated ?? null,
    }),
    sessionCaps: o.caps,
    sessionModel: o.sessionModel,
  })
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } })
}

async function run() {
  // 隔离：把配置根指向空临时目录，探针不读机器上真实 credentials.json
  // （否则本机已配 imageCapabilities 会让「未配置 provider」用例失真）。
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'floria-imgtool-empty-'))

  // ── 门控真值矩阵 ─────────────────────────────────────────────────────
  console.log('Test P: ImageGeneration tool gate')
  {
    const caps = { 'img-model': { outputImage: true, imageEdit: true, inputImage: true } }
    ok(
      gate({ caps, sessionModel: 'deepseek-chat', imageModel: 'img-model' }),
      'text session + declared imageModel → enabled',
    )
    ok(
      gate({ caps, sessionModel: 'img-model', imageModel: 'img-model' }) === false,
      'session model IS image model → disabled (direct path owns it)',
    )
    ok(
      gate({ caps: null, sessionModel: 'deepseek-chat', imageModel: 'img-model' }) === false,
      'no imageCapabilities → disabled',
    )
    ok(
      gate({ caps, sessionModel: 'deepseek-chat', imageModel: null }) === false,
      'no imageModel declared → disabled',
    )
    ok(
      gate({ caps, sessionModel: 'deepseek-chat', imageModel: 'nope' }) === false,
      'imageModel without outputImage → disabled',
    )
    ok(
      gate({ caps, sessionModel: 'deepseek-chat', imageModel: 'p/img-model' }),
      'prefixed imageModel resolves via unified resolver → enabled',
    )

    // ── 回落顶层 imageProvider ──────────────────────────────────────────
    const designated = { provider: 'img-prov', capabilities: caps, imageModel: 'img-model' }
    ok(
      gate({ caps: null, sessionModel: 'deepseek-chat', imageModel: null, designated }),
      'session provider has no image capability + valid imageProvider → enabled (fallback)',
    )
    ok(
      selectImageTarget({
        session: { provider: 'sess', capabilities: caps, imageModel: 'img-model' },
        designated,
      })?.source === 'session',
      'both declare → session provider target wins (imageProvider unused)',
    )
    ok(
      selectImageTarget({
        session: { provider: 'sess', capabilities: null, imageModel: null },
        designated,
      })?.source === 'designated',
      'session declares none → designated (imageProvider) target chosen',
    )
    ok(
      selectImageTarget({
        session: { provider: 'sess', capabilities: caps, imageModel: 'nope' },
        designated,
      })?.source === 'designated',
      'session imageModel unresolvable → falls back to imageProvider',
    )
    ok(
      gate({ caps, sessionModel: 'img-model', imageModel: 'img-model', designated }) === false,
      'session model IS image model → disabled even with imageProvider (direct path owns it)',
    )
    ok(
      gate({
        caps: null,
        sessionModel: 'deepseek-chat',
        imageModel: null,
        designated: { provider: 'img-prov', capabilities: caps, imageModel: null },
      }) === false,
      'session none + imageProvider without imageModel → disabled',
    )
    ok(
      gate({
        caps: null,
        sessionModel: 'deepseek-chat',
        imageModel: null,
        designated: { provider: 'img-prov', capabilities: { 'img-model': { outputImage: false } }, imageModel: 'img-model' },
      }) === false,
      'session none + imageProvider imageModel without outputImage → disabled',
    )
  }

  // ── 工具壳接线 ───────────────────────────────────────────────────────
  console.log('Test Q: ImageGeneration tool wiring')
  {
    ok(ImageGenerationTool.name === 'ImageGeneration', 'tool name = ImageGeneration')
    // 探针环境无 provider imageCapabilities → 工具默认关闭（文本链路零影响的证据）
    ok(ImageGenerationTool.isEnabled() === false, 'no provider caps in probe env → tool disabled')
    const res = await (ImageGenerationTool as any).call(
      { prompt: '画一只猫' },
      { abortController: new AbortController() },
    )
    ok(
      res?.data?.ok === false && String(res.data.text).includes('未启用'),
      'unconfigured provider → call returns visible failure (no throw, no adapter hit)',
    )
  }

  // ── 核心：image_path 组装 → 落盘 + ![](名) ───────────────────────────
  console.log('Test R: generateImages via image_path reference')
  {
    const root = mkdtempSync(join(tmpdir(), 'floria-imgtool-root-'))
    const dir = mkdtempSync(join(tmpdir(), 'floria-imgtool-dir-'))
    writeFileSync(join(root, 'ref.png'), Buffer.from(PNG_B64, 'base64'))

    // 真实路径校验（与工具内部一致）+ 组装显式输入图
    const real = resolveRealWithinRoot(root, 'ref.png')
    ok(real.ok, 'image_path resolves via resolveRealWithinRoot')
    const path = real.ok ? real.path : ''
    const bytes = new Uint8Array(readFileSync(path))

    let capturedParts: any[] = []
    const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedParts = JSON.parse(typeof init?.body === 'string' ? init.body : '{}').contents[0].parts
      return json({
        candidates: [
          { content: { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }] } },
        ],
      })
    }) as typeof globalThis.fetch

    const rc: ImageGenRunContext = {
      provider: 'gemini',
      model: 'img-model',
      baseUrl: GEMINI_BASE,
      apiKey: 'K',
      capabilities: CAPS,
      fetchImpl: fakeFetch,
      dir,
    }
    const g = await generateImages(rc, {
      prompt: '把它改成夜景',
      images: [{ bytes, mimeType: detectImageFormatFromBuffer(Buffer.from(bytes)) }],
    })

    ok(g.files.length === 1 && g.files[0]!.name.endsWith('.png'), `core produced one flat file (${g.files[0]?.name})`)
    ok(g.files[0]!.sourcePath === g.files[0]!.path, 'uncompressed: sourcePath === display path')
    const inj = capturedParts.find(p => p.inlineData)
    ok(!!inj && inj.inlineData.data === PNG_B64, 'image_path bytes forwarded as inlineData')
    ok(
      capturedParts.some(p => p.text === '把它改成夜景'),
      'prompt forwarded alongside the reference image',
    )

    // 越界 image_path 被拒（工具会把它翻成可见错误）
    ok(resolveRealWithinRoot(root, '../secret.png').reason === 'escape', 'escaping image_path rejected')
  }

  // ── 会话门控来源：sessionModel = 主循环真实模型（含 override / web 切换） ──
  // 装配一个临时配置根（provider 声明 imageCapabilities + imageModel），用
  // setSessionProviderOverride / setMainLoopModelOverride 把「provider activeModel」
  // 与「会话 model override」两个维度解耦，逐条钉住门控真值。旧实现取
  // getActiveModel()（provider 启动快照）会漏掉 override ⇒ 用例 (III) 必失败。
  console.log('Test S: session-model source (getMainLoopModel vs provider snapshot)')
  {
    const cfgDir = mkdtempSync(join(tmpdir(), 'floria-imgtool-cfg-'))
    process.env.CLAUDE_CONFIG_DIR = cfgDir
    const caps = { 'img-model': { outputImage: true, imageEdit: true, inputImage: true } }
    const mk = (activeModel: string) => ({
      baseUrl: 'http://probe.invalid/v1',
      protocol: 'anthropic',
      keys: [{ value: 'K', exhausted: false }],
      activeKeyIndex: 0,
      models: ['text-model', 'img-model'],
      activeModel,
      imageModel: 'img-model',
      imageCapabilities: caps,
    })
    writeFileSync(
      join(cfgDir, 'credentials.json'),
      JSON.stringify({
        activeProvider: 'probe-text',
        providers: { 'probe-text': mk('text-model'), 'probe-img': mk('img-model') },
      }),
    )

    // (I) 普通文本会话 + 合法 imageModel → 工具启用
    setSessionProviderOverride('probe-text')
    setMainLoopModelOverride(undefined)
    ok(getMainLoopModel() === 'text-model', 'no override → session model = provider activeModel (text)')
    ok(ImageGenerationTool.isEnabled() === true, 'text session + valid imageModel → tool enabled')

    // (II) 当前会话为图片模型 → 工具关闭（direct 链接管）
    setSessionProviderOverride('probe-img')
    setMainLoopModelOverride(undefined)
    ok(getMainLoopModel() === 'img-model', 'no override → session model = provider activeModel (image)')
    ok(ImageGenerationTool.isEnabled() === false, 'session model IS image model → tool disabled')
    ok(isImageOutputModel('img-model') === true, 'direct chain owns it (isImageOutputModel true)')

    // (III) provider activeModel 是图片模型，但本会话 override 为文本模型 → 工具仍启用
    setSessionProviderOverride('probe-img')
    setMainLoopModelOverride('text-model')
    ok(getMainLoopModel() === 'text-model', 'override wins over provider activeModel')
    ok(
      ImageGenerationTool.isEnabled() === true,
      'provider activeModel=image BUT session override=text → tool enabled (override honored)',
    )

    // (IV) 本会话 override 为图片模型，provider activeModel 是文本模型 → 工具关闭
    setSessionProviderOverride('probe-text')
    setMainLoopModelOverride('img-model')
    ok(getMainLoopModel() === 'img-model', 'override wins (provider activeModel text)')
    ok(ImageGenerationTool.isEnabled() === false, 'session override=image → tool disabled')

    // 形态解析（provider/model）+ 缺配 → 关闭
    ok(
      resolveImageCapabilities(caps, 'probe/img-model')?.model === 'img-model',
      'provider/model form resolves to bare id + capabilities',
    )
    ok(
      gate({ caps, sessionModel: 'probe/img-model', imageModel: 'img-model' }) === false,
      'provider/model session model that IS the image model → disabled',
    )
    ok(
      gate({ caps, sessionModel: 'text-model', imageModel: null }) === false,
      'no imageModel configured → disabled',
    )
    ok(
      gate({
        caps: { 'img-model': { outputImage: false } },
        sessionModel: 'text-model',
        imageModel: 'img-model',
      }) === false,
      'imageModel without outputImage capability → disabled',
    )
  }

  // ── 职责分离：工具调用用 imageModel，不把文本 sessionModel 当生图模型 ──────
  console.log('Test T: tool dispatch uses imageModel (not sessionModel)')
  {
    const root = mkdtempSync(join(tmpdir(), 'floria-imgtool-cwd-'))
    writeFileSync(join(root, 'ref.png'), Buffer.from(PNG_B64, 'base64'))
    setSessionProviderOverride('probe-text') // provider activeModel = text-model
    setMainLoopModelOverride(undefined)

    let capturedModel: string | undefined
    let capturedProvider: string | undefined
    registerImageAdapter({
      name: 'probe',
      supports: ctx => ctx.provider === 'probe-text',
      async generate(_req, ctx) {
        capturedModel = ctx.model
        capturedProvider = ctx.provider
        return {
          images: [{ bytes: new Uint8Array(Buffer.from(PNG_B64, 'base64')), mimeType: 'image/png' }],
          text: '生成完成',
        }
      },
    })

    const res = await runWithCwdOverride(root, () =>
      (ImageGenerationTool as any).call(
        { prompt: '画一只猫' },
        { abortController: new AbortController() },
      ),
    )
    ok(capturedModel === 'img-model', `adapter ctx.model === imageModel (got ${capturedModel})`)
    ok(capturedModel !== getMainLoopModel(), 'adapter model ≠ session model (text)')
    ok(getMainLoopModel() === 'text-model', 'session model stays the text model during the call')
    ok(capturedProvider === 'probe-text', 'adapter ctx.provider = session provider')
    ok(res?.data?.ok === true, 'tool call succeeds via imageModel')
    ok(String(res?.data?.text).includes('![]('), 'tool result carries a ![](文件名) line for the model to echo')
  }

  // ── 回落：会话 provider 无生图能力 → 顶层 imageProvider 接管（端点/钥匙随它） ──
  console.log('Test U: imageProvider fallback (session provider without imageModel)')
  {
    const cfgDir = mkdtempSync(join(tmpdir(), 'floria-imgtool-fallback-cfg-'))
    process.env.CLAUDE_CONFIG_DIR = cfgDir
    const credsPath = join(cfgDir, 'credentials.json')
    const writeCreds = (sessionImage: boolean) =>
      writeFileSync(
        credsPath,
        JSON.stringify({
          activeProvider: 'fb-text',
          imageProvider: 'fb-img',
          providers: {
            // 文本会话 provider：不声明生图能力（如 deepseek）——可选择性声明自带生图供后半段用
            'fb-text': {
              baseUrl: 'http://text.invalid/v1',
              protocol: 'anthropic',
              keys: [{ value: 'TK', exhausted: false }],
              activeKeyIndex: 0,
              models: ['text-model', 'fb-text-img'],
              activeModel: 'text-model',
              ...(sessionImage
                ? {
                    imageModel: 'fb-text-img',
                    imageCapabilities: { 'fb-text-img': { outputImage: true } },
                  }
                : {}),
            },
            // 回落生图 provider（端点/钥匙与文本会话不同源，用来自证凭据随目标取）
            'fb-img': {
              baseUrl: 'http://img.invalid/v1',
              protocol: 'openai-chat',
              keys: [{ value: 'IK', exhausted: false }],
              activeKeyIndex: 0,
              models: ['img-model'],
              activeModel: 'img-model',
              imageModel: 'img-model',
              imageCapabilities: { 'img-model': { outputImage: true, imageEdit: true, inputImage: true } },
            },
          },
        }),
      )

    writeCreds(false)
    setSessionProviderOverride('fb-text')
    setMainLoopModelOverride(undefined)
    ok(getMainLoopModel() === 'text-model', 'session = text-only provider (no image capability)')
    ok(ImageGenerationTool.isEnabled() === true, 'text-only session + imageProvider fallback → tool enabled')

    const root = mkdtempSync(join(tmpdir(), 'floria-imgtool-fallback-cwd-'))
    let cap: { provider?: string; model?: string; baseUrl?: string; apiKey?: string } = {}
    registerImageAdapter({
      name: 'probe-fb',
      supports: ctx => ctx.provider === 'fb-img' || ctx.provider === 'fb-text',
      async generate(_req, ctx) {
        cap = { provider: ctx.provider, model: ctx.model, baseUrl: ctx.baseUrl, apiKey: ctx.apiKey }
        return {
          images: [{ bytes: new Uint8Array(Buffer.from(PNG_B64, 'base64')), mimeType: 'image/png' }],
          text: 'ok',
        }
      },
    })

    const callTool = () =>
      runWithCwdOverride(root, () =>
        (ImageGenerationTool as any).call({ prompt: '画只猫' }, { abortController: new AbortController() }),
      )
    const res = await callTool()
    ok(res?.data?.ok === true, 'tool call routed to imageProvider succeeds')
    ok(cap.provider === 'fb-img', `adapter ctx.provider = imageProvider name (got ${cap.provider})`)
    ok(cap.model === 'img-model', `adapter ctx.model = imageProvider's imageModel (got ${cap.model})`)
    ok(cap.baseUrl === 'http://img.invalid/v1', 'adapter ctx.baseUrl = imageProvider baseUrl (not session)')
    ok(cap.apiKey === 'IK', 'adapter ctx.apiKey = imageProvider key (not session)')

    // 会话 provider 自带可出图 imageModel 时**优先**，回落不启用。
    writeCreds(true)
    cap = {}
    const res2 = await callTool()
    ok(res2?.data?.ok === true, 'session-with-image call still succeeds')
    ok(cap.provider === 'fb-text', `session provider's own imageModel wins over imageProvider (got ${cap.provider})`)
    ok(cap.model === 'fb-text-img', `session imageModel used, not imageProvider (got ${cap.model})`)
    ok(cap.baseUrl === 'http://text.invalid/v1', 'session provider credentials used when it owns the image model')
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

run().catch(e => {
  console.error(e)
  process.exit(1)
})
