/**
 * 三层 DB 统一读写 — bun:sqlite（SubPj7 存储定案同步，2026-09-04）
 *
 * 定案（Pj11 CLAUDE.md「存储定案」+ SubPj7 rawdb.py 1:1 移植）：
 *   - l3.raw/<来源>/message.db   messages 表
 *   - l2.mem/mem.db              memories 表（embeddings.npy 仍二进制全量载内存，不进 DB）
 *   - l1.cog/precog.db           precog 表（纯追加 INSERT + AI 标注 UPDATE by record_id）
 * 统一 schema：缺字段 = NULL（标记丢失，非字段不存在）；时间进 id，无独立 time 列，
 * id_time() 从 id 解析（兼容 message_id 与 memory_id）。
 *
 * 活引擎 superset（2026-09-04 用户放行同步时定，2026-09-05 收口）：memories 在定案 6 列上
 * 补 3 可空列承载 remember 工具活语义（core_file/supersedes/deprecated_by，均不可派生）。
 * pattern 定案移除（Pj11 CLAUDE.md「mem 字段：仅 revelant+blocks」延展）——不入库、不迁移、
 * 不返回。content/summary 按定案不落库：文本由 blocks 派生（deriveEntryText），blocks 缺省
 * 含 [content]（迁移与写入均保证）→ embeddings 索引零重建。
 *
 * 纯函数层：不 import config/envUtils（迁移脚本可独立 bun 直跑），路径由调用方显式传。
 */

import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

// ── 类型（与 DB 行 1:1） ──

export interface CoreFileItem {
  name: string
  path?: string
  content?: string
}

/** memories 表行（mem.db；content/summary 已并入 blocks 派生链） */
export interface MemEntry {
  memory_id: string
  revelant: string[]
  blocks: string[]
  source: string | null
  confidence: number | null
  half_life: number | null
  core_file: CoreFileItem[] | null
  supersedes: string | null
  deprecated_by: string | null
}

export interface PrecogResultItem {
  id: string
  accuracy: string
  summary: string
}

export interface PrecogRecord {
  record_id: string
  status: string
  query: string
  keywords: string[]
  source: string
  top_k: number
  results: PrecogResultItem[]
  description: string
}

/** mem 条目派生文本（对照 SubPj7 retriever._entry_text：blocks 空格拼接） */
export function deriveEntryText(entry: Pick<MemEntry, 'blocks'>): string {
  return entry.blocks.filter(Boolean).map(String).join(' ')
}

// ── JSON 列 helpers ──

function jsonCol(v: unknown): string | null {
  if (v === null || v === undefined) return null
  return JSON.stringify(v)
}

function jsonParse(s: unknown): unknown {
  if (s === null || s === undefined || s === '') return null
  try {
    return JSON.parse(s as string)
  } catch {
    return s
  }
}

// ── schema（三表同 DDL；各 db 文件只用到自己的表，其余为空表无害） ──

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
    message_id TEXT PRIMARY KEY,   -- {prefix}_{YYYYMMDD}_{HHMMSS}_{seq}
    source     TEXT,
    sender     TEXT,
    content    TEXT,
    media      TEXT,               -- JSON 数组；确认无媒体→'[]'，丢失→NULL
    quote      TEXT,               -- JSON dict；无→NULL
    forward    TEXT                -- JSON dict；无→NULL
);
CREATE TABLE IF NOT EXISTS memories (
    memory_id      TEXT PRIMARY KEY,  -- {prefix}_MEM_{YYYYMMDD}_{HHMMSS}[_seq]
    revelant       TEXT,              -- JSON 数组（关联 message_id），无→'[]'
    blocks         TEXT,              -- JSON 数组（语义编码块，embedding 源），无→'[]'
    source         TEXT,
    confidence     REAL,
    half_life      REAL,
    core_file      TEXT,              -- JSON 数组（活引擎核心产物）
    supersedes     TEXT,              -- 活引擎纠错链：指向被修正旧条目
    deprecated_by  TEXT               -- 活引擎纠错链：被新条目废弃的标注
);
CREATE TABLE IF NOT EXISTS precog (
    record_id   TEXT PRIMARY KEY,  -- PC{prefix}_{YYYY-MM-DD-HH:MM:SS}[_seq]
    status      TEXT,              -- pre / consumed
    query       TEXT,
    keywords    TEXT,              -- JSON 数组
    source      TEXT,
    top_k       INTEGER,
    results     TEXT,              -- JSON 数组 [{id, accuracy, summary}]
    description TEXT               -- ≥60 字分析，未填→NULL
);
`

/** 打开库并确保 schema（目录自动创建；busy_timeout 防跨进程写碰撞） */
export function openDb(path: string): Database {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.run('PRAGMA busy_timeout = 5000')
  db.exec(SCHEMA)
  return db
}

// ── 时间规则 ──

const ID_TIME_RE = /_(\d{8})_(\d{6})(?:_(\d+))?$/

/** 从 id 解析 time（YYYY-MM-DD HH:MM:SS）；无时间信息返回 null */
export function idTime(id: string): string | null {
  const m = ID_TIME_RE.exec(id ?? '')
  if (!m) return null
  const ymd = m[1]!
  const hms = m[2]!
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)} ${hms.slice(0, 2)}:${hms.slice(2, 4)}:${hms.slice(4, 6)}`
}

