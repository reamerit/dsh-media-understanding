// 构建：先生成/校验宿主类型闭包，再 tsdown 打包，最后 tsc 生成 lib/types。
//
// 顺序不可换：tsdown 入口带 `clean: true`，会清空 lib/——
// 先跑 tsc 会把刚生成的 d.ts 一起删掉，导致 package.json 的 types 字段悬空。
// 不用 npx/cmd 垫片，直接 node 调 bin 入口（沙箱对 spawn 有约束）。
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const node = process.execPath

const run = (args, label) => {
  console.log(`> ${label ?? `node ${args.join(' ')}`}`)
  execFileSync(node, args, { cwd: root, stdio: 'inherit' })
}

if (!existsSync(join(root, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib'))) {
  console.log('> 宿主类型闭包缺失，先跑 setup-dsh-deps')
  run([join('scripts', 'setup-dsh-deps.mjs')], 'node scripts/setup-dsh-deps.mjs')
}

run([join('node_modules', 'tsdown', 'dist', 'run.mjs'), '-c', 'tsdown.config.ts'])
run([join('node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.dts.json'])
console.log('build done')
