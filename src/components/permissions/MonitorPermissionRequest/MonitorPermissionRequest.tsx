// Permission prompt for the Monitor tool. The tool's checkPermissions defaults
// to allow (delegates to the generic permission system), so this dialog appears
// only when no allow rule matches. Mirrors FallbackPermissionRequest: Yes /
// Yes-and-don't-ask-again / No, but surfaces the monitor description/command
// via the tool's renderToolUseMessage.

import React, { useCallback, useMemo } from 'react'
import { getOriginalCwd } from '../../../bootstrap/state.js'
import { Box, Text, useTheme } from '../../../ink.js'
import { sanitizeToolNameForAnalytics } from '../../../services/analytics/metadata.js'
import { env } from '../../../utils/env.js'
import { shouldShowAlwaysAllowOptions } from '../../../utils/permissions/permissionsLoader.js'
import { truncateToLines } from '../../../utils/stringUtils.js'
import { logUnaryEvent } from '../../../utils/unaryLogging.js'
import type { UnaryEvent } from '../hooks.js'
import { usePermissionRequestLogging } from '../hooks.js'
import { PermissionDialog } from '../PermissionDialog.js'
import {
  PermissionPrompt,
  type PermissionPromptOption,
  type ToolAnalyticsContext,
} from '../PermissionPrompt.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js'

type MonitorOptionValue = 'yes' | 'yes-dont-ask-again' | 'no'

export function MonitorPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  verbose: _verbose,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  const [theme] = useTheme()
  const originalUserFacingName = toolUseConfirm.tool.userFacingName(
    toolUseConfirm.input as never,
  )
  const userFacingName = originalUserFacingName.endsWith(' (MCP)')
    ? originalUserFacingName.slice(0, -6)
    : originalUserFacingName

  const unaryEvent = useMemo<UnaryEvent>(
    () => ({
      completion_type: 'tool_use_single',
      language_name: 'none',
    }),
    [],
  )
  usePermissionRequestLogging(toolUseConfirm, unaryEvent)

  const handleSelect = useCallback(
    (value: MonitorOptionValue, feedback?: string) => {
      switch (value) {
        case 'yes':
          void logUnaryEvent({
            completion_type: 'tool_use_single',
            event: 'accept',
            metadata: {
              language_name: 'none',
              message_id: toolUseConfirm.assistantMessage.message.id,
              platform: env.platform,
            },
          })
          toolUseConfirm.onAllow(toolUseConfirm.input, [], feedback)
          onDone()
          break
        case 'yes-dont-ask-again': {
          void logUnaryEvent({
            completion_type: 'tool_use_single',
            event: 'accept',
            metadata: {
              language_name: 'none',
              message_id: toolUseConfirm.assistantMessage.message.id,
              platform: env.platform,
            },
          })
          toolUseConfirm.onAllow(toolUseConfirm.input, [
            {
              type: 'addRules',
              rules: [{ toolName: toolUseConfirm.tool.name }],
              behavior: 'allow',
              destination: 'localSettings',
            },
          ])
          onDone()
          break
        }
        case 'no':
          void logUnaryEvent({
            completion_type: 'tool_use_single',
            event: 'reject',
            metadata: {
              language_name: 'none',
              message_id: toolUseConfirm.assistantMessage.message.id,
              platform: env.platform,
            },
          })
          toolUseConfirm.onReject(feedback)
          onReject()
          onDone()
          break
      }
    },
    [toolUseConfirm, onDone, onReject],
  )

  const handleCancel = useCallback(() => {
    void logUnaryEvent({
      completion_type: 'tool_use_single',
      event: 'reject',
      metadata: {
        language_name: 'none',
        message_id: toolUseConfirm.assistantMessage.message.id,
        platform: env.platform,
      },
    })
    toolUseConfirm.onReject()
    onReject()
    onDone()
  }, [toolUseConfirm, onReject, onDone])

  const originalCwd = getOriginalCwd()
  const showAlwaysAllowOptions = shouldShowAlwaysAllowOptions()

  const options = useMemo(
    (): PermissionPromptOption<MonitorOptionValue>[] => {
      const result: PermissionPromptOption<MonitorOptionValue>[] = [
        {
          label: 'Yes',
          value: 'yes',
          feedbackConfig: { type: 'accept' },
        },
      ]
      if (showAlwaysAllowOptions) {
        result.push({
          label: (
            <Text>
              Yes, and don't ask again for{' '}
              <Text bold>{userFacingName}</Text> commands in{' '}
              <Text bold>{originalCwd}</Text>
            </Text>
          ),
          value: 'yes-dont-ask-again',
        })
      }
      result.push({
        label: 'No',
        value: 'no',
        feedbackConfig: { type: 'reject' },
      })
      return result
    },
    [userFacingName, originalCwd, showAlwaysAllowOptions],
  )

  const toolAnalyticsContext = useMemo<ToolAnalyticsContext>(
    () => ({
      toolName: sanitizeToolNameForAnalytics(toolUseConfirm.tool.name),
      isMcp: toolUseConfirm.tool.isMcp ?? false,
    }),
    [toolUseConfirm.tool.name, toolUseConfirm.tool.isMcp],
  )

  return (
    <PermissionDialog title="Tool use" workerBadge={workerBadge}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text>
          {userFacingName}(
          {toolUseConfirm.tool.renderToolUseMessage(toolUseConfirm.input as never, {
            theme,
            verbose: true,
          })}
          )
          {originalUserFacingName.endsWith(' (MCP)') ? (
            <Text dimColor> (MCP)</Text>
          ) : null}
        </Text>
        <Text dimColor>{truncateToLines(toolUseConfirm.description, 3)}</Text>
      </Box>

      <Box flexDirection="column">
        <PermissionRuleExplanation
          permissionResult={toolUseConfirm.permissionResult}
          toolType="tool"
        />
        <PermissionPrompt
          options={options}
          onSelect={handleSelect}
          onCancel={handleCancel}
          toolAnalyticsContext={toolAnalyticsContext}
        />
      </Box>
    </PermissionDialog>
  )
}
