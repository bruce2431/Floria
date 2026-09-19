// Workflow script discovery + frontmatter parsing, shared by WorkflowTool
// (run a script as a background sub-agent) and createWorkflowCommand (register
// each script as a /workflow-name slash command).
//
// A workflow script is a markdown file in `<cwd>/.claude/workflows/*.md`:
//
//   ---
//   name: triage
//   description: Triage an incoming issue
//   ---
//   (body = instruction set handed to the background sub-agent)
//
// name defaults to the filename; description defaults to the name.

import { readdir, readFile } from 'fs/promises'
import { basename, join } from 'path'

export type WorkflowScript = {
  name: string
  description: string
  prompt: string
  filePath: string
}

export const WORKFLOWS_DIR = '.claude/workflows'

// Matches a leading `---` frontmatter block plus the body that follows.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

function frontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'm').exec(frontmatter)
  return match?.[1]?.trim()
}

export function parseWorkflowScript(
  filePath: string,
  content: string,
): WorkflowScript | null {
  const match = FRONTMATTER_RE.exec(content)
  if (!match) return null
  const frontmatter = match[1]
  const prompt = match[2]?.trim() ?? ''
  if (!prompt) return null
  const name =
    frontmatterValue(frontmatter, 'name') ?? basename(filePath, '.md')
  const description =
    frontmatterValue(frontmatter, 'description') ?? name
  return { name, description, prompt, filePath }
}

export async function listWorkflowScripts(
  cwd: string,
): Promise<WorkflowScript[]> {
  const dir = join(cwd, WORKFLOWS_DIR)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    // No .claude/workflows/ dir yet — nothing to list.
    return []
  }
  const scripts: WorkflowScript[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const filePath = join(dir, entry)
    try {
      const content = await readFile(filePath, 'utf8')
      const script = parseWorkflowScript(filePath, content)
      if (script) scripts.push(script)
    } catch {
      // Unreadable file — skip it.
    }
  }
  return scripts
}

export async function getWorkflowScript(
  cwd: string,
  name: string,
): Promise<WorkflowScript | null> {
  const scripts = await listWorkflowScripts(cwd)
  return scripts.find(script => script.name === name) ?? null
}
