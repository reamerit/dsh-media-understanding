// 对比两份 README 的表格结构：按"章节 + 表头"对齐，逐表比较行数与首列标签。
import { readFileSync } from 'node:fs'

const read = (f) => readFileSync(f, 'utf8')

/** 切出「## 章节 → 表格」的列表：每张表记录表头与首列标签。 */
function tables(text) {
  const lines = text.split(/\r?\n/)
  const out = []
  let section = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^## /.test(line)) {
      section = line.replace(/^##\s+/, '')
      continue
    }
    if (!/^\|/.test(line)) continue
    // 表头行：下一行是 |---|
    if (/^\|[\s:|-]+\|$/.test(lines[i + 1] ?? '')) {
      const header = line.split('|').slice(1, -1).map((c) => c.trim())
      const rows = []
      let j = i + 2
      while (j < lines.length && /^\|/.test(lines[j])) {
        rows.push(lines[j].split('|')[1]?.trim() ?? '')
        j++
      }
      out.push({ section, header, rows })
      i = j - 1
    }
  }
  return out
}

const zh = tables(read('README.md'))
const en = tables(read('README.en.md'))

console.log(`tables: zh=${zh.length} en=${en.length}\n`)
let mismatch = 0
const n = Math.max(zh.length, en.length)
for (let i = 0; i < n; i++) {
  const a = zh[i]
  const b = en[i]
  if (!a || !b) {
    console.log(`#${i + 1} MISSING on ${!a ? 'zh' : 'en'}`)
    mismatch++
    continue
  }
  const same = a.header.length === b.header.length && a.rows.length === b.rows.length
  const flag = same ? 'ok  ' : 'DIFF'
  if (!same) mismatch++
  console.log(
    `${flag} #${i + 1} [${a.section}]\n     zh cols=${a.header.length} rows=${a.rows.length}  ${JSON.stringify(a.header)}\n     en cols=${b.header.length} rows=${b.rows.length}  ${JSON.stringify(b.header)}`,
  )
  if (!same) {
    console.log(`     zh first-col: ${JSON.stringify(a.rows.slice(0, 12))}`)
    console.log(`     en first-col: ${JSON.stringify(b.rows.slice(0, 12))}`)
  }
}
console.log(`\nmismatched tables: ${mismatch}`)
process.exitCode = mismatch === 0 ? 0 : 1
