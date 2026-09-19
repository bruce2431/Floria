/**
 * Vision-capability detection for the current model.
 *
 * Single source of truth: the credential pool's explicit per-model override
 * (`/key vision <model> on|off|auto`). With no override set, a model is
 * assumed NOT vision-capable.
 *
 * Name-pattern inference was removed: model names are not a reliable signal
 * (official names get deprecated/renamed — e.g. `deepseek-chat` is deprecated,
 * and custom names like `deepseek-v4-flash` carry no naming hint), and guessing
 * wrong either drops user images (false negative) or sends images to a
 * text-only model (repeated media-size 413s). Since the pool only runs text
 * models today, the safe default is non-vision; mark real vision models
 * explicitly with `/key vision <model> on`.
 *
 * Used by:
 *   - processUserInput: non-vision models skip attaching pasted image blocks.
 *   - reactiveCompact strip-retry: non-vision → strip ALL image blocks;
 *     vision → strip only the oversized ones.
 */
import { getModelVision, setModelVision } from '../credentials/pool.js'

/**
 * Does the given model accept image input?
 */
export function modelSupportsVision(modelName: string): boolean {
  const override = getModelVision(modelName)
  return override ?? false
}

/**
 * Where a model's vision judgment came from — used by `/key vision` display.
 */
export type VisionSource = 'explicit' | 'default'

export function getVisionSource(modelName: string): VisionSource {
  return getModelVision(modelName) !== undefined ? 'explicit' : 'default'
}

export { setModelVision }
