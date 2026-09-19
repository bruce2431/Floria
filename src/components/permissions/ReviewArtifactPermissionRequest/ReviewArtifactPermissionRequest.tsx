import * as React from 'react'
import { useState } from 'react'
import { Box, Text } from '../../../ink.js'
import type { OptionWithDescription } from '../../CustomSelect/select.js'
import { SelectMulti } from '../../CustomSelect/SelectMulti.js'
import { ReviewArtifactTool } from '../../../tools/ReviewArtifactTool/ReviewArtifactTool.js'
import { PermissionDialog } from '../PermissionDialog.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'

const SEVERITY_COLORS: Record<string, string> = {
  critical: 'red',
  security: 'red',
  major: 'yellow',
  minor: 'inactive',
  perf: 'cyan',
}

/**
 * Permission dialog for the ReviewArtifact tool.
 *
 * Shows the review artifact (title, summary, findings) and lets the user
 * toggle which findings to keep before approving. The kept finding ids are
 * injected back into the tool input as `selected` via onAllow — mirroring how
 * AskUserQuestion's dialog injects `answers`. Rejecting (Esc) calls onReject.
 */
export function ReviewArtifactPermissionRequest(
  props: PermissionRequestProps,
): React.ReactNode {
  const { toolUseConfirm, onDone, onReject, workerBadge } = props

  const result = ReviewArtifactTool.inputSchema.safeParse(toolUseConfirm.input)
  if (!result.success) {
    return null
  }
  const input = result.data
  const allIds = input.findings.map(f => f.id)

  const [selected, setSelected] = useState<string[]>(allIds)

  const options: OptionWithDescription<string>[] = input.findings.map(f => ({
    value: f.id,
    label: f.title,
    description: `[${f.severity}] ${f.file}${
      f.line !== undefined ? `:${f.line}` : ''
    }`,
  }))

  const submit = (values: string[]) => {
    onDone()
    toolUseConfirm.onAllow({ ...toolUseConfirm.input, selected: values }, [], undefined)
  }
  const reject = () => {
    onDone()
    toolUseConfirm.onReject()
  }

  return (
    <PermissionDialog
      title={input.title}
      subtitle={<Text wrap="wrap">{input.summary}</Text>}
      workerBadge={workerBadge}
    >
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row">
          <Text dimColor>
            Keep {selected.length}/{input.findings.length} finding(s). Space
            toggles · Enter on “Approve & save” · Esc to reject.
          </Text>
        </Box>
        <SelectMulti
          options={options}
          defaultValue={allIds}
          onChange={setSelected}
          submitButtonText="Approve & save"
          onSubmit={submit}
          onCancel={reject}
          hideIndexes
        />
      </Box>
    </PermissionDialog>
  )
}