/** 生成含时间 message_id：{prefix}_{YYYYMMDD}_{HHMMSS}_{seq}（timeStr: 'YYYY-MM-DD HH:MM:SS'） */
export function makeMessageId(prefix: string, timeStr: string, seq: string | number): string {
  if (!timeStr || timeStr.length < 19) {
    throw new Error(`message.time 缺失或格式不符，无法编码进 id: '${timeStr}'`)
  }
  const compact = timeStr.slice(0, 19).replace(/[-:]/g, '').replace(' ', '_')
  // YYYYMMDD_HHMMSS
  return `${prefix}_${compact}_${seq}`
}

// ── memories 表（l2.mem/mem.db） ──

function rowToMemEntry(row: Record<string, unknown>): MemEntry {
  return {
    memory_id: String(row.memory_id ?? ''),
    revelant: (jsonParse(row.revelant) as string[] | null) ?? [],
    blocks: (jsonParse(row.blocks) as string[] | null) ?? [],
    source: (row.source as string) ?? null,
    confidence: (row.confidence as number) ?? null,
    half_life: (row.half_life as number) ?? null,
    core_file: (jsonParse(row.core_file) as CoreFileItem[] | null) ?? null,
    supersedes: (row.supersedes as string) ?? null,
    deprecated_by: (row.deprecated_by as string) ?? null,
  }
}

function memEntryRow(e: MemEntry): unknown[] {
  return [
    e.memory_id,
    jsonCol(e.revelant ?? []),
    jsonCol(e.blocks ?? []),
    e.source,
    e.confidence,
    e.half_life,
    jsonCol(e.core_file),
    e.supersedes,
    e.deprecated_by,
  ]
}

const MEM_COLS =
  '(memory_id, revelant, blocks, source, confidence, half_life, core_file, supersedes, deprecated_by)'

export function readMemories(dbPath: string): MemEntry[] {
  if (!existsSync(dbPath)) return []
  const db = openDb(dbPath)
  try {
    return (db.query('SELECT * FROM memories ORDER BY rowid').all() as Record<string, unknown>[]).map(
      rowToMemEntry,
    )
  } finally {
    db.close()
  }
}

export function countMemories(dbPath: string): number {
  if (!existsSync(dbPath)) return 0
  const db = openDb(dbPath)
  try {
    const row = db.query('SELECT COUNT(*) AS n FROM memories').get() as { n: number }
    return Number(row?.n ?? 0)
  } finally {
    db.close()
  }
}

export function insertMemory(dbPath: string, entry: MemEntry): void {
  const db = openDb(dbPath)
  try {
    db.run(`INSERT INTO memories ${MEM_COLS} VALUES (?,?,?,?,?,?,?,?,?,?)`, memEntryRow(entry))
  } finally {
    db.close()
  }
}

/** 写失败回滚用：按 id 删除 */
export function deleteMemory(dbPath: string, memoryId: string): void {
  const db = openDb(dbPath)
  try {
    db.run('DELETE FROM memories WHERE memory_id = ?', [memoryId])
  } finally {
    db.close()
  }
}

/** 纠错链标注；byId 传 null = 撤销废弃（回滚用） */
export function markDeprecated(dbPath: string, memoryId: string, byId: string | null): void {
  const db = openDb(dbPath)
  try {
    db.run('UPDATE memories SET deprecated_by = ? WHERE memory_id = ?', [byId, memoryId])
  } finally {
    db.close()
  }
}

// ── precog 表（l1.cog/precog.db，纯追加 + 标注 UPDATE） ──

