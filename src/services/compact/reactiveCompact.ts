/**
 * Reactive compaction (REACTIVE_COMPACT).
 *
 * Fires when the API rejects a request instead of waiting for the auto-compact
 * threshold:
 *   - Prompt-too-long (PTL) → summarize the head, keep the tail, retry.
 *   - Media-size rejection (image >5MB base64 / many-image dimension / PDF
 *     page limit) → strip the offending media blocks in memory and retry, no
 *     summary API call needed.
 *   - Usage-policy refusal (stop_reason 'refusal') → strip ALL media blocks
 *     in memory and retry (the API refuses the whole request every turn while
 *     the offending content — usually an image — stays in history).
 *
 * The compile-time `feature('REACTIVE_COMPACT')` gate at the require sites
 * (query.ts / commands/compact/compact.ts) guarantees this module is only
 * loaded when the flag is on; runtime opt-out is via the env var below.
 *
 * Media stripping only ever mutates the in-memory message array — it never
 * touches `imageStore.ts`'s image-cache disk files (those are session
 * scrollback/resume persistence and are intentionally preserved).
 */
import { APIUserAbortError } from '@anthropic-ai/sdk'
import { API_IMAGE_MAX_BASE64_SIZE } from '../../constants/apiLimits.js'
import type {
  AssistantMessage,
  Message,
  UserMessage,
} from '../../types/message.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { hasExactErrorMessage } from '../../utils/errors.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { logError } from '../../utils/log.js'
import {
  createCompactBoundaryMessage,
  createUserMessage,
} from '../../utils/messages.js'
import { getMainLoopModel } from '../../utils/model/model.js'
import { modelSupportsVision } from '../../utils/model/vision.js'
import { processSessionStartHooks } from '../../utils/sessionStart.js'
import { getTranscriptPath } from '../../utils/sessionStorage.js'
import {
  isMediaSizeErrorMessage,
  isPromptTooLongMessage,
  isUsagePolicyRefusalMessage,
} from '../api/errors.js'
import {
  annotateBoundaryWithPreservedSegment,
  compactConversation,
  createPlanAttachmentIfNeeded,
  ERROR_MESSAGE_NOT_ENOUGH_MESSAGES,
  ERROR_MESSAGE_PROMPT_TOO_LONG,
  stripImagesFromMessages,
  type CompactionResult,
} from './compact.js'
import { estimateMessageTokens } from './microCompact.js'
import { getCompactUserSummaryMessage } from './prompt.js'

// Base64 data length above which an image is "large" enough to plausibly
// exceed the 2000px many-image dimension limit. Without decoding dimensions,
// base64 size is the best available proxy; 2MB base64 is well under the 5MB
// hard error but corresponds to a high-resolution image.
const MANY_IMAGE_LARGE_BASE64_THRESHOLD = 2 * 1024 * 1024

export function isReactiveCompactEnabled(): boolean {
  return !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_REACTIVE_COMPACT)
}

export function isReactiveOnlyMode(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_REACTIVE_ONLY_COMPACT)
}

export function isWithheldPromptTooLong(msg: AssistantMessage): boolean {
  return isReactiveCompactEnabled() && isPromptTooLongMessage(msg)
}

export function isWithheldMediaSizeError(msg: AssistantMessage): boolean {
  return isReactiveCompactEnabled() && isMediaSizeErrorMessage(msg)
}

export function isWithheldUsagePolicyRefusal(msg: AssistantMessage): boolean {
  return isReactiveCompactEnabled() && isUsagePolicyRefusalMessage(msg)
}

export type ReactiveCompactReason =
  | 'too_few_groups'
  | 'aborted'
  | 'exhausted'
  | 'error'
  | 'media_unstrippable'

export type ReactiveCompactOutcome =
  | { ok: true; result: CompactionResult; reason: 'ok' }
  | { ok: false; result: null; reason: ReactiveCompactReason }

/**
 * Entry point called by query.ts after the API loop withholds a PTL / media
 * error. Returns a CompactionResult to rebuild context and retry, or null when
 * no recovery is possible (error should surface).
 */
export async function tryReactiveCompact({
  hasAttempted,
  querySource,
  aborted,
  messages,
  cacheSafeParams,
}: {
  hasAttempted: boolean
  querySource?: string
  aborted: boolean
  messages: Message[]
  cacheSafeParams: CacheSafeParams
}): Promise<CompactionResult | null> {
  if (aborted || hasAttempted) return null
  if (querySource === 'compact' || querySource === 'session_memory') return null

  const last = messages.at(-1)
  if (!last || last.type !== 'assistant') return null

  if (isMediaSizeErrorMessage(last)) {
    // Media rejection: strip the offending blocks in memory and retry — no
    // summary API call required.
    return stripRetry(messages, last, cacheSafeParams)
  }

  if (isUsagePolicyRefusalMessage(last)) {
    // Usage-policy refusal: the API refuses the whole request because of
    // conversation content it will re-see verbatim on every retry — most
    // commonly a policy-violating image in history. Strip ALL media in
    // memory and retry once (hasAttempted guards the spiral; if the text
    // alone still triggers a refusal, the error surfaces as-is).
    return policyStripRetry(messages, cacheSafeParams)
  }

  if (isPromptTooLongMessage(last)) {
    const outcome = await runSummary(messages, cacheSafeParams, {
      customInstructions: undefined,
      trigger: 'auto',
    })
    return outcome.ok ? outcome.result : null
  }

  return null
}

