import { defineConfig } from 'tsdown'

/**
 * Node 半区铁律（照抄本机在产宿主侧插件 dsh-mcp-skill-panel 的教训）：
 * external 必须覆盖全部 `@deepseek-ai/*` 与 `node:*`。
 *
 * 为什么不能内联：把 `@deepseek-ai/dsh-tools` 之类打进 bundle 会得到**第二份模块副本**，
 * 其中的 `TOOL_RUNTIME_SCHEDULER` Symbol 与宿主的不是同一个 → 工具调度崩溃。
 * 运行时靠宿主对 peerDependencies 的模块解析拦截（`dsh-app-boot` 的 `routeLinked()`）
 * 解析到宿主自己那一份实现。
 *
 * 输出命名：tsdown 的 entryFileNames 默认 `[name].js`；多入口时若 basename 相同会互相覆盖，
 * 因此每个入口都显式命名。
 *
 * dts: false —— 类型声明走 `tsc -p tsconfig.dts.json` 生成到 `lib/types/`，
 * 不用 tsdown 自带的 dts 管线（它会把声明以 `.ts` 落到 `lib/`，与 tsc 产物重复）。
 *
 * `src/pure/*` 是被单独打包的**纯逻辑**入口：它们不 import 任何 `@deepseek-ai/*`，
 * 因此 `scripts/selftest-*.mjs` 可以脱离宿主直接跑（index.js 会连带加载宿主包，
 * 而仓库侧 node_modules 里没有那些依赖）。
 */
const external = [/^@deepseek-ai\//, /^node:/]

const nodeEntry = (entry, fileName, clean = false) => ({
  entry: [entry],
  format: ['esm'],
  outDir: 'lib',
  target: 'node22',
  platform: 'node',
  external,
  dts: false,
  clean,
  sourcemap: false,
  outputOptions: { entryFileNames: fileName },
})

export default defineConfig([
  nodeEntry('src/index.ts', 'index.js', true),
  nodeEntry('src/pure/resolve-input.ts', 'pure/resolve-input.js'),
  nodeEntry('src/pure/timestamps.ts', 'pure/timestamps.js'),
  nodeEntry('src/pure/device.ts', 'pure/device.js'),
  nodeEntry('src/pure/errors.ts', 'pure/errors.js'),
  nodeEntry('src/pure/json.ts', 'pure/json.js'),
  nodeEntry('src/pure/render.ts', 'pure/render.js'),
])
