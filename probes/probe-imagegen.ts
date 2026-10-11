/**
 * probe-imagegen.ts —— 生图能力层契约探针（离线为主）
 *
 * 背景：聊天链路焊死 Anthropic Messages；生图模型走 `chat/completions` 时
 * Google 兼容层不回传生成图（200 但 content 空＝静默丢图）。新增 provider-neutral
 * 生图能力层（services/imagegen/）：能力判定 → adapter → 落盘 → `![](文件名)`
 * 回填 → 合成 Anthropic 响应。本探针用假 fetch 喂构造好的 Gemini `generateContent`
 * JSON，断言整条能力层的行为；`--live` 追加真端点往返。
 *
 * 离线（默认）：只测能力层，不触网。
 * 联网（可选）：`--live`，读 credentials.json 的 gemini key 真打一次。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runWithCwdOverride } from '../src/utils/cwd.js'
import { getImageCreator } from '../src/tools/FileReadTool/imageProcessor.js'

import { geminiImageAdapter } from '../src/services/imagegen/adapters/gemini.js'
import {
  extractImageMentionPaths,
  resolveMentionedImages,
  resolveRealWithinRoot,
  resolveWithinRoot,
} from '../src/services/imagegen/mentionImages.js'
import {
  listImageAdapters,
  selectImageAdapter,
} from '../src/services/imagegen/registry.js'
import {
  isImageOutputModel,
  resolveImageCapabilities,
  runImageGeneration,
  type ImageGenRunContext,
} from '../src/services/imagegen/service.js'
import { getLastImage, setLastImage } from '../src/services/imagegen/sessionContext.js'
import {
  buildImageFilename,
  extensionForMime,
  fitForViewer,
  writeImageFileAtomic,
} from '../src/services/imagegen/store.js'

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

/** 1×1 PNG（真实最小图）。 */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

interface Captured {
  url: string
  headers: Record<string, string>
  body: any
}

function makeInner(response: Response | (() => Response)) {
  let captured: Captured | null = null
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input)
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v))
    captured = {
      url,
      headers,
      body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}'),
    }
    return typeof response === 'function' ? response() : response.clone()
  }) as typeof globalThis.fetch
  return { fn, get: () => captured! }
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function parseSSE(text: string): Array<{ event: string; data: any }> {
  const out: Array<{ event: string; data: any }> = []
  for (const frame of text.split('\n\n')) {
    let event = ''
    let data = ''
    for (const l of frame.split('\n')) {
      if (l.startsWith('event:')) event = l.slice(6).trim()
      else if (l.startsWith('data:')) data += l.slice(5).trim()
    }
    if (event && data) out.push({ event, data: JSON.parse(data) })
  }
  return out
}

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai'
const CAPS = { inputImage: true, outputImage: true, imageEdit: true, multiTurnImage: true }

function rc(
  fetchImpl: typeof globalThis.fetch,
  dir: string,
  model = 'gemini-3.1-flash-image',
): ImageGenRunContext {
  return {
    provider: 'gemini',
    model,
    baseUrl: GEMINI_BASE,
    apiKey: 'KEY',
    capabilities: CAPS,
    fetchImpl,
    dir,
  }
}

function imageResult(parts: any[], finishReason = 'STOP', usage = true): Response {
  return json({
    candidates: [{ content: { role: 'model', parts }, finishReason }],
    ...(usage ? { usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 100 } } : {}),
  })
}