/**
 * /compact path (called by compactViaReactive when isReactiveOnlyMode is set,
 * or by the reactive /compact command). Runs the head-summary compaction with
 * PreCompact hooks already handled by the caller.
 */
export async function reactiveCompactOnPromptTooLong(
  messages: Message[],
  cacheSafeParams: CacheSafeParams,
  opts: { customInstructions?: string; trigger: 'auto' | 'manual' },
): Promise<ReactiveCompactOutcome> {
  return runSummary(messages, cacheSafeParams, opts)
}

async function runSummary(
  messages: Message[],
  cacheSafeParams: CacheSafeParams,
  opts: { customInstructions?: string; trigger: 'auto' | 'manual' },
): Promise<ReactiveCompactOutcome> {
  try {
    if (messages.length === 0) {
      return { ok: false, result: null, reason: 'too_few_groups' }
    }
    const result = await compactConversation(
      messages,
      cacheSafeParams.toolUseContext,
      cacheSafeParams,
      opts.trigger === 'auto', // suppressFollowUpQuestions
      opts.customInstructions,
      opts.trigger === 'auto', // isAutoCompact
      undefined, // recompactionInfo
      false, // runPreHooks — callers (compactViaReactive / tryReactiveCompact) run them
    )
    return { ok: true, result, reason: 'ok' }
  } catch (error) {
    if (error instanceof APIUserAbortError) {
      return { ok: false, result: null, reason: 'aborted' }
    }
    if (hasExactErrorMessage(error, ERROR_MESSAGE_NOT_ENOUGH_MESSAGES)) {
      return { ok: false, result: null, reason: 'too_few_groups' }
    }
    if (hasExactErrorMessage(error, ERROR_MESSAGE_PROMPT_TOO_LONG)) {
      // The compaction request itself couldn't fit even after retries.
      return { ok: false, result: null, reason: 'exhausted' }
    }
    logError(error)
    return { ok: false, result: null, reason: 'error' }
  }
}

/**
 * Strip oversized media from the in-memory message array and build a
 * suffix-preserving CompactionResult that keeps everything (post-strip).
 * Returns null when nothing could be stripped.
 */
async function stripRetry(
  messages: Message[],
  errorMsg: AssistantMessage,
  cacheSafeParams: CacheSafeParams,
): Promise<CompactionResult | null> {
  const stripped = stripOversizedMedia(messages, errorMsg)
  if (!stripped || stripped.messages.length === 0) {
    return null
  }
  return buildStripCompactionResult(
    stripped.messages,
    stripped.imagesRemoved,
    cacheSafeParams,
  )
}

/**
 * Usage-policy refusal retry: strip ALL media blocks (via the compaction-path
 * stripper — images/documents replaced with text markers, including those
 * nested in tool_result content) and rebuild with the suffix-preserving
 * result. Refusals don't identify the offending block, so every media block
 * is stripped. Returns null when history holds no media — the refusal is
 * text-based and surfaces as-is instead of retrying a doomed request.
 */
async function policyStripRetry(
  messages: Message[],
  cacheSafeParams: CacheSafeParams,
): Promise<CompactionResult | null> {
  // Drop the trailing synthetic refusal message itself before stripping.
  const filtered = messages.filter(
    message => !(message.type === 'assistant' && message.isApiErrorMessage),
  )
  const mediaRemoved = countMediaBlocks(filtered)
  if (mediaRemoved === 0) return null
  const stripped = stripImagesFromMessages(filtered)
  if (stripped.length === 0) return null
  return buildStripCompactionResult(
    stripped,
    mediaRemoved,
    cacheSafeParams,
    `Filtered ${mediaRemoved} media block${
      mediaRemoved === 1 ? '' : 's'
    } that triggered a usage-policy refusal.`,
  )
}

function countMediaBlocks(messages: Message[]): number {
  let count = 0
  for (const message of messages) {
    if (message.type !== 'user') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block.type === 'image' || block.type === 'document') {
        count++
      } else if (block.type === 'tool_result' && Array.isArray(block.content)) {
        for (const item of block.content) {
          if (item.type === 'image' || item.type === 'document') count++
        }
      }
    }
  }
  return count
}

