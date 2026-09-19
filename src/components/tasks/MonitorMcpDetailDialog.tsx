// Detail dialog for monitor_mcp tasks (the "Monitors" group in the background
// tasks dialog). Shows status, runtime, the monitored command, and a live tail
// of the task output. Killed via 'x'; Esc/Enter/Space or ← go back to the list.

import React, { Suspense, use, useDeferredValue, useEffect, useState } from 'react'
import type { DeepImmutable } from 'src/types/utils.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import type { MonitorMcpTaskState } from '../../tasks/MonitorMcpTask/MonitorMcpTask.js'
import { formatDuration, formatFileSize, truncateToWidth } from '../../utils/format.js'
import { tailFile } from '../../utils/fsOperations.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import { Byline } from '../design-system/Byline.js'
import { Dialog } from '../design-system/Dialog.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'

type Props = {
  task: DeepImmutable<MonitorMcpTaskState>
  onKill?: () => void
  onBack: () => void
}

const MONITOR_DETAIL_TAIL_BYTES = 8192

type TaskOutputResult = {
  content: string
  bytesTotal: number
}

async function getTaskOutput(
  task: DeepImmutable<MonitorMcpTaskState>,
): Promise<TaskOutputResult> {
  const path = getTaskOutputPath(task.id)
  try {
    const result = await tailFile(path, MONITOR_DETAIL_TAIL_BYTES)
    return { content: result.content, bytesTotal: result.bytesTotal }
  } catch {
    return { content: '', bytesTotal: 0 }
  }
}

export function MonitorMcpDetailDialog({
  task,
  onKill,
  onBack,
}: Props): React.ReactNode {
  const { columns } = useTerminalSize()
  const [outputPromise, setOutputPromise] = useState<Promise<TaskOutputResult>>(
    () => getTaskOutput(task),
  )
  const deferredOutputPromise = useDeferredValue(outputPromise)

  useEffect(() => {
    if (task.status !== 'running') return
    const timer = setInterval(
      (setOutputPromise_, task_) => setOutputPromise_(getTaskOutput(task_)),
      1000,
      setOutputPromise,
      task,
    )
    return () => clearInterval(timer)
  }, [task.id, task.status])

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
    } else if (e.key === 'x' && task.status === 'running' && onKill) {
      e.preventDefault()
      onKill()
    }
  }

  const displayCommand = truncateToWidth(task.command, 280)

  const inputGuide = (exitState: {
    pending: boolean
    keyName?: string
  }) =>
    exitState.pending ? (
      <Text>Press {exitState.keyName} again to exit</Text>
    ) : (
      <Byline>
        <KeyboardShortcutHint shortcut="←" action="go back" />
        <KeyboardShortcutHint shortcut="Esc/Enter/Space" action="close" />
        {task.status === 'running' && onKill && (
          <KeyboardShortcutHint shortcut="x" action="stop" />
        )}
      </Byline>
    )

  return (
    <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Dialog
        title="Monitor details"
        onCancel={handleClose}
        color="background"
        inputGuide={inputGuide}
      >
        <Box flexDirection="column">
          <Text>
            <Text bold>Status:</Text>{' '}
            {task.status === 'running' ? (
              <Text color="background">{task.status}</Text>
            ) : task.status === 'completed' ? (
              <Text color="success">{task.status}</Text>
            ) : (
              <Text color="error">{task.status}</Text>
            )}
          </Text>
          <Text>
            <Text bold>Runtime:</Text>{' '}
            {formatDuration((task.endTime ?? Date.now()) - task.startTime)}
          </Text>
          <Text wrap="wrap">
            <Text bold>Script:</Text> {displayCommand}
          </Text>
        </Box>

        <Box flexDirection="column">
          <Text bold>Output:</Text>
          <Suspense
            fallback={<Text dimColor>Loading output…</Text>}
          >
            <MonitorOutputContent
              outputPromise={deferredOutputPromise}
              columns={columns}
            />
          </Suspense>
        </Box>
      </Dialog>
    </Box>
  )
}

type MonitorOutputContentProps = {
  outputPromise: Promise<TaskOutputResult>
  columns: number
}

function MonitorOutputContent({
  outputPromise,
  columns,
}: MonitorOutputContentProps): React.ReactNode {
  const { content, bytesTotal } = use(outputPromise)
  if (!content) {
    return <Text dimColor>No output available</Text>
  }

  // Find last 10 line boundaries via lastIndexOf
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
