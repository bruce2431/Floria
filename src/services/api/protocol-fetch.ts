/**
 * Protocol fetch dispatcher — the single place a provider's declared wire
 * protocol is turned into a concrete fetch implementation.
 *
 * Every Anthropic-wire emission point (the SDK client in client.ts, plus the
 * raw-fetch sites in toolSearch.ts and neuron cogname.ts) resolves its fetch
 * through here, so the protocol judgment lives in exactly one module.
 *
 * - `'anthropic'` (or anything unrecognized) → `undefined`: use the default
 *   fetch and talk Anthropic Messages straight to the base URL (unchanged
 *   historical behavior).
 * - `'openai-chat'` → the OpenAI Chat Completions translating adapter.
 */

import { createOpenAIChatFetch } from './openai-chat-fetch-adapter.js'

export function resolveProtocolFetch(opts: {
  protocol: string | null | undefined
  baseUrl: string | null
  apiKey: string | null
  innerFetch?: typeof globalThis.fetch
}): typeof globalThis.fetch | undefined {
  const protocol = (opts.protocol ?? 'anthropic').toLowerCase()
  if (protocol === 'openai-chat') {
    if (!opts.baseUrl) return undefined
    return createOpenAIChatFetch({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey ?? '',
      innerFetch: opts.innerFetch,
    }) as typeof globalThis.fetch
  }
  return undefined
}
