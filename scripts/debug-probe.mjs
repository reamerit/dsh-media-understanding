/**
 * 复现 media_probe 的输出校验失败：把 Python 探针的真实返回跑一遍，
 * 找出哪个字段不是 JSON 无损的。
 *
 * 用法：node scripts/debug-probe.mjs
 */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

const script = join(root, 'src', 'workers', 'probe.py')
const result = spawnSync('python', [script], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
if (result.error) {
  console.error('probe failed:', result.error.message)
  process.exit(1)
}
const probe = JSON.parse(result.stdout)

function scan(value, path = '$', seen = new Set()) {
  if (value === null) return
  const type = typeof value
  if (type === 'number') {
    if (!Number.isFinite(value)) console.log(`NON-FINITE at ${path}: ${value}`)
    return
  }
  if (type === 'undefined') {
    console.log(`UNDEFINED at ${path}`)
    return
  }
  if (type === 'bigint' || type === 'function' || type === 'symbol') {
    console.log(`${type.toUpperCase()} at ${path}`)
    return
  }
  if (type !== 'object') return
  if (seen.has(value)) {
    console.log(`CYCLE at ${path}`)
    return
  }
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((item, i) => scan(item, `${path}[${i}]`, seen))
    return
  }
  for (const [key, item] of Object.entries(value)) scan(item, `${path}.${key}`, seen)
}

scan(probe)
console.log('--- probe keys ---')
console.log(Object.keys(probe).join(', '))
console.log('--- modules ---')
for (const [name, entry] of Object.entries(probe.modules ?? {})) {
  console.log(name, JSON.stringify(entry))
}
console.log('--- cuda ---', JSON.stringify(probe.cuda))
console.log('--- models ---', JSON.stringify(probe.models))
console.log('--- errors ---', JSON.stringify(probe.errors))
