/**
 * 工具返回值必须"JSON 无损"。
 *
 * 这是被端到端测试抓到的真实故障：宿主校验器先对整棵值做 `isJsonValue`，
 * **遇到任何 `undefined` 属性整体判失败**，报
 * `invalid output "value is not lossless JSON"`——注意它连字段名都不给，
 * 现场很难猜。
 *
 * 关键陷阱：`{ ...(x ? { y } : {}), ...(z ? { w: undefined } : {}) }` 这种写法
 * **不能**省掉键——展开一个值为 `undefined` 的对象，属性照样存在。所以必须在
 * 返回边界统一裁剪，而不是指望每个 `...` 都写对。
 */

/** 递归去掉 `undefined` 的对象属性；数组里的 `undefined` 位置丢不掉，故直接断言。 */
export function pruneUndefined<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => pruneUndefined(item)) as unknown as T
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item === undefined) continue
      out[key] = pruneUndefined(item)
    }
    return out as T
  }
  return value
}

/**
 * 校验一个值确实 JSON 无损；不通过时抛出**带路径**的错误。
 *
 * 宿主只报"value is not lossless JSON"，没有路径，定位成本极高。开发期用它
 * 在本地先一步指出是哪个字段（`npm test` 与 selftest 都会覆盖）。
 */
export function assertJsonSafe(value: unknown, path = '$'): void {
  if (value === null) return
  const type = typeof value
  if (type === 'string' || type === 'boolean') return
  if (type === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new Error(`not JSON-safe at ${path}: non-finite number ${String(value)}`)
    }
    if (Object.is(value, -0)) throw new Error(`not JSON-safe at ${path}: negative zero`)
    return
  }
  if (type === 'undefined') throw new Error(`not JSON-safe at ${path}: undefined`)
  if (type !== 'object') throw new Error(`not JSON-safe at ${path}: ${type}`)

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (!Object.hasOwn(value, i)) throw new Error(`not JSON-safe at ${path}: sparse array hole at ${i}`)
      assertJsonSafe(value[i], `${path}[${i}]`)
    }
    return
  }

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    assertJsonSafe(item, `${path}.${key}`)
  }
}
