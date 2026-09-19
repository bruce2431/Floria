/**
 * 只读探针：指定神经元的每个 block 的真实 token 数 vs BGE 512 上限。
 * 不估算——加载与生产同一份 tokenizer（Xenova/bge-small-zh-v1.5）数字符→token，
 * 并用「全文向量 vs 前 512 token 向量」的余弦证明尾部内容是否真的不进向量。
 * 用法：bun run probe-block-tokenlen.ts [库路径，缺省 Neuron-Pj16]
 */
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { env, AutoTokenizer } from '@huggingface/transformers'
import { encode } from '../src/tools/neturon/embedder.js'

const here = dirname(fileURLToPath(import.meta.url))
const argPath = process.argv.slice(2).find(a => !a.startsWith('--'))
const neuronPath = argPath ?? join(here, '..', '..', '.claude', 'neturon', 'neurons', 'Neuron-Pj16')
const cacheDir = join(here, '..', '..', '..', '.claude', 'neturon', 'cache', 'models')
mkdirSync(cacheDir, { recursive: true })
const tjsEnv = env as unknown as { remoteHost: string; allowLocalModels: boolean; cacheDir: string }
tjsEnv.remoteHost = process.env.HF_ENDPOINT || 'https://hf-mirror.com'
tjsEnv.allowLocalModels = false
tjsEnv.cacheDir = cacheDir

const LIMIT = 512
const tok = await AutoTokenizer.from_pretrained('Xenova/bge-small-zh-v1.5')
const countTok = (s: string): number => {
  const ids = tok(s, { add_special_tokens: true }).input_ids as unknown as { length: number; dims?: number[]; data?: unknown }
  if (typeof ids.length === 'number') return ids.length
  return ids.dims ? ids.dims[ids.dims.length - 1]! : 0
}

const dbPath = join(neuronPath, 'l2.mem', 'mem.db')
const db = new Database(dbPath, { readonly: true })
const rows = db.query('SELECT memory_id, source, blocks FROM memories').all() as Array<{ memory_id: string; source: string; blocks: string }>
db.close()

type Rec = { mid: string; source: string; i: number; chars: number; tokens: number }
const recs: Rec[] = []
for (const r of rows) {
  let blocks: unknown = []
  try { blocks = JSON.parse(r.blocks) } catch { /* 容忍非 JSON */ }
  const arr = Array.isArray(blocks) ? blocks.map(String) : [String(blocks)]
  arr.forEach((b, i) => recs.push({ mid: r.memory_id, source: r.source, i, chars: b.length, tokens: countTok(b) }))
}

const sortedTok = recs.map(r => r.tokens).sort((a, b) => a - b)
const over = recs.filter(r => r.tokens > LIMIT)
console.log(`库：${neuronPath}`)
console.log(`总块数 ${recs.length}；超 ${LIMIT} token 的块 **${over.length}**（${(100 * over.length / recs.length).toFixed(1)}%）`)
console.log(`token：中位 ${sortedTok[Math.floor(recs.length / 2)]}  p90 ${sortedTok[Math.floor(recs.length * 0.9)]}  p99 ${sortedTok[Math.floor(recs.length * 0.99)]}  最大 ${sortedTok[sortedTok.length - 1]}`)
console.log(`超限块涉及条目：MEM ${new Set(over.filter(r => r.source === 'MEM').map(r => r.mid)).size} 条 / LOG ${new Set(over.filter(r => r.source === 'LOG').map(r => r.mid)).size} 条`)

console.log('\n超限最严重的 12 个块：')
for (const r of [...over].sort((a, b) => b.tokens - a.tokens).slice(0, 12)) {
  console.log(`  ${r.mid} 块#${String(r.i).padStart(3)}  ${String(r.chars).padStart(4)} 字 → ${String(r.tokens).padStart(5)} token（${(r.tokens / LIMIT).toFixed(1)}× 上限）`)
}

const worst = [...over].sort((a, b) => b.tokens - a.tokens)[0]
if (worst && process.argv.includes('--truncate-proof')) {
  const srcRow = rows.find(x => x.memory_id === worst.mid)!
  const full = (JSON.parse(srcRow.blocks) as string[]).map(String)[worst.i]!
  const idsRaw = tok(full, { add_special_tokens: true }).input_ids as unknown as { data: ArrayLike<bigint | number> }
  const ids = Array.from(idsRaw.data).map(Number)
  const cut = tok.decode(ids.slice(0, LIMIT), { skip_special_tokens: true })
  const [vFull, vCut] = await encode([full, cut], cacheDir)
  const cos = (a: number[], b: number[]): number => a.reduce((s, x, i) => s + x * b[i]!, 0)
  const c = cos(vFull!, vCut!)
  console.log(`\n截断实测（${worst.mid} 块#${worst.i}，${worst.tokens} token）：`)
  console.log(`  全文向量 vs 前 ${LIMIT} token 向量  cos = ${c.toFixed(4)}`)
  console.log(`  → ${c > 0.999 ? '尾部内容**完全不进向量**（截断已证死）' : c > 0.99 ? '尾部贡献可忽略（截断实质成立）' : '尾部有实质贡献'}`)
}