function rowToPrecog(row: Record<string, unknown>): PrecogRecord {
  return {
    record_id: String(row.record_id ?? ''),
    status: (row.status as string) ?? '',
    query: (row.query as string) ?? '',
    keywords: (jsonParse(row.keywords) as string[] | null) ?? [],
    source: (row.source as string) ?? '',
    top_k: Number(row.top_k ?? 0),
    results: (jsonParse(row.results) as PrecogResultItem[] | null) ?? [],
    description: (row.description as string) ?? '',
  }
}

function precogRow(r: PrecogRecord): unknown[] {
  return [
    r.record_id,
    r.status,
    r.query,
    jsonCol(r.keywords ?? []),
    r.source,
    r.top_k,
    jsonCol(r.results ?? []),
    r.description,
  ]
}

const PRECOG_COLS = '(record_id, status, query, keywords, source, top_k, results, description)'

export function readPrecogRecords(dbPath: string): PrecogRecord[] {
  if (!existsSync(dbPath)) return []
  const db = openDb(dbPath)
  try {
    return (db.query('SELECT * FROM precog ORDER BY rowid').all() as Record<string, unknown>[]).map(
      rowToPrecog,
    )
  } finally {
    db.close()
  }
}

export function appendPrecog(dbPath: string, record: PrecogRecord): void {
  const db = openDb(dbPath)
  try {
    db.run(
      `INSERT OR REPLACE INTO precog ${PRECOG_COLS} VALUES (?,?,?,?,?,?,?,?)`,
      precogRow(record),
    )
  } finally {
    db.close()
  }
}

export interface PrecogUpdate {
  status?: string
  query?: string
  keywords?: string[]
  source?: string
  top_k?: number
  results?: PrecogResultItem[]
  description?: string
}

/** 按 record_id 更新（AI 标注 / pre→consumed）；返回 rowcount（未命中=0，调用方报错） */
export function updatePrecog(dbPath: string, recordId: string, fields: PrecogUpdate): number {
  const allowed: Array<keyof PrecogUpdate> = [
    'status',
    'query',
    'keywords',
    'source',
    'top_k',
    'results',
    'description',
  ]
  const cols: string[] = []
  const vals: unknown[] = []
  for (const k of allowed) {
    if (!(k in fields)) continue
    cols.push(k)
    const v = fields[k]
    vals.push(k === 'keywords' || k === 'results' ? jsonCol(v) : v)
  }
  if (!cols.length) return 0
  const db = openDb(dbPath)
  try {
    return db.run(`UPDATE precog SET ${cols.map(c => `${c}=?`).join(', ')} WHERE record_id=?`, [
      ...vals,
      recordId,
    ]).changes
  } finally {
    db.close()
  }
}

/** 批折叠生命周期：一批 pre → consumed */
export function markPrecogConsumed(dbPath: string, recordIds: string[]): void {
  if (!recordIds.length) return
  const db = openDb(dbPath)
  try {
    const stmt = db.query('UPDATE precog SET status = ? WHERE record_id = ?')
    for (const rid of recordIds) stmt.run(['consumed', rid])
  } finally {
    db.close()
  }
}

export function deletePrecog(dbPath: string, recordIds: string[]): void {
  if (!recordIds.length) return
  const db = openDb(dbPath)
  try {
    const stmt = db.query('DELETE FROM precog WHERE record_id = ?')
    for (const rid of recordIds) stmt.run([rid])
  } finally {
    db.close()
  }
}

// ── messages 表（l3.raw/<来源>/message.db） ──

export function countMessages(dbPath: string): number {
  if (!existsSync(dbPath)) return 0
  const db = openDb(dbPath)
  try {
    const row = db.query('SELECT COUNT(*) AS n FROM messages').get() as { n: number }
    return Number(row?.n ?? 0)
  } finally {
    db.close()
  }
}

// ── 迁移（一次性；JSON 保留为只读源，不删不改） ──

/** mem.json（嵌套 men/sem）→ mem.db。blocks=blocks+supplement_blocks（空→[content]），
 * 与 entryBlocks/embeddings 派生语义一致 → 检索零损失。idMap 供 revelant 旧→新 message_id 联动。 */
