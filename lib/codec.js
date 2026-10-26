/**
 * Typert strict codec 的最小实现。
 *
 * 为什么需要它：客户端在 `$mount` 时会对**每个入参**做 `requireStrictCodec`，
 * 只接受 `mode === 'strict'`（`src-json` 只对 result 有效）。所以哪怕面板只是
 * 传一个 `{id, status}`，也得给一个 strict codec。
 *
 * 为什么不引 zod：宿主侧的边界解码就是 `codec.create().parse(value)`
 * （`dsh-api-gateway` 的 decode），它只要求返回对象上有 `parse`。所以这里自己
 * 写一个够用的校验函数即可，插件继续保持零依赖。
 *
 * 契约要点：
 * - `mode` 必须是 `'strict'`，`typeSymbol` 非空；
 * - `create()` 必须可重复调用（宿主用 `??=` 缓存，这里自己也缓存一份）；
 * - `parse()` 抛错 ⇒ 宿主报 `gateway/input-invalid`，不会把坏数据送进业务方法。
 *
 * @param {string} typeSymbol 类型符号（两侧描述符必须一致，便于诊断）。
 * @param {(value: unknown) => unknown} parse 校验并返回规范化后的值。
 */
export function strictCodec(typeSymbol, parse) {
  let cached
  return {
    mode: 'strict',
    typeSymbol,
    create() {
      cached ??= { parse }
      return cached
    },
  }
}
