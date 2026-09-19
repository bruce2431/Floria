/**
 * Memory-shape telemetry for the memdir system (MEMORY_SHAPE_TELEMETRY feature).
 *
 * Logs statistical shape information about memories on recall and write
 * operations so the team can analyse usage patterns.
 *
 * @module
 */

/**
 * Log the shape of recalled memories (number, selected count, etc.).
 *
 * @param {Array<unknown>} _memories  - The full set of recalled memories.
 * @param {Array<unknown>} _selected  - The subset selected for context.
 */
function logMemoryRecallShape(_memories, _selected) {
  // No-op in the stub; real implementations emit telemetry events.
}

/**
 * Log the shape of a memory write operation (tool, file path, scope, etc.).
 *
 * @param {string}      _toolName  - The tool that initiated the write.
 * @param {unknown}     _toolInput - The tool's input payload.
 * @param {string}      _filePath  - The file path being written to.
 * @param {string}      _scope     - The memory scope (e.g. 'user', 'project').
 */
function logMemoryWriteShape(_toolName, _toolInput, _filePath, _scope) {
  // No-op in the stub; real implementations emit telemetry events.
}

module.exports = {
  logMemoryRecallShape,
  logMemoryWriteShape,
}
