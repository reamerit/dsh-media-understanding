/**
 * 测试用的模块加载器。
 *
 * 为什么加载 `lib/` 而不是 `src/`：纯逻辑模块被 tsdown 单独打包成
 * `lib/pure/*.js`（见 tsdown.config.ts 的说明），这样测试**不需要** TypeScript
 * 运行时，也不会连带加载 `lib/index.js`（后者 import 了宿主的
 * `@deepseek-ai/*`，仓库侧的 node_modules 里虽有 junction 但没必要拖进来）。
 *
 * `npm test` 前请先 `npm run build`（package.json 的 test 脚本已隐含这一前提）。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const root = dirname(dirname(fileURLToPath(import.meta.url)))

/** 动态 import 一个构建产物；缺失时给出"先 npm run build"的明确提示。 */
export async function loadPure(name) {
  const file = join(root, 'lib', 'pure', `${name}.js`)
  if (!existsSync(file)) {
    throw new Error(`missing build artifact ${file} — run "npm run build" first`)
  }
  return import(pathToFileURL(file).href)
}
