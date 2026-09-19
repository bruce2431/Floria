#!/usr/bin/env bun
// postprocess-icon.mjs — rewrite an exe's icon into a SINGLE RT_GROUP_ICON (id=1)
// so Windows Explorer picks the correct frame per size (crisp at all sizes).
//
// WHY THIS EXISTS
// ---------------
// `bun build --compile --windows-icon` embeds a TWO-group icon structure:
// a named "IDI_MYICON" group (256px-only) + a numeric id=0 group (full size
// list). Windows uses the IDI_MYICON frame for EVERY display size, so a 256px
// frame gets downscaled everywhere (over-sharp at small sizes). rcedit's own
// rewrite leaves a malformed IDI_MYICON (stale byte-size pointing at the 16px
// frame), which can make Windows fall back to the generic app icon.
//
// A SINGLE well-formed RT_GROUP_ICON id=1 with the full frame list makes
// Windows do per-size frame selection (verified experimentally: a 9-frame
// exe returned red@16px, green@32px via SHGetFileInfo).
//
// HOW IT RUNS
// -----------
// Invoked from scripts/build.ts after `bun build --compile`, via
//   bun scripts/postprocess-icon.mjs <exe> [<ico>]
// <ico> defaults to assets/icon.ico. pe-library (a resedit dependency) is
// patched in-place (idempotent) to accept bun's `.bun` section that lives
// after `.rsrc`; the RVA recalculation still shifts subsequent sections.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const exePath = resolve(process.argv[2])
const icoPath = process.argv[3] ? resolve(process.argv[3]) : join(root, 'assets', 'icon.ico')

if (!existsSync(exePath)) throw new Error(`exe not found: ${exePath}`)
if (!existsSync(icoPath)) throw new Error(`ico not found: ${icoPath}`)

// --- patch pe-library: allow extra sections after the resource section (bun .bun) ---
const PATCH_MARK = '// [postprocess-icon] patched: allow sections after resource'
const pelibFile = join(root, 'node_modules', 'pe-library', 'dist', 'NtExecutableResource.js')
if (!existsSync(pelibFile)) {
  throw new Error(`pe-library not found: ${pelibFile} — run "bun install" first`)
}
{
  let src = readFileSync(pelibFile, 'utf8')
  if (!src.includes(PATCH_MARK)) {
    const orig = "throw new Error('After Resource section, sections except for relocation are not supported')"
    if (src.includes(orig)) {
      src = src.replace(orig, PATCH_MARK + '\n              // RVA recalculation still shifts subsequent sections correctly')
      writeFileSync(pelibFile, src)
      console.log('[postprocess-icon] patched pe-library (bun .bun section support)')
    } else {
      console.warn('[postprocess-icon] pe-library already differs from expected; continuing')
    }
  }
}

// --- dynamic imports AFTER the patch so the patched file is loaded ---
const { NtExecutable, NtExecutableResource } = await import('pe-library')
const ResEdit = await import('resedit')

const data = readFileSync(exePath)
const exe = NtExecutable.from(data)
const res = NtExecutableResource.from(exe)

// remove all existing icon resources (RT_ICON=3, RT_GROUP_ICON=14)
let removedGroups = 0
for (const e of [...res.entries]) {
  if (e.type === 3 || e.type === 14) {
    res.removeResourceEntry(e.type, e.id, e.lang)
    removedGroups += 1
  }
}

// parse the .ico and install a single group id=1
const iconFile = ResEdit.Data.IconFile.from(readFileSync(icoPath))
const frames = iconFile.icons.map((item) => item.data)
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, frames)

res.outputResource(exe)
const out = Buffer.from(exe.generate())
writeFileSync(exePath, out)

console.log(`[postprocess-icon] removed ${removedGroups} icon resource(s), wrote single RT_GROUP_ICON id=1 (${frames.length} frames) → ${exePath}`)
