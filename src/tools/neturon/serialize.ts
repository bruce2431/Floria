/**
 * Neuron 数据专用序列化器 — 对照 Python 基线（p1-raw2mem.py 同源）
 *
 * mem.json 红线（revelant-serializer.md）：禁止裸 json.dump(indent=2) —— 会把
 * revelant/core_file 数百条消息 ID 全展开。仅 blocks / core_file 数组多行，其余数组单行。
 * cog.json：results 条目单行，其余数组单行。
 */

type Json = unknown

function isDict(v: Json): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** mem.json 专用：dict 压成单行（core_file 条目用） */
function inlineObject(obj: Record<string, unknown>, indent: number): string {
  return (
    '{' +
    Object.entries(obj)
      .map(([k, v]) => JSON.stringify(k) + ': ' + serializeMem(v, indent, null))
      .join(', ') +
    '}'
  )
}

export function serializeMem(obj: Json, indent = 1, key: string | null = null): string {
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]'
    if (key === 'blocks') {
      // blocks：数组多行，元素逐行
      const parts = ['[']
      obj.forEach((item, i) => {
        const comma = i < obj.length - 1 ? ',' : ''
        parts.push(' '.repeat(indent + 1) + serializeMem(item, indent + 1, null) + comma)
      })
      parts.push(' '.repeat(indent) + ']')
      return parts.join('\n')
    }
    if (key === 'core_file') {
      // core_file 条目单行、条目间换行（2026-08-06 用户要求，同 cog results 风格）
      const parts = ['[']
      obj.forEach((item, i) => {
        const comma = i < obj.length - 1 ? ',' : ''
        parts.push(
          ' '.repeat(indent + 1) +
            (isDict(item) ? inlineObject(item, indent) : serializeMem(item, indent, null)) +
            comma,
        )
      })
      parts.push(' '.repeat(indent) + ']')
      return parts.join('\n')
    }
    // 其余数组（revelant 等）全部单行
    return '[' + obj.map(item => serializeMem(item, indent + 1, null)).join(', ') + ']'
  }
  if (isDict(obj)) {
    if (Object.keys(obj).length === 0) return '{}'
    const parts = ['{']
    const keys = Object.keys(obj)
    keys.forEach((k, i) => {
      const comma = i < keys.length - 1 ? ',' : ''
      parts.push(' '.repeat(indent) + JSON.stringify(k) + ': ' + serializeMem(obj[k], indent + 1, k) + comma)
    })
    parts.push(' '.repeat(indent - 1) + '}')
    return parts.join('\n')
  }
  return JSON.stringify(obj) ?? 'null'
}

const RESULT_KEYS_3 = new Set(['id', 'accuracy', 'summary'])
const RESULT_KEYS_7 = new Set(['score', 'cos', 'kw', 'summary', 'source', 'time', 'accuracy'])

/** cog.json 专用：keywords/results 数组压单行（与 p3_query_log.py 一致） */
export function serializeCog(obj: Json, indent = 1, key: string | null = null): string {
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]'
    if (key === 'results') {
      // results：数组多行，每个 dict 单行
      const parts = ['[']
      obj.forEach((item, i) => {
        const comma = i < obj.length - 1 ? ',' : ''
        parts.push(' '.repeat(indent + 1) + serializeCog(item, indent, null) + comma)
      })
      parts.push(' '.repeat(indent) + ']')
      return parts.join('\n')
    }
    return '[' + obj.map(item => serializeCog(item, indent, null)).join(', ') + ']'
  }
  if (isDict(obj)) {
    if (Object.keys(obj).length === 0) return '{}'
    const keys = new Set(Object.keys(obj))
    if (RESULT_KEYS_3.isSubsetOf(keys) || RESULT_KEYS_7.isSubsetOf(keys)) {
      // result 条目压成单行
      return (
        '{' +
        Object.entries(obj)
          .map(([k, v]) => JSON.stringify(k) + ': ' + JSON.stringify(v) ?? 'null')
          .join(', ') +
        '}'
      )
    }
    const parts = ['{']
    const allKeys = Object.keys(obj)
    allKeys.forEach((k, i) => {
      const comma = i < allKeys.length - 1 ? ',' : ''
      parts.push(' '.repeat(indent) + JSON.stringify(k) + ': ' + serializeCog(obj[k], indent + 1, k) + comma)
    })
    parts.push(' '.repeat(indent - 1) + '}')
    return parts.join('\n')
  }
  return JSON.stringify(obj) ?? 'null'
}