async function run() {
  const dir = mkdtempSync(join(tmpdir(), 'floria-imagegen-'))

  // ── Test A: 非流式文本+图 ────────────────────────────────────────────
  console.log('Test A: non-streaming text + image')
  {
    const inner = makeInner(
      imageResult([{ text: '这是你要的猫' }, { inlineData: { mimeType: 'image/png', data: PNG_B64 } }]),
    )
    const resp = await runImageGeneration(
      { model: 'gemini-3.1-flash-image', messages: [{ role: 'user', content: [{ type: 'text', text: '画一只猫' }] }] },
      rc(inner.fn, dir),
    )
    const cap = inner.get()
    ok(
      cap.url === `${GEMINI_BASE.replace('/openai', '')}/models/gemini-3.1-flash-image:generateContent`,
      `upstream url = ${cap.url}`,
    )
    ok(cap.headers['x-goog-api-key'] === 'KEY', 'x-goog-api-key set')
    ok(cap.headers['authorization'] === undefined, 'no bearer auth (native protocol)')
    ok(cap.body.contents?.[0]?.role === 'user', 'contents[0].role = user')
    ok(cap.body.contents[0].parts[0].text === '画一只猫', 'prompt forwarded to part.text')
    ok(cap.body.tools === undefined, 'tools not sent')

    const jb = await resp.json()
    ok(jb.type === 'message' && jb.role === 'assistant', 'anthropic message shape')
    ok(jb.content[0].type === 'text', 'single text block')
    ok(jb.content[0].text.includes('这是你要的猫'), 'model text included')
    const m = jb.content[0].text.match(/!\[\]\(([^)\s]+)\)/)
    ok(!!m, 'has ![](filename)')
    const file = m ? m[1] : ''
    ok(/^gemini-gemini-3\.1-flash-image-\d{14}\.png$/.test(file), `filename shape: ${file}`)
    const onDisk = readdirSync(dir).filter(f => f === file)
    ok(onDisk.length === 1, 'image landed on disk')
    ok(statSync(join(dir, file)).size > 0, 'landed file non-empty')
    ok(!readdirSync(dir).some(f => f.endsWith('.tmp')), 'no leftover .tmp')
    ok(jb.usage.input_tokens === 5 && jb.usage.output_tokens === 100, 'usage mapped')
  }

  // ── Test B: 带图输入（多轮改图：用户重新附图） ────────────────────────
  console.log('Test B: image input (edit)')
  {
    const inner = makeInner(imageResult([{ inlineData: { mimeType: 'image/jpeg', data: PNG_B64 } }]))
    await runImageGeneration(
      {
        model: 'gemini-3.1-flash-image',
        messages: [
          { role: 'user', content: [{ type: 'text', text: '第一版' }] },
          { role: 'assistant', content: [{ type: 'text', text: '好' }] },
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
              { type: 'text', text: '把背景改成红色' },
            ],
          },
        ],
      },
      rc(inner.fn, dir),
    )
    const parts = inner.get().body.contents[0].parts
    const inline = parts.find((p: any) => p.inlineData)
    ok(!!inline && inline.inlineData.mimeType === 'image/png', 'input image forwarded as inlineData')
    ok(inline.inlineData.data === PNG_B64, 'input image bytes = original base64')
    ok(parts.find((p: any) => p.text === '把背景改成红色'), 'only last user turn prompt used')
    ok(!parts.some((p: any) => p.text === '第一版'), 'earlier turns not replayed (standalone request)')
  }

  // ── Test C: tool_result 降级为可见文本 ────────────────────────────────
  console.log('Test C: tool_result degraded to visible text')
  {
    const inner = makeInner(imageResult([{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }]))
    await runImageGeneration(
      {
        model: 'gemini-3.1-flash-image',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '文件内容: hello' }] },
              { type: 'text', text: '据此画图' },
            ],
          },
        ],
      },
      rc(inner.fn, dir),
    )
    const text = inner.get().body.contents[0].parts[0].text as string
    ok(text.includes('文件内容: hello') && text.includes('据此画图'), 'tool_result text surfaced (not silent)')
  }

  // ── Test D: 流式伪造 SSE 序 ───────────────────────────────────────────
  console.log('Test D: forged SSE stream')
  {
    const inner = makeInner(imageResult([{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }]))
    const resp = await runImageGeneration(
      { model: 'gemini-3.1-flash-image', stream: true, messages: [{ role: 'user', content: '画图' }] },
      rc(inner.fn, dir),
    )
    const events = parseSSE(await resp.text())
    const types = events.map(e => e.event)
    ok(events[0].event === 'message_start', 'first = message_start')
    ok(types[types.length - 1] === 'message_stop', 'last = message_stop')
    ok(events[0].data.message.role === 'assistant' && events[0].data.message.content.length === 0, 'message_start shape')
    const start = events.find(e => e.event === 'content_block_start')
    ok(start?.data.index === 0 && start.data.content_block.type === 'text', 'content_block_start index 0')
    const delta = events.find(e => e.event === 'content_block_delta')
    ok(delta?.data.delta.type === 'text_delta' && delta.data.delta.text.includes('![]('), 'text_delta carries full text')
    const md = events.find(e => e.event === 'message_delta')
    ok(md?.data.delta.stop_reason === 'end_turn', 'message_delta stop_reason end_turn')
    ok(types.filter(t => t === 'content_block_stop').length === 1, 'one content_block_stop')
  }

  // ── Test E: 错误映射 ─────────────────────────────────────────────────
  console.log('Test E: error mapping')
  {
    // E1: HTTP 400 → 非 2xx Anthropic error JSON
    const e1 = makeInner(() => json({ error: { message: 'Image generation is not yet supported' } }, 400))
    const r1 = await runImageGeneration(
      { model: 'gemini-3.1-flash-image', messages: [{ role: 'user', content: 'x' }] },
      rc(e1.fn, dir),
    )
    ok(r1.status === 400, `HTTP 400 surfaces (got ${r1.status})`)
    const j1 = await r1.json()
    ok(j1.type === 'error' && j1.error.message.includes('not yet supported'), 'error JSON carries upstream message')

    // E2: IMAGE_RECITATION → assistant 文本（业务失败）
    const e2 = makeInner(imageResult([{ text: '抱歉' }], 'IMAGE_RECITATION'))
    const r2 = await runImageGeneration(
      { model: 'gemini-3.1-flash-image', messages: [{ role: 'user', content: 'x' }] },
      rc(e2.fn, dir),
    )
    ok(r2.status === 200, 'recitation returns 200')
    const j2 = await r2.json()
    ok(j2.type === 'message' && j2.content[0].text.startsWith('[生图失败]'), 'recitation → visible failure text')
    ok(j2.content[0].text.includes('IMAGE_RECITATION'), 'recitation code surfaced')

    // E3: 空响应
    const e3 = makeInner(json({ candidates: [] }))
    const r3 = await runImageGeneration(
      { model: 'gemini-3.1-flash-image', messages: [{ role: 'user', content: 'x' }] },
      rc(e3.fn, dir),
    )
    const j3 = await r3.json()
    ok(r3.status === 200 && j3.content[0].text.includes('未返回图片'), 'empty response → visible failure text')

    // E4: 文本但无图（模型拒答带解释）
    const e4 = makeInner(imageResult([{ text: '我无法生成该内容' }]))
    const r4 = await runImageGeneration(
      { model: 'gemini-3.1-flash-image', messages: [{ role: 'user', content: 'x' }] },
      rc(e4.fn, dir),
    )
    const j4 = await r4.json()
    ok(j4.content[0].text.includes('[生图失败]') && j4.content[0].text.includes('我无法生成该内容'), 'text-only → failure carries model explanation')
  }

  // ── Test F: 注册表可扩展性 ────────────────────────────────────────────
  console.log('Test F: registry extensibility')
  {
    ok(listImageAdapters().includes('gemini'), 'gemini registered')
    const ctx: any = { provider: 'openai', model: 'gpt-image-1', baseUrl: 'https://api.openai.com/v1', apiKey: 'K', capabilities: {} }
    ok(selectImageAdapter(ctx) === null, 'unknown provider → no adapter (no false positive)')
    const gctx: any = { provider: 'gemini', model: 'm', baseUrl: GEMINI_BASE, apiKey: 'K', capabilities: {} }
    ok(selectImageAdapter(gctx) === geminiImageAdapter, 'gemini ctx → gemini adapter')
  }

  // ── Test G: 文件名/扩展名助手 ─────────────────────────────────────────
  console.log('Test G: filename helpers')
  {
    const d = new Date(2026, 9, 11, 9, 8, 7)
    ok(
      buildImageFilename({ provider: 'gemini', model: 'nano-banana-pro-preview', mimeType: 'image/jpeg', date: d }) ===
        'gemini-nano-banana-pro-20261011090807.jpg',
      'strips -preview, maps mime → ext, local ts',
    )
    ok(
      buildImageFilename({ provider: 'gemini', model: 'x/y', mimeType: 'image/webp', date: d, seq: 2 }) ===
        'gemini-x-y-20261011090807-2.webp',
      'sanitizes path chars + seq suffix',
    )
    ok(extensionForMime('image/jpeg') === 'jpg' && extensionForMime('image/unknown') === 'png', 'ext mapping')
    ok(/^[A-Za-z0-9]/.test(buildImageFilename({ provider: '-weird', model: '.-x', mimeType: 'image/png' })), 'whitelist-safe leading char')

    // 同秒同名不覆盖：同一 filename 连写三次 → 原名 / -2 / -3，三份都在
    const wdir = mkdtempSync(join(tmpdir(), 'floria-imagegen-w-'))
    const png = new Uint8Array(Buffer.from(PNG_B64, 'base64'))
    const n1 = await writeImageFileAtomic(png, 'gemini-x-20261011090807.jpg', wdir)
    const n2 = await writeImageFileAtomic(png, 'gemini-x-20261011090807.jpg', wdir)
    const n3 = await writeImageFileAtomic(png, 'gemini-x-20261011090807.jpg', wdir)
    ok(
      n1.name === 'gemini-x-20261011090807.jpg' &&
        n2.name === 'gemini-x-20261011090807-2.jpg' &&
        n3.name === 'gemini-x-20261011090807-3.jpg',
      `same-second names disambiguated: ${n1.name} / ${n2.name} / ${n3.name}`,
    )
    const landed = readdirSync(wdir).sort()
    ok(landed.length === 3 && landed.every(f => statSync(join(wdir, f)).size > 0), 'all three files exist non-empty (no overwrite)')
    ok(n2.path.endsWith(n2.name) && n1.path !== n2.path, 'returned path matches resolved name')
  }

  // ── Test H: 4MB 上限守卫（不静默丢图） ────────────────────────────────
  console.log('Test H: 4MB guard')
  {
    const png = Buffer.from(PNG_B64, 'base64')
    const small = await fitForViewer(new Uint8Array(png), 'image/png')
    ok(small.ok && small.bytes.byteLength === png.byteLength, 'small image passes unchanged')

    const huge = new Uint8Array(5 * 1024 * 1024) // 非法图 → 压缩必失败，走「原样返回」兜底
    const big = await fitForViewer(huge, 'image/png')
    ok(big.bytes.byteLength > 0, 'oversized never dropped (bytes returned)')
    ok(big.ok === false, 'uncompressible oversized flagged not-ok')

    const inner = makeInner(imageResult([{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }]))
    const resp = await runImageGeneration(
      { model: 'gemini-3.1-flash-image', messages: [{ role: 'user', content: 'x' }] },
      rc(inner.fn, dir),
    )
    const jb = await resp.json()
    ok(!jb.content[0].text.includes('图片过大'), 'normal-size image: no oversized note')
  }

  // ── Test J: 会话生图上下文自动回注（A） ───────────────────────────────
  console.log('Test J: session image context auto-inject (A)')
  {
    const jdir = mkdtempSync(join(tmpdir(), 'floria-imagegen-j-'))
    const sid = 'sid-j'

    // 轮 1：出图 → 记录本会话最近一张
    const g1 = makeInner(imageResult([{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }]))
    await runImageGeneration(
      { model: 'gemini-3.1-flash-image', messages: [{ role: 'user', content: '画一只猫' }] },
      { ...rc(g1.fn, jdir), sessionId: sid },
    )
    const rec = getLastImage(sid, jdir)
    ok(!!rec && rec.fileName.endsWith('.png'), 'round1 records last image for session')

    // 轮 2：纯文本改图 → 自动回注上一张
    const g2 = makeInner(imageResult([{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }]))
    const r2 = await runImageGeneration(
      { model: 'gemini-3.1-flash-image', messages: [{ role: 'user', content: '改成夜景' }] },
      { ...rc(g2.fn, jdir), sessionId: sid },
    )
    const p2 = g2.get().body.contents[0].parts
    const inj = p2.find((p: any) => p.inlineData)
    ok(!!inj && inj.inlineData.data === PNG_B64, 'round2 auto-injects previous image bytes')
    ok(p2.some((p: any) => p.text === '改成夜景'), 'round2 prompt still forwarded')
    const j2 = await r2.json()
    ok(j2.content[0].text.includes('基于上一张图继续编辑'), 'round2 output notes context re-injection')

    // 变体：显式附图 → 不注入上下文（只一个 image，且为显式 jpeg）
    const g3 = makeInner(imageResult([{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }]))
    await runImageGeneration(
      {
        model: 'gemini-3.1-flash-image',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: PNG_B64 } },
              { type: 'text', text: '改成白天' },
            ],
          },
        ],
      },
      { ...rc(g3.fn, jdir), sessionId: sid },
    )
    const inlines3 = g3.get().body.contents[0].parts.filter((p: any) => p.inlineData)
    ok(
      inlines3.length === 1 && inlines3[0].inlineData.mimeType === 'image/jpeg',
      'explicit attach suppresses context inject',
    )

    // 变体：无 imageEdit/multiTurnImage → 不注入
    const g4 = makeInner(imageResult([{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }]))
    await runImageGeneration(
      { model: 'gemini-3.1-flash-image', messages: [{ role: 'user', content: '改成夜景' }] },
      { ...rc(g4.fn, jdir), sessionId: sid, capabilities: { inputImage: true, outputImage: true } },
    )
    ok(
      g4.get().body.contents[0].parts.every((p: any) => !p.inlineData),
      'no imageEdit/multiTurnImage → no context inject',
    )
  }

  // ── Test K: `@文件:图片` 令牌解析（B） ────────────────────────────────
  console.log('Test K: @文件:image token resolution (B)')
  {
    const kdir = mkdtempSync(join(tmpdir(), 'floria-imagegen-k-'))
    const kroot = mkdtempSync(join(tmpdir(), 'floria-imagegen-kroot-'))
    writeFileSync(join(kroot, 'pic.png'), Buffer.from(PNG_B64, 'base64'))
    writeFileSync(join(kroot, 'note.txt'), 'hello')

    // K1: 引用图 → inlineData，令牌原样留正文
    const g1 = makeInner(imageResult([{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }]))
    await runImageGeneration(
      { model: 'gemini-3.1-flash-image', messages: [{ role: 'user', content: '[@文件:pic.png] 把背景改成黄昏' }] },
      { ...rc(g1.fn, kdir), mentionRoot: kroot },
    )
    const p1 = g1.get().body.contents[0].parts
    const inj = p1.find((p: any) => p.inlineData)
    ok(!!inj && inj.inlineData.data === PNG_B64, '@文件:pic.png → inlineData bytes')
    ok(inj.inlineData.mimeType === 'image/png', '@文件 resolved mime detected')
    ok((p1.find((p: any) => p.text)?.text ?? '').includes('[@文件:pic.png]'), 'token left verbatim in prompt')

    // K2: 越界路径 → 跳过 + warning
    const g2 = makeInner(imageResult([{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }]))
    const r2 = await runImageGeneration(
      { model: 'gemini-3.1-flash-image', messages: [{ role: 'user', content: '[@文件:../secret.png] 改' }] },
      { ...rc(g2.fn, kdir), mentionRoot: kroot },
    )
    ok(g2.get().body.contents[0].parts.every((p: any) => !p.inlineData), 'out-of-root path skipped')
    ok((await r2.json()).content[0].text.includes('越界'), 'out-of-root warning surfaced')

    // K3: 非图片扩展名 → 静默跳过（无 warning）
    const g3 = makeInner(imageResult([{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }]))
    const r3 = await runImageGeneration(
      { model: 'gemini-3.1-flash-image', messages: [{ role: 'user', content: '[@文件:note.txt] 画图' }] },
      { ...rc(g3.fn, kdir), mentionRoot: kroot },
    )
    ok(g3.get().body.contents[0].parts.every((p: any) => !p.inlineData), '.txt token silently skipped')
    ok(!(await r3.json()).content[0].text.includes('越界'), '.txt no spurious warning')

    // K4: inputImage:false → 不解析
    const g4 = makeInner(imageResult([{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }]))
    await runImageGeneration(
      { model: 'gemini-3.1-flash-image', messages: [{ role: 'user', content: '[@文件:pic.png] 改' }] },
      { ...rc(g4.fn, kdir), mentionRoot: kroot, capabilities: { outputImage: true } },
    )
    ok(g4.get().body.contents[0].parts.every((p: any) => !p.inlineData), 'inputImage:false → no resolution')

    // K5: 缺文件 → warning
    const g5 = makeInner(imageResult([{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }]))
    const r5 = await runImageGeneration(
      { model: 'gemini-3.1-flash-image', messages: [{ role: 'user', content: '[@文件:missing.png] 改' }] },
      { ...rc(g5.fn, kdir), mentionRoot: kroot },
    )
    ok((await r5.json()).content[0].text.includes('读取失败'), 'missing file warning surfaced')

    // 助手级单测
    ok(resolveWithinRoot(kroot, 'pic.png') !== null, 'resolveWithinRoot: inside ok')
    ok(resolveWithinRoot(kroot, '../x.png') === null, 'resolveWithinRoot: escape rejected')
    ok(resolveWithinRoot(kroot, '/abs/x.png') === null, 'resolveWithinRoot: absolute rejected')
    ok(
      extractImageMentionPaths('[@文件:a.png] [@文件:a.png] [@文件:b.txt] [@文件:c.jpg]').join(',') ===
        'a.png,c.jpg',
      'extract dedupes + filters non-image ext',
    )
  }

  // ── Test L: B 抑制 A（交互矩阵） ──────────────────────────────────────
  console.log('Test L: B present suppresses context A')
  {
    const ldir = mkdtempSync(join(tmpdir(), 'floria-imagegen-l-'))
    const lroot = mkdtempSync(join(tmpdir(), 'floria-imagegen-lroot-'))
    writeFileSync(join(lroot, 'ref.png'), Buffer.from(PNG_B64, 'base64'))
    const oldPath = join(ldir, 'old.png')
    writeFileSync(oldPath, Buffer.from('OLD-IMAGE-DIFFERENT-BYTES'))
    setLastImage(
      'sid-l',
      { fileName: 'old.png', path: oldPath, mimeType: 'image/png', provider: 'gemini', model: 'm', ts: Date.now() },
      ldir,
    )

    const g1 = makeInner(imageResult([{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }]))
    await runImageGeneration(
      { model: 'gemini-3.1-flash-image', messages: [{ role: 'user', content: '[@文件:ref.png] 改背景' }] },
      { ...rc(g1.fn, ldir), mentionRoot: lroot, sessionId: 'sid-l' },
    )
    const inlines = g1.get().body.contents[0].parts.filter((p: any) => p.inlineData)
    ok(
      inlines.length === 1 && inlines[0].inlineData.data === PNG_B64,
      'both B and A available → exactly one image, = B bytes (A suppressed)',
    )
  }

  // ── Test M: 统一能力解析（P0-1） ──────────────────────────────────────
  console.log('Test M: unified capability resolution (P0-1)')
  {
    const caps = {
      'gemini-3.1-flash-image': { outputImage: true, inputImage: true, imageEdit: true },
      'vendor/img-model': { outputImage: true },
      'text-only-model': { inputImage: true },
    }
    const m1 = resolveImageCapabilities(caps, 'gemini-3.1-flash-image')
    ok(m1?.model === 'gemini-3.1-flash-image' && m1.capabilities.outputImage === true, 'bare id → model + caps')

    const m2 = resolveImageCapabilities(caps, 'vendor/img-model')
    ok(m2?.model === 'vendor/img-model' && m2.capabilities.outputImage === true, 'exact prefixed key match')

    const m3 = resolveImageCapabilities(caps, 'someprovider/gemini-3.1-flash-image')
    ok(
      m3?.model === 'gemini-3.1-flash-image' && m3.capabilities.outputImage === true,
      'unrecognized prefix → tail id normalized to bare (for adapter URL)',
    )

    ok(resolveImageCapabilities(caps, 'text-only-model') === null, 'no outputImage → null')
    ok(resolveImageCapabilities(caps, 'unknown') === null, 'unknown model → null')
    ok(resolveImageCapabilities(null, 'gemini-3.1-flash-image') === null, 'no caps → null')

    // isImageOutputModel 与解析器同源（provider 未声明时全局判据为假，此处只验纯解析一致性）
    ok(
      typeof isImageOutputModel('gemini-3.1-flash-image') === 'boolean',
      'isImageOutputModel delegates to resolver (boolean)',
    )
  }

  // ── Test N: 原图/展示图分离（P0-2） ───────────────────────────────────
  console.log('Test N: source/display split (P0-2)')
  {
    const ndir = mkdtempSync(join(tmpdir(), 'floria-imagegen-n-'))
    const sid = 'sid-n'

    // 造一张 >4MB 的真实可压缩 PNG（随机噪声 → 不可无损压小，必走压缩）
    const w = 1600
    const h = 1600
    const ch = 3
    const raw = Buffer.alloc(w * h * ch)
    for (let i = 0; i < raw.length; i++) raw[i] = (Math.random() * 256) | 0
    const sharpAny = (await getImageCreator()) as any
    const bigPng: Buffer = await sharpAny(raw, { raw: { width: w, height: h, channels: ch } })
      .png()
      .toBuffer()
    ok(bigPng.length > 4 * 1024 * 1024, `fixture big png > 4MB (${bigPng.length} bytes)`)

    const g1 = makeInner(imageResult([{ inlineData: { mimeType: 'image/png', data: bigPng.toString('base64') } }]))
    await runImageGeneration(
      { model: 'gemini-3.1-flash-image', messages: [{ role: 'user', content: '画一张大图' }] },
      { ...rc(g1.fn, ndir), sessionId: sid },
    )

    const displayFiles = readdirSync(ndir).filter(f => !f.startsWith('.'))
    ok(displayFiles.length === 1, `display file flat in images dir (${displayFiles.join(',')})`)
    const displayName = displayFiles[0]!
    const displaySize = statSync(join(ndir, displayName)).size
    ok(displaySize <= 4 * 1024 * 1024, `display <= 4MB (${displaySize})`)

    const srcDir = join(ndir, '.source')
    const srcFiles = readdirSync(srcDir)
    ok(srcFiles.length === 1, `.source holds exactly one full-fidelity image`)
    const srcName = srcFiles[0]!
    ok(
      Buffer.compare(readFileSync(join(srcDir, srcName)), bigPng) === 0,
      '.source bytes === original full-fidelity bytes',
    )
    ok(srcName.endsWith('.png'), 'source named by source MIME ext (png)')

    const rec = getLastImage(sid, ndir)
    ok(!!rec && rec.sourcePath?.endsWith(join('.source', srcName)), 'session context records sourcePath')
    ok(rec?.mimeType === 'image/png', 'context mimeType = source mime (image/png)')

    // 次轮纯文本改图 → A 回注读**原图**（全保真），不是降质展示图
    const g2 = makeInner(imageResult([{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }]))
    await runImageGeneration(
      { model: 'gemini-3.1-flash-image', messages: [{ role: 'user', content: '加一场雨' }] },
      { ...rc(g2.fn, ndir), sessionId: sid },
    )
    const inj = g2.get().body.contents[0].parts.find((p: any) => p.inlineData)
    ok(!!inj && inj.inlineData.data === bigPng.toString('base64'), 'round2 re-injects FULL-fidelity source bytes')
    ok(inj.inlineData.mimeType === 'image/png', 're-injected mime = source mime')

    // 小图 → sourcePath === path，且不额外写 .source
    const sdir = mkdtempSync(join(tmpdir(), 'floria-imagegen-ns-'))
    const g3 = makeInner(imageResult([{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }]))
    await runImageGeneration(
      { model: 'gemini-3.1-flash-image', messages: [{ role: 'user', content: '小图' }] },
      { ...rc(g3.fn, sdir), sessionId: 'sid-ns' },
    )
    const recS = getLastImage('sid-ns', sdir)
    ok(!!recS && recS.sourcePath === recS.path, 'small image: sourcePath === display path')
    ok(readdirSync(sdir).every(f => f !== '.source'), 'small image: no .source dir created')
  }

  // ── Test O: realpath 路径加固 ─────────────────────────────────────────
  console.log('Test O: realpath hardening')
  {
    const oroot = mkdtempSync(join(tmpdir(), 'floria-imagegen-oroot-'))
    writeFileSync(join(oroot, 'pic.png'), Buffer.from(PNG_B64, 'base64'))

    const inRoot = resolveRealWithinRoot(oroot, 'pic.png')
    ok(inRoot.ok && inRoot.path.endsWith('pic.png'), 'realpath: in-root file resolves')

    ok(resolveRealWithinRoot(oroot, '../escape.png').reason === 'escape', 'realpath: lexical escape → escape')
    ok(resolveRealWithinRoot(oroot, '/abs.png').reason === 'escape', 'realpath: absolute → escape')
    ok(resolveRealWithinRoot(oroot, 'missing.png').reason === 'unreadable', 'realpath: missing → unreadable')

    // 目录伪装成图片名 → not-file
    mkdirSync(join(oroot, 'd.png'))
    ok(resolveRealWithinRoot(oroot, 'd.png').reason === 'not-file', 'realpath: directory → not-file')

    // 符号链接/junction 逃逸（Windows 上 junction 无需管理员权限）
    const outside = mkdtempSync(join(tmpdir(), 'floria-imagegen-out-'))
    writeFileSync(join(outside, 'x.png'), Buffer.from(PNG_B64, 'base64'))
    try {
      symlinkSync(outside, join(oroot, 'link'), 'junction')
      const esc = resolveRealWithinRoot(oroot, 'link/x.png')
      ok(esc.ok === false && esc.reason === 'escape', 'realpath: symlink/junction escape rejected')
    } catch (e) {
      console.log(`  (skip symlink test: ${e instanceof Error ? e.message : String(e)})`)
    }
  }

  if (process.argv.includes('--live')) await live()

  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

