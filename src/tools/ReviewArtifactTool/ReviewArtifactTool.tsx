import { feature } from 'bun:bundle'
import { mkdir, writeFile } from 'fs/promises'
import { dirname, isAbsolute, normalize, resolve, sep } from 'path'
import { z } from 'zod/v4'
import { BLACK_CIRCLE } from 'src/constants/figures.js'
import { getModeColor } from 'src/utils/permissions/PermissionMode.js'
import { Box, Text } from '../../ink.js'
import { buildTool, type Tool, type ToolDef } from '../../Tool.js'
import { getAllowedChannels } from '../../bootstrap/state.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  REVIEW_ARTIFACT_DEFAULT_DIR,
  REVIEW_ARTIFACT_TOOL_NAME,
} from './constants.js'

const severitySchema = z.enum(['critical', 'security', 'major', 'minor', 'perf'])
export type Severity = z.infer<typeof severitySchema>

const findingSchema = lazySchema(() =>
  z.object({
    id: z
      .string()
      .describe('Stable identifier for this finding (used by the approval dialog selection)'),
    severity: severitySchema.describe('Impact level of the issue'),
    file: z.string().describe('Relative path of the affected file'),
    line: z
      .number()
      .int()
      .optional()
      .describe('1-based line number where the issue appears, if applicable'),
    title: z.string().describe('Short summary of the issue'),
    description: z.string().describe('Why this is a bug and its impact'),
    fix: z.string().optional().describe('Suggested fix for the issue'),
  }),
)

const inputSchema = lazySchema(() =>
  z
    .strictObject({
      title: z.string().describe('Title of the review artifact'),
      summary: z.string().describe('Overview of what was reviewed'),
      findings: z
        .array(findingSchema())
        .describe('Findings produced by the review, ordered by importance'),
      targetFile: z
        .string()
        .optional()
        .describe(
          `Relative path to write the artifact to (default: ${REVIEW_ARTIFACT_DEFAULT_DIR}/<timestamp>-<slug>.md)`,
        ),
      selected: z
        .array(z.string())
        .optional()
        .describe(
          'Finding ids the user kept after reviewing. Injected by the approval dialog; when absent, all findings are included.',
        ),
    })
    .passthrough(),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    filePath: z.string().describe('Absolute path where the artifact was written'),
    selected: z.array(z.string()).describe('Finding ids included in the artifact'),
    discarded: z.number().describe('Number of findings the user deselected'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

// SDK-facing schemas mirror the internal ones (fields are public).
export const _sdkInputSchema = inputSchema
export const _sdkOutputSchema = outputSchema

/**
 * Validation for the artifact target path. We only accept relative paths that
 * stay inside the working directory (no absolute paths, no `..` traversal).
 */
function validateTargetFile(p: string): string | null {
  if (p.trim() === '') return 'targetFile must not be empty'
  if (isAbsolute(p)) return 'targetFile must be a relative path'
  const parts = normalize(p).split(sep)
  if (parts.includes('..')) return 'targetFile must not contain ".."'
  return null
}

function compactTimestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(
    d.getHours(),
  )}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'review'
  )
}