export function migrateMemJsonToDb(
  jsonPath: string,
  dbPath: string,
  idMap?: Record<string, string>,
): number {
  const entries = JSON.parse(readFileSync(jsonPath, 'utf-8')) as Array<Record<string, unknown>>
  if (!Array.isArray(entries)) throw new Error(`mem.json 顶层不是数组: ${jsonPath}`)

  const db = openDb(dbPath)
  try {
    // OR REPLACE：源 mem.json 历史遗留重复 memory_id last-wins 折叠
    // （真身 LJJ 6 条重复 → 4397-6=4391 行，对照 SubPj7 实迁移行为）
    const stmt = db.query(`INSERT OR REPLACE INTO memories ${MEM_COLS} VALUES (?,?,?,?,?,?,?,?,?,?)`)
    for (const e of entries) {
      const men = (e.men ?? {}) as Record<string, unknown>
      const sem = (e.sem ?? {}) as Record<string, unknown>
      const merged = [
        ...((sem.blocks as string[] | undefined) ?? []),
        ...((sem.supplement_blocks as string[] | undefined) ?? []),
      ]
      const blocks = merged.length ? merged : [String(men.content ?? '')].filter(Boolean)
      const revelant = ((men.revelant as string[] | undefined) ?? []).map(
        r => idMap?.[r] ?? r,
      )
      const row: MemEntry = {
        memory_id: String(e.memory_id ?? ''),
        revelant,
        blocks,
        source: (men.source as string) ?? null,
        confidence: (e.confidence as number) ?? null,
        half_life: (e.half_life as number) ?? null,
        core_file: (men.core_file as CoreFileItem[] | undefined) ?? null,
        supersedes: (men.supersedes as string) ?? null,
        deprecated_by: (men.deprecated_by as string) ?? null,
      }
      if (!row.memory_id) throw new Error(`mem.json 存在无 memory_id 条目: ${jsonPath}`)
      stmt.run(memEntryRow(row))
    }
    return entries.length
  } finally {
    db.close()
  }
}

/** cog.json 的 precog_records → precog.db */
export function migrateCogJsonToDb(cogJsonPath: string, dbPath: string): number {
  const data = JSON.parse(readFileSync(cogJsonPath, 'utf-8')) as {
    precog_records?: PrecogRecord[]
  }
  const records = data?.precog_records ?? []
  if (!records.length) return 0
  const db = openDb(dbPath)
  try {
    const stmt = db.query(`INSERT OR REPLACE INTO precog ${PRECOG_COLS} VALUES (?,?,?,?,?,?,?,?)`)
    for (const r of records) stmt.run(precogRow(r))
    return records.length
  } finally {
    db.close()
  }
}

/** message.json → message.db：每条重编含时间 message_id，返回 {rows, id_map}（供 mem.revelant 联动）。
 * prefix 缺省取原 id 首段；seq 取原 id 末尾数字段（无数字段按序号 5 位自增）。 */
export function migrateMessageJsonToDb(
  jsonPath: string,
  dbPath: string,
  opts?: { prefix?: string; source?: string },
): { rows: number; id_map: Record<string, string> } {
  const data = JSON.parse(readFileSync(jsonPath, 'utf-8'))
  const msgs: Array<Record<string, unknown>> = Array.isArray(data)
    ? data
    : (data?.messages ?? [])
  const source = opts?.source ?? (Array.isArray(data) ? null : (data?.source ?? null))

  const idMap: Record<string, string> = {}
  const db = openDb(dbPath)
  try {
    // OR REPLACE：源 message.json 同 id 同 time 重复条目 last-wins 折叠
    // （真身 QQ 8 条重复 → 35158-8=35150 行，对照 rawdb.py write_messages）
    const stmt = db.query(
      'INSERT OR REPLACE INTO messages (message_id, source, sender, content, media, quote, forward) VALUES (?,?,?,?,?,?,?)',
    )
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]!
      const oldId = String(m.message_id ?? '')
      if (!oldId) throw new Error(`message.json 存在无 message_id 条目: ${jsonPath}`)
      const prefix = opts?.prefix ?? (oldId.includes('_') ? oldId.split('_', 1)[0]! : 'MSG')
      const tail = oldId.includes('_') ? oldId.slice(oldId.indexOf('_') + 1) : oldId
      const digits = tail.match(/\d+/g) ?? []
      const seq = digits.length ? digits[digits.length - 1]! : String(i + 1).padStart(5, '0')
      const newId = makeMessageId(prefix, String(m.time ?? ''), seq)
      idMap[oldId] = newId
      const media = m.media
      stmt.run([
        newId,
        source,
        (m.sender as string) ?? null,
        (m.content as string) ?? null,
        media === undefined || media === null ? null : JSON.stringify(media),
        m.quote === undefined || m.quote === null ? null : JSON.stringify(m.quote),
        m.forward === undefined || m.forward === null ? null : JSON.stringify(m.forward),
      ])
    }
    return { rows: msgs.length, id_map: idMap }
  } finally {
    db.close()
  }
}
