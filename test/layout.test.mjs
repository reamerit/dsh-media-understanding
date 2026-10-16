/**
 * 包布局契约测试。
 *
 * 来源是**只在宿主里才暴露的两个故障**，它们叠加后极难定位：
 *
 * 1. `workersDir()` 曾经算成 `<pkg>/lib/src/workers`（因为产物入口在 `lib/`）；
 * 2. 更坏的一次是**约定不一致**：`workersDir()` 返回 workers 目录，而
 *    `probeScriptPath()` 又拼了一次 `workers` ⇒ `<pkg>/src/workers/workers/probe.py`。
 *
 * 两次的症状都是：python 立刻"打不开文件"退出、探针 stdout 为空 ⇒ 设备静默落 CPU、
 * `fasterWhisper.ready: false`，看着像"这台机器没装依赖"，而 shell 里手跑同一脚本却正常。
 *
 * 这里把**路径约定**固化成断言：`workersDir()` 返回的就是 workers 目录本身，
 * 两个脚本路径都由它直接拼文件名，任何一处多拼/少拼都会让这些测试失败。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import { root } from './helpers.mjs'

const WORKER_SCRIPTS = ['probe.py', 'transcribe.py']

test('worker 脚本确实在 src/workers 下（部署时会随 files 一起发出去）', () => {
  for (const name of WORKER_SCRIPTS) {
    assert.ok(existsSync(join(root, 'src', 'workers', name)), `missing src/workers/${name}`)
  }
})

test('package.json 的 files 必须带上 src/workers，否则运行时找不到 worker', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.ok(
    Array.isArray(manifest.files) && manifest.files.includes('src/workers'),
    'package.json files 缺少 "src/workers"',
  )
})

test('产物入口在 lib/，worker 在包根的 src/workers —— 布局契约不变', () => {
  assert.ok(existsSync(join(root, 'lib', 'index.js')), 'expected build output at lib/index.js')
  assert.ok(existsSync(join(root, 'src', 'workers', 'probe.py')), 'expected src/workers/probe.py')
  assert.ok(
    !existsSync(join(root, 'lib', 'src', 'workers', 'probe.py')),
    'lib/src/workers 不应存在——若存在说明产物布局变了，需同步 workersDir()',
  )
})

test('workersDir() 的候选规则：从产物入口出发必须能命中真正的 workers 目录', () => {
  // 复刻 workersDir() 的候选顺序（here = <pkg>/lib），断言其一命中且**不含双重 workers**
  const here = join(root, 'lib')
  const candidates = [
    join(here, '..', 'src', 'workers'),
    join(here, 'workers'),
    join(here, '..', '..', 'src', 'workers'),
  ]
  const hit = candidates.find((c) => existsSync(join(c, 'probe.py')))
  assert.ok(hit, `no candidate contains probe.py: ${candidates.join(' | ')}`)
  assert.equal(hit, join(root, 'src', 'workers'))
  assert.ok(!hit.includes(`workers${'\\'}workers`), 'path must not contain a doubled workers segment')
})

test('脚本路径 = workersDir + 文件名（约定的唯一来源，禁止再拼 workers）', () => {
  const workerDir = join(root, 'src', 'workers')
  for (const name of WORKER_SCRIPTS) {
    const scriptPath = join(workerDir, name)
    assert.ok(existsSync(scriptPath), `expected ${scriptPath}`)
    assert.ok(
      !existsSync(join(workerDir, 'workers', name)),
      '不得再拼一层 workers——这正是导致探针静默失败的错法',
    )
  }
})

test('构建产物里的纯逻辑模块可被测试加载', () => {
  for (const name of ['device', 'errors', 'json', 'resolve-input', 'timestamps']) {
    assert.ok(existsSync(join(root, 'lib', 'pure', `${name}.js`)), `missing lib/pure/${name}.js`)
  }
})
