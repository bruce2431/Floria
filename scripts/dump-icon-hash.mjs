// dump-icon-hash.mjs — md5 of each RT_ICON bin per exe
// usage: bun scripts/dump-icon-hash.mjs <exe>...
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { NtExecutable, NtExecutableResource } from 'pe-library'

const ICON = 3
for (const p of process.argv.slice(2)) {
  const exe = NtExecutable.from(Buffer.from(readFileSync(p)))
  const res = NtExecutableResource.from(exe)
  const row = {}
  for (const e of res.entries) {
    if (e.type === ICON) {
      const b = Buffer.from(e.bin)
      row[`id=${e.id}`] = `${b.byteLength}B ` + createHash('md5').update(b).digest('hex').slice(0, 12)
    }
  }
  console.log(p.split(/[\\/]/).pop())
  console.log('  ', JSON.stringify(row))
}
