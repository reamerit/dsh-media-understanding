// 为部署目录建立可解析的 @deepseek-ai 作用域。
//
// 背景（本机实测）：`~/.dsh/profiles/node_modules/@deepseek-ai` 里 240 项是**断链**
// junction，指向 nvm 安装树里并不存在的包；harness 自己的 `node_modules/@deepseek-ai`
// 只有 1 项（`dsh`）。唯一完整可用的闭包是 harness 的 pnpm store
// （`deepseek-harness/node_modules/.pnpm/@deepseek-ai+<pkg>@<ver>_<hash>/node_modules/@deepseek-ai/<pkg>`）。
//
// 这个脚本把 store 里每个包 junction 成 `<deploy>/node_modules/@deepseek-ai/<leaf>`，
// 于是部署目录像普通 node_modules 一样可解析——**且没有任何一份宿主包的副本**，
// 全是链接，运行时仍是宿主那一份模块实例。
//
// 用法：node scripts/deploy.mjs [--target <dir>] [--source <repo>]
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const argOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const source = argOf('--source', root)
const target = argOf('--target', join(dirname(root), '_deploy', 'dsh-media-understanding'))

const storeCandidates = [
  process.env.DSH_HOST_SCOPE,
  'C:\\Users\\Administrator\\deepseek-harness\\node_modules\\.pnpm',
  join(process.env.USERPROFILE ?? '', 'deepseek-harness', 'node_modules', '.pnpm'),
].filter(Boolean)
const store = storeCandidates.find((dir) => {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
})
if (!store) {
  console.error('找不到 pnpm store；设置 DSH_HOST_SCOPE 指向 harness 的 node_modules/.pnpm')
  process.exit(1)
}

// 1) 拷产物（lib/ + src/workers/ + 清单文件）。不拷 node_modules（下面重建）。
rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
for (const entry of ['lib', 'src', 'LICENSE', 'README.md', 'README.en.md', 'package.json', 'cordis.patch.yml']) {
  const from = join(source, entry)
  if (!existsSync(from)) continue
  cpSync(from, join(target, entry), { recursive: true })
}
// package.json 的 files 必须带上 src/workers —— worker 脚本是运行时依赖。
const manifestPath = join(target, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
if (!manifest.files?.includes('src/workers')) {
  manifest.files = [...(manifest.files ?? []), 'src/workers']
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

// 2) 建解析作用域：每个包名 junction 到 store 里"带类型/带运行时"的那一份。
const scope = join(target, 'node_modules', '@deepseek-ai')
mkdirSync(scope, { recursive: true })

const best = new Map()
for (const entry of readdirSync(store)) {
  if (!entry.startsWith('@deepseek-ai+')) continue
  const base = join(store, entry, 'node_modules', '@deepseek-ai')
  let members
  try {
    members = readdirSync(base)
  } catch {
    continue
  }
  for (const leaf of members) {
    const inner = join(base, leaf)
    let pkg
    try {
      pkg = JSON.parse(readFileSync(join(inner, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    const name = typeof pkg.name === 'string' ? pkg.name : leaf
    if (!name.startsWith('@deepseek-ai/')) continue
    // 评分：有 lib/types 更优（运行时那份 dist-only 的 subprocess 缺 .d.ts，但运行时优先）。
    let score = 1
    if (existsSync(join(inner, 'lib', 'index.js'))) score += 4
    if (existsSync(join(inner, 'lib', 'types'))) score += 2
    const previous = best.get(name)
    if (!previous || score > previous.score || (score === previous.score && inner > previous.dir)) {
      best.set(name, { dir: inner, score, version: pkg.version })
    }
  }
}

let linked = 0
for (const [name, info] of best) {
  const leaf = name.slice(name.lastIndexOf('/') + 1)
  const link = join(scope, leaf)
  if (existsSync(link)) continue
  try {
    execFileSync('cmd', ['/c', 'mklink', '/J', link, info.dir], { stdio: 'ignore' })
    linked += 1
  } catch (error) {
    console.error(`junction 失败 ${leaf}: ${String(error)}`)
  }
}

console.log(`deploy target : ${target}`)
console.log(`store         : ${store}`)
console.log(`scope links   : ${linked} new, ${best.size} total`)
for (const required of ['dsh-tools', 'dsh-jobs', 'dsh-llm', 'schemastery', 'cordis']) {
  const ok = existsSync(join(scope, required, 'package.json'))
  console.log(`  ${ok ? 'ok  ' : 'MISS'} ${required}`)
}
