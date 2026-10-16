/**
 * JSON 无损性测试。
 *
 * 这组测试来自一个**端到端才暴露的线上故障**：`media_probe` 返回的对象里带了
 * `undefined` 属性，宿主的输出校验器直接判
 * `invalid output "value is not lossless JSON"`，而且不报字段名。
 * 关键陷阱是 `{ ...(cond ? { y } : {}), ...(cond2 ? { z: undefined } : {}) }`
 * **不会**省掉 `z` 这个键——展开一个值为 undefined 的对象，属性照样存在。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { loadPure } from './helpers.mjs'

const { pruneUndefined, assertJsonSafe } = await loadPure('json')

test('展开 undefined 值确实会留下键（这正是不裁剪就失败的原因）', () => {
  const spread = { a: 1, ...(true ? { b: undefined } : {}) }
  assert.deepEqual(Object.keys(spread), ['a', 'b'])
  assert.throws(() => assertJsonSafe(spread), /not JSON-safe at \$\.b: undefined/)
})

test('pruneUndefined 去掉对象里的 undefined 属性', () => {
  const pruned = pruneUndefined({ a: 1, b: undefined, c: null, d: 'x' })
  assert.deepEqual(Object.keys(pruned), ['a', 'c', 'd'])
  assert.equal(pruned.c, null)
})

test('pruneUndefined 递归处理嵌套对象与数组', () => {
  const pruned = pruneUndefined({
    outer: { keep: 1, drop: undefined },
    list: [{ keep: true, drop: undefined }],
  })
  assert.deepEqual(pruned, { outer: { keep: 1 }, list: [{ keep: true }] })
  assertJsonSafe(pruned)
})

test('pruneUndefined 不改变 JSON 安全的值（幂等）', () => {
  const value = { a: 1, b: [1, 2, { c: null }], d: false, e: '' }
  assert.deepEqual(pruneUndefined(value), value)
  assert.deepEqual(pruneUndefined(pruneUndefined(value)), value)
})

test('assertJsonSafe 接受合法的 JSON 值', () => {
  assertJsonSafe({ a: 1, b: [1, 'x', null, true], c: { d: 1.5 } })
})

test('assertJsonSafe 拒绝非有限数、-0、undefined 与稀疏数组，且报出路径', () => {
  assert.throws(() => assertJsonSafe({ a: Number.NaN }), /\$\.a: non-finite/)
  assert.throws(() => assertJsonSafe({ a: Infinity }), /\$\.a: non-finite/)
  assert.throws(() => assertJsonSafe({ a: -0 }), /\$\.a: negative zero/)
  assert.throws(() => assertJsonSafe({ a: { b: undefined } }), /\$\.a\.b: undefined/)
  assert.throws(() => assertJsonSafe({ a: [1, , 3] }), /sparse array hole/)
})

test('assertJsonSafe 的路径能定位到数组元素', () => {
  assert.throws(() => assertJsonSafe({ frames: [{ t: 1 }, { t: undefined }] }), /\$\.frames\[1\]\.t/)
})