async function live() {
  console.log('\nTest I (--live): real Gemini native generateContent')
  const { getClaudeConfigHomeDir } = await import('../src/utils/envUtils.js')
  const creds = JSON.parse(readFileSync(join(getClaudeConfigHomeDir(), 'credentials.json'), 'utf-8'))
  const g = creds.providers?.gemini
  if (!g) {
    console.error('  ✗ no gemini provider in credentials.json')
    fail++
    return
  }
  const apiKey = g.keys[g.activeKeyIndex ?? 0].value
  const dir = mkdtempSync(join(tmpdir(), 'floria-imagegen-live-'))
  const sid = 'live-ctx'

  // 出图
  const r1 = await runWithCwdOverride(dir, () =>
    runImageGeneration(
      { model: 'gemini-3.1-flash-image', messages: [{ role: 'user', content: '画一只戴红帽子的小猫，扁平插画风格' }] },
      { provider: 'gemini', model: 'gemini-3.1-flash-image', baseUrl: g.baseUrl, apiKey, capabilities: CAPS, dir, sessionId: sid },
    ),
  )
  const j1 = await r1.json()
  console.log(`  generate: status=${r1.status} text=${JSON.stringify(j1?.content?.[0]?.text?.slice(0, 120))}`)
  ok(r1.status === 200 && j1?.content?.[0]?.text?.includes('![]('), 'live: image produced + markdown')

  const produced = readdirSync(dir).filter(f => f.endsWith('.png') || f.endsWith('.jpg'))
  ok(produced.length >= 1, `live: file on disk (${produced.join(',')})`)
  if (produced.length === 0) return

  // 多轮改图（用户重新附图）
  const bytes = readFileSync(join(dir, produced[0])).toString('base64')
  const r2 = await runWithCwdOverride(dir, () =>
    runImageGeneration(
      {
        model: 'gemini-3.1-flash-image',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes } },
              { type: 'text', text: '把帽子改成蓝色' },
            ],
          },
        ],
      },
      { provider: 'gemini', model: 'gemini-3.1-flash-image', baseUrl: g.baseUrl, apiKey, capabilities: CAPS, dir, sessionId: sid },
    ),
  )
  const j2 = await r2.json()
  console.log(`  edit: status=${r2.status} text=${JSON.stringify(j2?.content?.[0]?.text?.slice(0, 120))}`)
  ok(r2.status === 200 && j2?.content?.[0]?.text?.includes('![]('), 'live: image edit round-trip')

  // 上下文自动回注：纯文本、无附图 → 应复用上一张
  const r3 = await runWithCwdOverride(dir, () =>
    runImageGeneration(
      { model: 'gemini-3.1-flash-image', messages: [{ role: 'user', content: '把帽子换成绿色' }] },
      { provider: 'gemini', model: 'gemini-3.1-flash-image', baseUrl: g.baseUrl, apiKey, capabilities: CAPS, dir, sessionId: sid },
    ),
  )
  const j3 = await r3.json()
  console.log(`  ctx: status=${r3.status} text=${JSON.stringify(j3?.content?.[0]?.text?.slice(0, 120))}`)
  ok(
    r3.status === 200 &&
      j3?.content?.[0]?.text?.includes('![](') &&
      j3?.content?.[0]?.text?.includes('基于上一张图继续编辑'),
    'live: text-only round auto-injects previous image',
  )
}

run().catch(e => {
  console.error(e)
  process.exit(1)
})
