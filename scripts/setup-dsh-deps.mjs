// 把 DSH 宿主闭包 junction 进本仓库 node_modules，供 tsc / tsdown 解析类型。
//
// 为什么需要：本机 DSH 是**从 dev checkout 跑的**（`~/.dsh/bin/dsh.cmd` →
// `C:\Users\Administrator\deepseek-harness\...`），而 `~/.dsh/profiles/web/node_modules/@deepseek-ai`
// 里只有 2 项（cosmokit / schemastery）——照抄范本脚本的默认源头会拿到空闭包。
// 真实闭包在 harness 的 pnpm store 里：
//
//     <DSH_HOST_SCOPE>/@deepseek-ai+<pkg>@<version>_<hash>/node_modules/@deepseek-ai/<pkg>
//
// 优先用环境变量 `DSH_HOST_SCOPE` 指定；未给则探测已知位置。
//
// ⚠️ 同一包在 store 里可能有**多份**（例如 dsh-subprocess 有一份是只含运行时的
// dist 发布、没有 .d.ts）：本脚本按"**优先选带 lib/types 的那份**"来消歧，
// 否则 tsc 会解析到没有类型的副本。
//
// Windows 用 junction（`mklink /J`，无需管理员）；POSIX 用目录符号链接。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const localScoped = join(root, 'node_modules', '@deepseek-ai')
const dryRun = process.argv.includes('--dry-run')
const isWindows = process.platform === 'win32'

/** 候选 store 根：环境变量优先，其次本机实测位置。 */
const candidates = [
  process.env.DSH_HOST_SCOPE,
  'C:\\Users\\Administrator\\deepseek-harness\\node_modules\\.pnpm',
  join(process.env.USERPROFILE ?? '', 'deepseek-harness', 'node_modules', '.pnpm'),
  join(process.env.USERPROFILE ?? '', '.dsh', 'node_modules', '.pnpm'),
].filter(Boolean)

const store = candidates.find((dir) => {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
})

if (!store) {
  console.error('找不到 DSH 闭包来源。请设置 DSH_HOST_SCOPE 指向 harness 的 node_modules/.pnpm')
  console.error('尝试过的位置：')
  for (const c of candidates) console.error(`  ${c}`)
  process.exit(1)
}

console.log(`store: ${store}`)

/**
 * 收集 `<pkg>` → 最优目录。
 *
 * ⚠️ 包名必须读目录里的 `package.json`，**不能从 store 目录名截**：pnpm 对带 peer
 * 的包会写成 `@deepseek-ai+dsh-subprocess_80eeaec0...`（peer hash 用 `_` 与包名相连，
 * 且**没有** `@version`），从名字截会得到 `dsh-subprocess_80eeaec0...` 这种假包名，
 * 于是 tsc 报"找不到模块"。
 *
 * 评分：带 `lib/types` 得 2 分，带 `package.json` 得 1 分；同分取路径字典序最后，
 * 保证结果稳定。dsh-subprocess 在 store 里有两份发布，靠这个分挑到带类型的那份。
 */
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
  for (const pkg of members) {
    const inner = join(base, pkg)
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(inner, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    // 以 manifest 的 name 为准；兜底才用目录名。
    const name = typeof manifest.name === 'string' ? manifest.name : pkg
    if (!name.startsWith('@deepseek-ai/')) continue

    let score = 1
    if (existsSync(join(inner, 'lib', 'types'))) score += 2
    if (typeof manifest.types === 'string' || typeof manifest.typings === 'string') score += 1

    const previous = best.get(name)
    if (!previous || score > previous.score || (score === previous.score && inner > previous.dir)) {
      best.set(name, { dir: inner, score, version: manifest.version })
    }
  }
}

if (best.size === 0) {
  console.error(`store 里没有找到任何 @deepseek-ai 包：${store}`)
  process.exit(1)
}

if (!dryRun) mkdirSync(localScoped, { recursive: true })

let linked = 0
let skipped = 0
for (const [pkg, info] of [...best].sort(([a], [b]) => a.localeCompare(b))) {
  // best 的键是完整包名（`@deepseek-ai/x`），落盘只用最后一段。
  const leaf = pkg.slice(pkg.lastIndexOf('/') + 1)
  const link = join(localScoped, leaf)
  if (existsSync(link)) {
    skipped += 1
    continue
  }
  if (dryRun) {
    console.log(`[dry-run] ${leaf}@${info.version} (score=${info.score}) -> ${info.dir}`)
    continue
  }
  try {
    if (isWindows) {
      execFileSync('cmd', ['/c', 'mklink', '/J', link, info.dir], { stdio: 'ignore' })
    } else {
      symlinkSync(info.dir, link, 'dir')
    }
    linked += 1
  } catch (error) {
    console.error(`junction 失败 ${leaf}: ${String(error)}`)
  }
}

// 类型前提自检：这几个包少了就没法编译。
const required = ['dsh-tools', 'dsh-jobs', 'dsh-llm', 'schemastery', 'cordis']
let missingTypes = 0
for (const name of required) {
  const dir = join(localScoped, name)
  const hasTypes =
    existsSync(join(dir, 'lib', 'types', 'index.d.ts')) ||
    existsSync(join(dir, 'lib', 'index.d.ts'))
  if (!hasTypes) {
    missingTypes += 1
    console.warn(`warn ${name}: 未找到 lib/types/index.d.ts（tsc 会解析失败）`)
  }
}

// dsh-subprocess 有多份发布，单独报告实际选中的那份，便于排查"类型找不到"。
const subprocessEntry = best.get('dsh-subprocess')
if (subprocessEntry) {
  const hasTypes = existsSync(join(subprocessEntry.dir, 'lib', 'types', 'index.d.ts'))
  console.log(
    `dsh-subprocess -> ${subprocessEntry.dir} (types=${hasTypes ? 'yes' : 'NO'})`,
  )
}

const summary = dryRun
  ? `[dry-run] 解析到 ${best.size} 个包，未做改动`
  : `闭包就绪：新链 ${linked}，已存在 ${skipped}，共 ${best.size} 个包`
console.log(summary)
if (missingTypes > 0) {
  console.warn(`warn 有 ${missingTypes} 个必需包缺少类型声明，请检查上面的 store 路径`)
  process.exitCode = 1
}

// 记录来源，便于排查（不参与构建）。
try {
  const marker = join(root, 'node_modules', '.dsh-closure-source')
  if (!dryRun) {
    execFileSync(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(store)})`], {
      stdio: 'ignore',
    })
  }
} catch {
  /* marker 只是便利信息，失败无所谓 */
}

// 保持 package.json 可读检查（避免 junction 到断链目录却毫无提示）。
try {
  JSON.parse(readFileSync(join(localScoped, 'dsh-tools', 'package.json'), 'utf8'))
} catch (error) {
  console.warn(`warn dsh-tools/package.json 不可解析：${String(error)}`)
}
