/**
 * BGE 嵌入器 — transformers.js（ONNX）单例，对照 Python 基线 engine/core/embedder.py
 *
 * Spike 结论（20260903204723-BGE-TS化Spike/SPIKE结论.md）：
 *   - Xenova/bge-small-zh-v1.5 fp32 + CLS 池化 + 归一化 == sentence-transformers 生产路径
 *   - 关键：编码前必须预小写（BertTokenizer do_lower_case 等价归一化），
 *     否则中英混排文本向量偏差（cos 0.90~0.95）——tokenizer.json 无 lowercase 归一化
 *   - 模型缓存落 <全局根>/cache/（首跑自动下载 ~91MB，走 hf-mirror）
 */

import { join } from 'node:path'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dlopen, FFIType, ptr } from 'bun:ffi'

// 动态引入，仅本模块持有；feature 门控在工具层，这里无副作用
type Extractor = Awaited<ReturnType<typeof createExtractor>>

// onnxruntime.dll 预加载（2026-09-04 exe 崩溃根修）：bun compile 只把 binding.node 嵌进
// exe，不带上兄弟 DLL；运行时解包后依赖解析按 Windows 搜索顺序命中 System32 里的野
// onnxruntime.dll（本机实测 1.17.1）→ GetApi(24) 空指针 → Bun segfault。
// 对策：将包内正确版 1.24.3 onnxruntime.dll 以文件资产嵌入 exe，import transformers 前
// 经 LoadLibraryExW 显式加载——Windows 加载器解析静态依赖时「已加载同名模块优先」，
// 正确版本抢先占位，野 DLL 永不命中。dev 直跑下该导入返回 node_modules 磁盘路径，同一
// DLL 先加载一遍仅增加引用计数，无副作用。
import ortDllPath from '../../../node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime.dll' with { type: 'file' }

const LOAD_WITH_ALTERED_SEARCH_PATH = 0x8
let _ortPreloadPromise: Promise<void> | null = null

function preloadOrtNative(): Promise<void> {
  if (!_ortPreloadPromise) {
    _ortPreloadPromise = (async () => {
      // exe 内 ortDllPath 是 bun 虚拟路径（B:/~BUN/root/…），Windows 加载器不可见——
      // 经 bun 文件层拷到真实临时目录再 LoadLibrary；mkdtemp 防多实例 DLL 文件锁冲突
      const dir = mkdtempSync(join(tmpdir(), 'neturon-ort-'))
      const realPath = join(dir, 'onnxruntime.dll')
      await Bun.write(realPath, Bun.file(ortDllPath))
      const kernel32 = dlopen('kernel32.dll', {
        LoadLibraryExW: {
          args: [FFIType.ptr, FFIType.u32, FFIType.u32],
          returns: FFIType.ptr,
        },
      })
      const wide = Buffer.alloc(Buffer.byteLength(realPath, 'utf16le') + 2)
      wide.write(realPath, 0, 'utf16le')
      const handle = kernel32.symbols.LoadLibraryExW(
        ptr(wide),
        0,
        LOAD_WITH_ALTERED_SEARCH_PATH,
      )
      if (!handle) {
        throw new Error(
          `onnxruntime.dll 预加载失败（LoadLibraryExW 返回空）：${realPath}`,
        )
      }
    })()
  }
  return _ortPreloadPromise
}

interface TransformerJsEnv {
  remoteHost: string
  allowLocalModels: boolean
  cacheDir: string
}

let _extractor: Extractor | null = null
let _extractorPromise: Promise<Extractor> | null = null

/** BertTokenizer do_lower_case=true 的基础归一化：NFD → 去变音符 → 小写 */
export function normalizeForBert(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

async function createExtractor(cacheDir: string): Promise<Extractor> {
  await preloadOrtNative()
  const { pipeline, env } = await import('@huggingface/transformers')
  const tjsEnv = env as unknown as TransformerJsEnv
  // 中国网络：与 Python 侧 HF_ENDPOINT 一致
  tjsEnv.remoteHost = process.env.HF_ENDPOINT || 'https://hf-mirror.com'
  tjsEnv.allowLocalModels = false
  mkdirSync(cacheDir, { recursive: true })
  tjsEnv.cacheDir = cacheDir
  return (await pipeline('feature-extraction', 'Xenova/bge-small-zh-v1.5', {
    dtype: 'fp32',
  })) as Extractor
}

/**
 * BGE 单例懒加载。modelCacheDir = 模型缓存目录（全局根 cache/ 下）。
 * 加载失败抛错由调用方兜底（关键词检索降级）。
 */
export async function getExtractor(modelCacheDir: string): Promise<Extractor> {
  if (_extractor) return _extractor
  if (!_extractorPromise) {
    _extractorPromise = createExtractor(modelCacheDir).then(ex => {
      _extractor = ex
      return ex
    })
  }
  return _extractorPromise
}

/** 批量编码：预小写 → BGE CLS 池化 → L2 归一化。返回 [N][512] 数组。
 * 内部分批推理（对照 Python 侧 batch 语义）：全量重建数千 blocks 一次喂 ONNX
 * 会触发 attention 矩阵 OOM（真身库 14062 blocks 单批实测 ~117GB 分配失败）。 */
const ENCODE_BATCH = 32

export async function encode(
  texts: string[],
  modelCacheDir: string,
): Promise<number[][]> {
  const extractor = await getExtractor(modelCacheDir)
  const vectors: number[][] = []
  for (let i = 0; i < texts.length; i += ENCODE_BATCH) {
    const chunk = texts.slice(i, i + ENCODE_BATCH)
    const out = await extractor(chunk.map(normalizeForBert), {
      pooling: 'cls',
      normalize: true,
    })
    const [n, dim] = out.dims as [number, number]
    const data = out.data as Float32Array
    for (let r = 0; r < n; r++) {
      vectors.push(Array.from(data.slice(r * dim, (r + 1) * dim)))
    }
  }
  return vectors
}
