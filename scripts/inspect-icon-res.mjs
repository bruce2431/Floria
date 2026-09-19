// inspect-icon-res.mjs — dump RT_ICON / RT_GROUP_ICON structure of an exe
// usage: bun scripts/inspect-icon-res.mjs <exe>...
import { readFileSync } from 'node:fs'
import { NtExecutable, NtExecutableResource } from 'pe-library'
import { Resource } from 'resedit'

const ICON = 3
const GROUP = 14

for (const p of process.argv.slice(2)) {
  const exe = NtExecutable.from(Buffer.from(readFileSync(p)))
  const res = NtExecutableResource.from(exe)
  console.log('=== ' + p)
  const icons = {}
  for (const e of res.entries) {
    if (e.type === ICON) icons[`id=${e.id} lang=${e.lang}`] = e.bin.byteLength
  }
  console.log('RT_ICON entries:', JSON.stringify(icons))
  const groups = Resource.IconGroupEntry.fromEntries(res.entries)
  for (const g of groups) {
    console.log(`RT_GROUP_ICON id=${g.id} lang=${g.lang}:`)
    for (const [i, d] of g.icons.entries()) {
      console.log(`  [${i}] ${d.width}x${d.height} colors=${d.colors} planes=${d.planes} bit=${d.bitCount} dataSize=${d.dataSize} iconID=${d.iconID}`)
    }
  }
}
