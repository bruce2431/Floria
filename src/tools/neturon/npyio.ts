/**
 * .npy 读写 — embeddings.npy（float32 C 序）最小实现，对照 numpy.save/load 格式
 */

import { readFileSync, writeFileSync } from 'node:fs'

const MAGIC = '\x93NUMPY'

interface NpyHeader {
  descr: string
  fortran_order: boolean
  shape: number[]
}

function parseHeader(buf: Buffer): { header: NpyHeader; dataOffset: number } {
  if (buf.toString('latin1', 0, 6) !== MAGIC) throw new Error('不是 npy 文件（magic 不匹配）')
  const major = buf[6]!
  let headerLen: number
  let offset: number
  if (major === 1) {
    headerLen = buf.readUInt16LE(8)
    offset = 10
  } else {
    headerLen = Number(buf.readUInt32LE(8))
    offset = 12
  }
  const headerStr = buf.toString('latin1', offset, offset + headerLen)
  // Python dict 字面量直接按字段提取（shape 是元组，JSON.parse 不可用）
  const descr = /'descr':\s*'([^']+)'/.exec(headerStr)?.[1]
  const fortranOrder = /'fortran_order':\s*(True|False)/.exec(headerStr)?.[1] === 'True'
  const shapeRaw = /'shape':\s*\(([^)]*)\)/.exec(headerStr)?.[1]
    ?? /'shape':\s*(\d+)/.exec(headerStr)?.[1]
  if (!descr || shapeRaw === undefined) throw new Error(`npy 头解析失败: ${headerStr.slice(0, 120)}`)
  const shape = shapeRaw
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(n => !Number.isNaN(n))
  return { header: { descr, fortran_order: fortranOrder, shape }, dataOffset: offset + headerLen }
}

/** 读 float32 npy → Float32Array（行优先） */
export function readNpyF32(path: string): { data: Float32Array; shape: number[] } {
  const buf = readFileSync(path)
  const { header, dataOffset } = parseHeader(buf)
  if (header.fortran_order) throw new Error('不支持的 npy：fortran_order')
  if (header.descr !== '<f4' && header.descr !== '|f4') {
    throw new Error(`不支持的 dtype: ${header.descr}（仅 <f4）`)
  }
  const count = header.shape.reduce((a, b) => a * b, 1)
  const data = new Float32Array(count)
  for (let i = 0; i < count; i++) data[i] = buf.readFloatLE(dataOffset + i * 4)
  return { data, shape: header.shape }
}

/** 写 float32 npy（行优先，头部 64 字节对齐，与 np.save 一致） */
export function writeNpyF32(path: string, data: Float32Array, shape: number[]): void {
  const headerCore = `{'descr': '<f4', 'fortran_order': False, 'shape': (${shape.join(', ')}${shape.length === 1 ? ',' : ''}), }`
  let headerLen = headerCore.length + 1 // 含尾部 \n
  let pad = 64 - ((10 + headerLen) % 64)
  if (pad === 64) pad = 0
  const header = headerCore + ' '.repeat(pad) + '\n'

  const headerBuf = Buffer.alloc(10 + header.length)
  headerBuf.write(MAGIC, 0, 'latin1')
  headerBuf[6] = 1 // major
  headerBuf[7] = 0 // minor
  headerBuf.writeUInt16LE(header.length, 8)
  headerBuf.write(header, 10, 'latin1')

  const dataBuf = Buffer.alloc(data.length * 4)
  for (let i = 0; i < data.length; i++) dataBuf.writeFloatLE(data[i]!, i * 4)

  writeFileSync(path, Buffer.concat([headerBuf, dataBuf]))
}
