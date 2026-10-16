// 安装期构建：让"直接从 git 源安装"（github:owner/repo）也能拿到声明的入口产物。
//
// 为什么需要：从 git 源安装只拿到仓库里**被提交的文件**，而 `lib/` 在 .gitignore 里
// （构建产物不进仓库），于是安装目录缺少 package.json 声明的 `./lib/index.js`。
// dsh 插件市场按入口产物是否存在判断可加载性，缺了会把插件判成 broken 并拒绝启用
// （报"声明的入口产物缺失(源码检出或构建被拦),下次启动会失败"）。
// pnpm 只对**带 prepare/prepack 的 git 依赖**跑构建，所以钩子挂在这里。
//
// 与 `scripts/build.mjs` 的分工：
// - build.mjs 是开发/发布路径，宿主类型闭包缺失就硬失败（发布不能被降级）；
// - 本脚本是安装路径，只把"入口产物"当硬指标：
//     1. tsdown 打包（必做）—— external 覆盖全部 `@deepseek-ai/*`，不依赖宿主，
//        必然产出 lib/index.js 与 lib/pure/*.js；
//     2. 宿主类型闭包 + `tsc -p tsconfig.dts.json` 出 lib/types（**尽力而为**）——
//        别人的机器上不一定有 DSH 安装，拿不到就跳过：d.ts 只在类型解析时用，
//        运行时不需要，入口产物没有才是致命的。
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const node = process.execPath

/**
 * 跑一步构建。
 * @param args - 传给 node 的参数（一律走 node 直调 bin，不用 npx/cmd 垫片）。
 * @param tolerate - true 时失败只告警，不中断安装。
 * @returns 这一步是否成功。
 */
function run(args, { tolerate = false } = {}) {
  console.log(`> node ${args.join(' ')}`)
  try {
    execFileSync(node, args, { cwd: root, stdio: 'inherit' })
    return true
  } catch (error) {
    if (!tolerate) throw error
    console.warn(`warn 这一步失败，安装继续：${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

// 1) 入口产物。
run([join('node_modules', 'tsdown', 'dist', 'run.mjs'), '-c', 'tsdown.config.ts'])

// 2) 类型声明（尽力而为）。
const closure = join(root, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib')
const haveClosure =
  existsSync(closure) || run([join('scripts', 'setup-dsh-deps.mjs')], { tolerate: true })
const typed =
  haveClosure && run([join('node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.dts.json'], { tolerate: true })
if (!typed) {
  console.warn('warn 未生成 lib/types（缺宿主类型闭包或 tsc 失败）——运行时不需要它，package.json 的 types 会指向不存在的文件')
}

// 3) 硬指标自检：入口产物必须在。缺失就让安装失败，而不是留一个"声明了却装不起来"的插件
//    在 profile 里（那会让市场判 broken、下次启动组装不出这个组合包）。
if (!existsSync(join(root, 'lib', 'index.js'))) {
  console.error('prepare 失败：没有产出 package.json 声明的入口 ./lib/index.js')
  process.exit(1)
}
console.log('prepare done')
