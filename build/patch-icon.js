const fs = require('fs')
const path = require('path')
const ResEdit = require('resedit')

const exePath = process.argv[2]
const icoPath = process.argv[3]

if (!exePath || !icoPath) {
  console.error('Usage: node patch-icon.js <exe> <icon.ico>')
  process.exit(1)
}

const executable = ResEdit.NtExecutable.from(fs.readFileSync(exePath))
const resources = ResEdit.NtExecutableResource.from(executable)

// 14 is the numeric Windows resource type RT_GROUP_ICON.
const groupEntries = resources.entries.filter(entry => entry.type === 14)
const groupId = groupEntries[0]?.id ?? 1

const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath))
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
  resources.entries,
  groupId,
  1033,
  iconFile.icons.map(icon => icon.data),
)

resources.outputResource(executable)
const output = Buffer.from(executable.generate())
fs.writeFileSync(exePath, output)

console.log(`Icon patched: ${path.basename(exePath)} (group ${groupId}, ${iconFile.icons.length} images)`)