function renderArtifactMarkdown(input: Input, kept: Input['findings']): string {
  const lines: string[] = [`# ${input.title}`, '', input.summary, '']
  if (kept.length === 0) {
    lines.push('_No findings selected for this artifact._', '')
  }
  for (const f of kept) {
    lines.push(
      `## [${f.severity}] ${f.title}`,
      '',
      `- File: \`${f.file}\`${f.line !== undefined ? `:${f.line}` : ''}`,
      '',
      f.description,
      '',
    )
    if (f.fix) {
      lines.push('**Suggested fix:**', '', f.fix, '')
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n'
}

function ReviewArtifactResultMessage({
  filePath,
  selected,
  discarded,
}: {
  filePath: string
  selected: string[]
  discarded: number
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <Text color={getModeColor('default')}>{BLACK_CIRCLE} </Text>
        <Text>
          Review artifact saved · {selected.length} finding(s) · {discarded}{' '}
          discarded
        </Text>
      </Box>
      <Text color="inactive">{filePath}</Text>
    </Box>
  )
}

export const ReviewArtifactTool: Tool<InputSchema, Output> = buildTool({
  name: REVIEW_ARTIFACT_TOOL_NAME,
  searchHint: 'present a review artifact for approval and save it',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  async description() {
    return 'Present a review artifact (a structured code-review report) to the user for approval, then save it. Requires user interaction.'
  },
  async prompt() {
    return `Present a code-review artifact to the user for approval, then save it to disk.

When you have finished reviewing a change, build the artifact:
- \`title\`: short title of the review
- \`summary\`: overview of what was reviewed and the key conclusions
- \`findings\`: ordered list of issues. Each finding needs a unique \`id\`, a \`severity\` (critical|security|major|minor|perf), the affected \`file\`, an optional 1-based \`line\`, a \`title\`, a \`description\` explaining why it is a bug, and an optional \`fix\`.

The tool requires user interaction: the user reviews the findings and may deselect some before approving. After approval the artifact is written to \`targetFile\` (default: ${REVIEW_ARTIFACT_DEFAULT_DIR}/<timestamp>-<slug>.md) and only the selected findings are included. Call this once per review, after you have collected all findings.`
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return ''
  },
  isEnabled() {
    // Mirrors AskUserQuestionTool: with channels active the user is not
    // watching the TUI, and the approval dialog would hang with nobody at
    // the keyboard. Channel permission relay skips requiresUserInteraction()
    // tools, so there is no alternate approval path.
    if (
      (feature('KAIROS') || feature('KAIROS_CHANNELS')) &&
      getAllowedChannels().length > 0
    ) {
      return false
    }
    return true
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return false // writes the artifact file
  },
  requiresUserInteraction() {
    return true
  },
  async validateInput(input) {
    if (input.targetFile !== undefined) {
      const err = validateTargetFile(input.targetFile)
      if (err) {
        return { result: false, message: err, errorCode: 1 }
      }
    }
    const ids = input.findings.map(f => f.id)
    if (ids.length !== new Set(ids).size) {
      return {
        result: false,
        message: 'Finding ids must be unique',
        errorCode: 1,
      }
    }
    return { result: true }
  },
  async checkPermissions(input) {
    return {
      behavior: 'ask' as const,
      message: 'Approve this review artifact?',
      updatedInput: input,
    }
  },
  renderToolUseMessage() {
    return null
  },
  renderToolUseProgressMessage() {
    return null
  },
  renderToolResultMessage({ filePath, selected, discarded }, _toolUseID) {
    return (
      <ReviewArtifactResultMessage
        filePath={filePath}
        selected={selected}
        discarded={discarded}
      />
    )
  },
  renderToolUseRejectedMessage() {
    return (
      <Box flexDirection="row" marginTop={1}>
        <Text color={getModeColor('default')}>{BLACK_CIRCLE} </Text>
        <Text>User declined the review artifact</Text>
      </Box>
    )
  },
  renderToolUseErrorMessage() {
    return null
  },
  async call(input, _context) {
    const allIds = input.findings.map(f => f.id)
    const selected = input.selected ?? allIds
    const selectedSet = new Set(selected)
    const kept = input.findings.filter(f => selectedSet.has(f.id))
    const discarded = input.findings.length - kept.length

    const targetFile =
      input.targetFile ??
      `${REVIEW_ARTIFACT_DEFAULT_DIR}/${compactTimestamp()}-${slugify(input.title)}.md`
    const pathErr = validateTargetFile(targetFile)
    if (pathErr) {
      throw new Error(pathErr)
    }
    const absPath = resolve(process.cwd(), targetFile)
    const markdown = renderArtifactMarkdown(input, kept)
    await mkdir(dirname(absPath), { recursive: true })
    await writeFile(absPath, markdown, 'utf-8')

    return {
      data: {
        filePath: absPath,
        selected,
        discarded,
      },
    }
  },
  mapToolResultToToolResultBlockParam({ filePath, selected, discarded }, toolUseID) {
    return {
      type: 'tool_result',
      content: `Review artifact saved to ${filePath}

Findings included: ${selected.length}
Findings discarded: ${discarded}`,
      tool_use_id: toolUseID,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