/**
 * In-memory media strip. Decides per error detail + current model vision:
 *   - non-vision model → drop ALL image blocks (model can't see them anyway)
 *   - PDF page-limit error → drop document blocks
 *   - image >5MB → drop image blocks whose base64 exceeds the hard limit
 *   - many-image → drop image blocks above the large-size proxy threshold
 * Also drops the trailing API error message itself.
 */
function stripOversizedMedia(
  messages: Message[],
  errorMsg: AssistantMessage,
): { messages: Message[]; imagesRemoved: number } | null {
  const errorDetails = errorMsg.errorDetails ?? ''
  const isPdf = /maximum of \d+ PDF pages/.test(errorDetails)
  const isManyImage = errorDetails.includes('many-image')
  const supportsVision = modelSupportsVision(getMainLoopModel())

  const shouldStripImage = (dataLength: number): boolean => {
    if (!supportsVision) return true
    if (isPdf) return false // PDF errors aren't about image blocks
    if (dataLength > API_IMAGE_MAX_BASE64_SIZE) return true
    if (isManyImage && dataLength > MANY_IMAGE_LARGE_BASE64_THRESHOLD) {
      return true
    }
    return false
  }

  let imagesRemoved = 0

  const filtered = messages.filter(
    message => !(message.type === 'assistant' && message.isApiErrorMessage),
  )

  const result = filtered.map(message => {
    if (message.type !== 'user' || !Array.isArray(message.message.content)) {
      return message
    }
    let changed = false
    const content = message.message.content.flatMap(block => {
      if (block.type === 'document') {
        if (isPdf || !supportsVision) {
          changed = true
          return []
        }
        return [block]
      }
      if (block.type === 'image') {
        const dataLength =
          block.source?.type === 'base64' ? block.source.data.length : 0
        if (shouldStripImage(dataLength)) {
          changed = true
          imagesRemoved++
          return []
        }
        return [block]
      }
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        let toolChanged = false
        const newContent = block.content.flatMap(item => {
          // Nested images (FileRead on an image etc.).
          if (item.type === 'image') {
            const dataLength =
              item.source?.type === 'base64' ? item.source.data.length : 0
            if (shouldStripImage(dataLength)) {
              toolChanged = true
              imagesRemoved++
              return []
            }
            return [item]
          }
          // Nested documents (FileRead on a PDF etc.).
          if (item.type === 'document') {
            if (isPdf || !supportsVision) {
              toolChanged = true
              return []
            }
          }
          return [item]
        })
        if (toolChanged) {
          changed = true
          return [{ ...block, content: newContent }]
        }
        return [block]
      }
      return [block]
    })

    if (!changed) return message
    // Keep the message structurally valid if stripping emptied its content.
    const finalContent =
      content.length === 0
        ? [
            {
              type: 'text' as const,
              text: '[image removed for media-size recovery]',
            },
          ]
        : content
    return { ...message, message: { ...message.message, content: finalContent } }
  })

  if (imagesRemoved === 0 || result.length === 0) {
    return null
  }
  return { messages: result, imagesRemoved }
}

/**
 * Build the suffix-preserving CompactionResult for a strip-retry: everything
 * is kept (messagesToKeep = stripped array), the summary just records how many
 * images were removed. No compact-API call.
 */
async function buildStripCompactionResult(
  messages: Message[],
  imagesRemoved: number,
  cacheSafeParams: CacheSafeParams,
  summaryNote?: string,
): Promise<CompactionResult> {
  const preCompactTokenCount = estimateMessageTokens(messages)
  const boundaryMarker = createCompactBoundaryMessage(
    'auto',
    preCompactTokenCount ?? 0,
    messages.at(-1)?.uuid,
  )

  const transcriptPath = getTranscriptPath()
  const summaryContent =
    summaryNote ??
    `Removed ${imagesRemoved} image${
      imagesRemoved === 1 ? '' : 's'
    } that exceeded the API's media-size limits.`
  const summaryMessages: UserMessage[] = [
    createUserMessage({
      content: getCompactUserSummaryMessage(
        summaryContent,
        false,
        transcriptPath,
        true, // recentMessagesPreserved — everything is kept verbatim
      ),
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    }),
  ]

  const annotatedBoundary = annotateBoundaryWithPreservedSegment(
    boundaryMarker,
    summaryMessages.at(-1)!.uuid,
    messages,
  )

  const planAttachment = createPlanAttachmentIfNeeded(
    cacheSafeParams.toolUseContext.agentId,
  )
  const attachments = planAttachment ? [planAttachment] : []

  const hookResults = await processSessionStartHooks('compact', {
    model: getMainLoopModel(),
  })

  return {
    boundaryMarker: annotatedBoundary,
    summaryMessages,
    messagesToKeep: messages,
    attachments,
    hookResults,
    preCompactTokenCount,
    postCompactTokenCount: estimateMessageTokens(summaryMessages),
    truePostCompactTokenCount: estimateMessageTokens([
      annotatedBoundary,
      ...summaryMessages,
      ...messages,
      ...attachments,
      ...hookResults,
    ]),
  }
}
