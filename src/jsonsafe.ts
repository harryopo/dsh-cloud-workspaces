/**
 * dsh-remote-ide — 输出边界净化（lossless JSON / JSON-safe）。
 *
 * dsh 的两个边界校验都拒绝 undefined own-values：
 *  - typert 网关 assertJsonValue（报 "business result failed boundary validation"）
 *  - dsh-tools 工具输出校验 isJsonValue（报 "value is not lossless JSON"）
 * 显式赋值的 `error: undefined` 也是 own property，而校验发生在进程内、
 * JSON 序列化之前——JSON.stringify 丢 undefined 救不了。所有跨边界输出
 * （typert 端点返回、工具 execute 返回）必须经此剥离 undefined。
 */

/** 递归剥离 undefined own-values 与数组内 undefined 元素（原样返回原值类型）。 */
export function jsonSafe<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(item => jsonSafe(item)).filter(item => item !== undefined) as unknown as T
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (item !== undefined) out[key] = jsonSafe(item)
    }
    return out as T
  }
  return value
}
