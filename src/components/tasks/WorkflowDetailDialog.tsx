// Detail dialog for local_workflow tasks (the "Workflows" group in the
// background tasks dialog). Shows status, runtime, the workflow name/summary,
// and a live tail of the child claude's output. 'x' kills; 's' skips the
// current agent; 'r' retries it. Esc/Enter/Space or ← go back to the list.

import React, { Suspense, use, useDeferredValue, useEffect, useState } from 'react'
import type { DeepImmutable } from 'src/types/utils.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import type { LocalWorkflowTaskState } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { formatDuration, formatFileSize, truncateToWidth } from '../../utils/format.js'
import { tailFile } from '../../utils/fsOperations.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import { Byline } from '../design-system/Byline.js'
import { Dialog } from '../design-system/Dialog.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'

type Props = {
  workflow: DeepImmutable<LocalWorkflowTaskState>
  onDone: (result?: string, options?: { display: 'system' }) => void
  onKill?: () => void
  onSkipAgent?: (agentId: string) => void
  onRetryAgent?: (agentId: string) => void
  onBack: () => void
}

const WORKFLOW_DETAIL_TAIL_BYTES = 8192

type TaskOutputResult = {
  content: string
  bytesTotal: number
}

async function getTaskOutput(
  workflow: DeepImmutable<LocalWorkflowTaskState>,
): Promise<TaskOutputResult> {
  const path = getTaskOutputPath(workflow.id)
  try {
    const result = await tailFile(path, WORKFLOW_DETAIL_TAIL_BYTES)
    return { content: result.content, bytesTotal: result.bytesTotal }
  } catch {
    return { content: '', bytesTotal: 0 }
  }
}

export function WorkflowDetailDialog({
  workflow,
  onDone,
  onKill,
  onSkipAgent,
  onRetryAgent,
  onBack,
}: Props): React.ReactNode {
  const { columns } = useTerminalSize()
  const [outputPromise, setOutputPromise] = useState<Promise<TaskOutputResult>>(
    () => getTaskOutput(workflow),
  )
  const deferredOutputPromise = useDeferredValue(outputPromise)

  useEffect(() => {
    if (workflow.status !== 'running') return
    const timer = setInterval(
      (setOutputPromise_, workflow_) =>
        setOutputPromise_(getTaskOutput(workflow_)),
      1000,
      setOutputPromise,
      workflow,
    )
    return () => clearInterval(timer)
  }, [workflow.id, workflow.status])

  const handleClose = () => onBack()

  useKeybindings(
    { 'confirm:yes': handleClose },
    { context: 'Confirmation' },
  )

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === ' ') {
      e.preventDefault()
      onBack()
    } else if (e.key === 'left') {
      e.preventDefault()
      onBack()
    } else if (e.key === 'x' && workflow.status === 'running' && onKill) {
      e.preventDefault()
      onKill()
    } else if (
      e.key === 's' &&
      workflow.status === 'running' &&
      onSkipAgent &&
      workflow.currentAgentId
    ) {
      e.preventDefault()
      onSkipAgent(workflow.currentAgentId)
    } else if (
      e.key === 'r' &&
      workflow.status === 'running' &&
      onRetryAgent &&
      workflow.currentAgentId
    ) {
      e.preventDefault()
      onRetryAgent(workflow.currentAgentId)
    }
  }

  const displayName = truncateToWidth(workflow.workflow.name, 280)

  const inputGuide = (exitState: { pending: boolean; keyName?: string }) =>
    exitState.pending ? (
      <Text>Press {exitState.keyName} again to exit</Text>
    ) : (
      <Byline>
        <KeyboardShortcutHint shortcut="←" action="go back" />
        <KeyboardShortcutHint shortcut="Esc/Enter/Space" action="close" />
        {workflow.status === 'running' && (
          <>
            {onSkipAgent && (
              <KeyboardShortcutHint shortcut="s" action="skip agent" />
            )}
            {onRetryAgent && (
              <KeyboardShortcutHint shortcut="r" action="retry agent" />
            )}
            {onKill && (
              <KeyboardShortcutHint shortcut="x" action="stop" />
            )}
          </>
        )}
      </Byline>
    )

  return (
    <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Dialog
        title="Workflow details"
        onCancel={handleClose}
        color="background"
        inputGuide={inputGuide}
      >
        <Box flexDirection="column">
          <Text>
            <Text bold>Status:</Text>{' '}
            {workflow.status === 'running' ? (
              <Text color="background">{workflow.status}</Text>
            ) : workflow.status === 'completed' ? (
              <Text color="success">{workflow.status}</Text>
            ) : (
              <Text color="error">{workflow.status}</Text>
            )}
          </Text>
          <Text>
            <Text bold>Runtime:</Text>{' '}
            {formatDuration(
              (workflow.endTime ?? Date.now()) - workflow.startTime,
            )}
          </Text>
          <Text wrap="wrap">
            <Text bold>Workflow:</Text> {displayName}
          </Text>
          {workflow.summary ? (
            <Text wrap="wrap">
              <Text bold>Summary:</Text> {workflow.summary}
            </Text>
          ) : null}
        </Box>

        <Box flexDirection="column">
          <Text bold>Output:</Text>
          <Suspense fallback={<Text dimColor>Loading output…</Text>}>
            <WorkflowOutputContent
              outputPromise={deferredOutputPromise}
              columns={columns}
            />
          </Suspense>
        </Box>
      </Dialog>
    </Box>
  )
}

type WorkflowOutputContentProps = {
  outputPromise: Promise<TaskOutputResult>
  columns: number
}

function WorkflowOutputContent({
  outputPromise,
  columns,
}: WorkflowOutputContentProps): React.ReactNode {
  const { content, bytesTotal } = use(outputPromise)
  if (!content) {
    return <Text dimColor>No output available</Text>
  }

  // Find last 10 line boundaries via lastIndexOf.
  const starts: number[] = []
  let pos = content.length
  for (let i = 0; i < 10 && pos > 0; i++) {
    const prev = content.lastIndexOf('\n', pos - 1)
    starts.push(prev + 1)
    pos = prev
  }
  starts.reverse()
  const isIncomplete = bytesTotal > content.length

  const rendered: string[] = []
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!
    const end = i < starts.length - 1 ? starts[i + 1]! - 1 : content.length
    const line = content.slice(start, end)
    if (line) rendered.push(line)
  }

  return (
    <>
      <Box
        borderStyle="round"
        paddingX={1}
        flexDirection="column"
        height={12}
        maxWidth={columns - 6}
      >
        {rendered.map((line, i) => (
          <Text key={i} wrap="truncate-end">
            {line}
          </Text>
        ))}
      </Box>
      <Text dimColor italic>
        {`Showing ${rendered.length} lines`}
        {isIncomplete ? ` of ${formatFileSize(bytesTotal)}` : ''}
      </Text>
    </>
  )
}
