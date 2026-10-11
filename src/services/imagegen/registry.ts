/**
 * 生图 adapter 注册表。
 *
 * 各 adapter 模块在被 import 时自注册（副作用）；公共层用 selectImageAdapter()
 * 按上下文挑第一个 supports() 命中的 adapter。零厂商分支——加一家只需实现
 * 接口并 registerImageAdapter()。
 */

import type { ImageGenerationAdapter, ImageGenerationContext } from './types.js'

const adapters: ImageGenerationAdapter[] = []

/** 注册（同名幂等，避免重复 import 造成的重复项）。 */
export function registerImageAdapter(adapter: ImageGenerationAdapter): void {
  if (!adapters.some(a => a.name === adapter.name)) {
    adapters.push(adapter)
  }
}

/** 挑一个认得的 adapter；都不认得返回 null（由调用方报明确错误）。 */
export function selectImageAdapter(
  ctx: ImageGenerationContext,
): ImageGenerationAdapter | null {
  return adapters.find(a => a.supports(ctx)) ?? null
}

export function listImageAdapters(): string[] {
  return adapters.map(a => a.name)
}
