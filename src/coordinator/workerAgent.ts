import { ASYNC_AGENT_ALLOWED_TOOLS, COORDINATOR_MODE_ALLOWED_TOOLS } from '../constants/tools.js'
import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js'
import type { AgentDefinition, BuiltInAgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import {
  getCoordinatorSystemPrompt,
  INTERNAL_WORKER_TOOLS,
} from './coordinatorMode.js'

/**
 * Worker system prompt. The coordinator's prompt (getCoordinatorSystemPrompt)
 * describes how to spawn workers and write self-contained prompts; this is the
 * counterpart that tells a spawned worker how to behave. Workers cannot see the
 * coordinator's conversation, so they must rely entirely on their task prompt.
 */
function getWorkerSystemPrompt(): string {
  return `You are Floria, an autonomous worker sub-agent operating under a coordinator.

## Your Role

A coordinator spawned you to complete a specific, self-contained task. The coordinator cannot see your conversation, so the task prompt you received contains everything you need. Complete it autonomously — do not expect follow-up context that you were not given.

## How to Work

1. Read your task prompt carefully. If it references files or a codebase, read the relevant files first to ground yourself before acting.
2. Break multi-step work into steps and track progress with the TodoWrite tool.
3. Use your tools to investigate, implement, or verify as directed. You have standard file, search, shell, and web tools, MCP tools from connected servers, and project skills via the Skill tool.
4. When implementing: fix the root cause, not the symptom. Run relevant tests and typechecks, then commit your changes and report the hash (when git is available) — self-verify before reporting done.
5. When finished, report your results in a concise final message. Include specific file paths, line numbers, and any errors — the coordinator reads your report to synthesize the next step.

## Rules

- You cannot spawn further agents — complete the task directly with your tools.
- Do not delegate work; do not assume context you were not given — verify by reading files.
- Stay within the scope of your task. If you discover something related but out of scope, mention it in one sentence at most.
- Your final report is the only record of your work the coordinator sees — make it specific and complete.`
}

/**
 * Coordinator agent — the main-thread orchestration role in coordinator mode.
 * Its tool set is the coordinator's allowed tools (spawn/continue/stop workers,
 * emit synthetic output), matching COORDINATOR_MODE_ALLOWED_TOOLS. The prompt is
 * shared with the standalone coordinator prompt injected by systemPrompt.ts.
 */
const COORDINATOR_AGENT: BuiltInAgentDefinition = {
  agentType: 'coordinator',
  whenToUse: `Main-thread orchestration agent in coordinator mode. Spawns worker sub-agents (subagent_type "worker") via the ${AGENT_TOOL_NAME} tool to research, implement, and verify work in parallel, then synthesizes results for the user.`,
  tools: Array.from(COORDINATOR_MODE_ALLOWED_TOOLS),
  source: 'built-in',
  baseDir: 'built-in',
  getSystemPrompt: () => getCoordinatorSystemPrompt(),
}

/**
 * Worker agent — the autonomous sub-agent spawned by the coordinator. Its tool
 * set matches what getCoordinatorUserContext advertises to the coordinator:
 * the async-agent tool set minus internal worker/orchestration tools, so
 * workers can do real work but cannot spawn further agents or emit synthetic
 * output as if they were the coordinator.
 */
const WORKER_AGENT: BuiltInAgentDefinition = {
  agentType: 'worker',
  whenToUse: `Autonomous worker sub-agent. Spawned by the coordinator with a self-contained task prompt; executes research, implementation, and verification independently and reports back via the ${AGENT_TOOL_NAME} result.`,
  tools: Array.from(ASYNC_AGENT_ALLOWED_TOOLS).filter(
    name => !INTERNAL_WORKER_TOOLS.has(name),
  ),
  source: 'built-in',
  baseDir: 'built-in',
  getSystemPrompt: () => getWorkerSystemPrompt(),
}

/**
 * Returns the full built-in agent list for coordinator mode. Replaces the
 * normal built-in agents (general-purpose, explore, plan, ...) when
 * COORDINATOR_MODE + CLAUDE_CODE_COORDINATOR_MODE are active — the main thread
 * is the coordinator (its prompt and tool filter are applied elsewhere), and
 * "worker" is the only sub-agent type the coordinator may spawn.
 */
export function getCoordinatorAgents(): AgentDefinition[] {
  return [COORDINATOR_AGENT, WORKER_AGENT]
}
