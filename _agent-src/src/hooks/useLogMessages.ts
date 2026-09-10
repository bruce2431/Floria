import type { UUID } from 'crypto'
import { useEffect, useRef } from 'react'
import { useAppState } from '../state/AppState.js'
import type { Message } from '../types/message.js'
import { isAgentSwarmsEnabled } from '../utils/agentSwarmsEnabled.js'
import { isRenderArchivePlaceholder } from '../utils/renderCap.js'
import {
  cleanMessagesForLogging,
  isChainParticipant,
  recordTranscript,
} from '../utils/sessionStorage.js'

/**
 * Hook that logs messages to the transcript
 * conversation ID that only changes when a new conversation is started.
 *
 * @param messages The current conversation messages
 * @param ignore When true, messages will not be recorded to the transcript
 */
export function useLogMessages(messages: Message[], ignore: boolean = false) {
  const teamContext = useAppState(s => s.teamContext)

  // messages is append-only between compactions, so track where we left off
  // and only pass the new tail to recordTranscript. Avoids O(n) filter+scan
  // on every setMessages (~20x/turn, so n=3000 was ~120k wasted iterations).
  const lastRecordedLengthRef = useRef(0)
  const lastParentUuidRef = useRef<UUID | undefined>(undefined)
  // First-uuid change = compaction or /clear rebuilt the array; length alone
  // can't detect this since post-compact [CB,summary,...keep,new] may be longer.
  const firstMessageUuidRef = useRef<UUID | undefined>(undefined)
  // Guard against stale async .then() overwriting a fresher sync update when
  // an incremental render fires before the compaction .then() resolves.
  const callSeqRef = useRef(0)

  useEffect(() => {
    if (ignore) return

    // 2026-09-09 渲染投影剥离（占位断链根治）：归档占位（capRenderedMessages 产物）
    // 是渲染投影专属标记，不属于转录权威。cap 砍头瞬间它在 state 头部替换旧头部
    // （first-uuid 变化），本 hook 会误判为 compaction 走全量重录；占位 uuid 每次砍头
    // 都新建（随机），不在 messageSet → 被当新消息落盘，且该路径 startingParentUuid
    // = undefined → parentUuid=null 成链根，主链被切成碎段（resume chain walk 停在
    // 占位 → 历史全丢，db31825f 实证 12 条占位 13 段链）。落盘/增量判定一律基于
    // 剥投影后的数组；渲染仍消费完整投影（占位照常显示），两者在边界处分离。
    // 2026-09-10 全量 filter 退役：占位「至多一条、恒在下标 0」已由 capRenderedMessages
    // 归一化在唯一写入口强制（全量替换路径的中部残留同样被收拢剥除），此处 O(1) 头部
    // 剥离即完备，不再每 effect O(n) 扫描+新建数组。
    const authoritative = isRenderArchivePlaceholder(messages[0]) ? messages.slice(1) : messages

    const currentFirstUuid = authoritative[0]?.uuid as UUID | undefined
    const prevLength = lastRecordedLengthRef.current

    // First-render: firstMessageUuidRef is undefined. Compaction: first uuid changes.
    // Both are !isIncremental, but first-render sync-walk is safe (no messagesToKeep).
    const wasFirstRender = firstMessageUuidRef.current === undefined
    const isIncremental =
      currentFirstUuid !== undefined &&
      !wasFirstRender &&
      currentFirstUuid === firstMessageUuidRef.current &&
      prevLength <= authoritative.length
    // Same-head shrink: tombstone filter, rewind, snip, partial-compact.
    // Distinguished from compaction (first uuid changes) because the tail
    // is either an existing on-disk message or a fresh message that this
    // same effect's recordTranscript(fullArray) will write — see sync-walk
    // guard below.
    const isSameHeadShrink =
      currentFirstUuid !== undefined &&
      !wasFirstRender &&
      currentFirstUuid === firstMessageUuidRef.current &&
      prevLength > authoritative.length

    const startIndex = isIncremental ? prevLength : 0
    if (startIndex === authoritative.length) return

    // Full array on first call + after compaction: recordTranscript's own
    // O(n) dedup loop handles messagesToKeep interleaving correctly there.
    const slice = startIndex === 0 ? authoritative : authoritative.slice(startIndex)
    const parentHint = isIncremental ? lastParentUuidRef.current : undefined

    // Fire and forget - we don't want to block the UI.
    const seq = ++callSeqRef.current
    void recordTranscript(
      slice,
      isAgentSwarmsEnabled()
        ? {
            teamName: teamContext?.teamName,
            agentName: teamContext?.selfAgentName,
          }
        : {},
      parentHint,
      authoritative,
    ).then(lastRecordedUuid => {
      // For compaction/full array case (!isIncremental): use the async return
      // value. After compaction, messagesToKeep in the array are skipped
      // (already in transcript), so the sync loop would find a wrong UUID.
      // Skip if a newer effect already ran (stale closure would overwrite the
      // fresher sync update from the subsequent incremental render).
      if (seq !== callSeqRef.current) return
      if (lastRecordedUuid && !isIncremental) {
        lastParentUuidRef.current = lastRecordedUuid
      }
    })

    // Sync-walk safe for: incremental (pure new-tail slice), first-render
    // (no messagesToKeep interleaving), and same-head shrink. Shrink is the
    // subtle one: the picked uuid is either already on disk (tombstone/rewind
    // — survivors were written before) or is being written by THIS effect's
    // recordTranscript(fullArray) call (snip boundary / partial-compact tail
    // — enqueueWrite ordering guarantees it lands before any later write that
    // chains to it). Without this, the ref stays stale at a tombstoned uuid:
    // the async .then() correction is raced out by the next effect's seq bump
    // on large sessions where recordTranscript(fullArray) is slow. Only the
    // compaction case (first uuid changed) remains unsafe — tail may be
    // messagesToKeep whose last-actually-recorded uuid differs.
    if (isIncremental || wasFirstRender || isSameHeadShrink) {
      // Match EXACTLY what recordTranscript persists: cleanMessagesForLogging
      // applies both the isLoggableMessage filter and (for external users) the
      // REPL-strip + isVirtual-promote transform. Using the raw predicate here
      // would pick a UUID that the transform drops, leaving the parent hint
      // pointing at a message that never reached disk. Pass full messages as
      // replId context — REPL tool_use and its tool_result land in separate
      // render cycles, so the slice alone can't pair them.
      const last = cleanMessagesForLogging(slice, authoritative).findLast(
        isChainParticipant,
      )
      if (last) lastParentUuidRef.current = last.uuid as UUID
    }

    lastRecordedLengthRef.current = authoritative.length
    firstMessageUuidRef.current = currentFirstUuid
  }, [messages, ignore, teamContext?.teamName, teamContext?.selfAgentName])
}
