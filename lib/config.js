/**
 * 配置归一化。
 *
 * `cordis.patch.yml` 里这一行插件的 `config` 就是分组数组（也接受 `{ groups: [...] }`），
 * 每个元素是 `{ id, tools_regex, description, status }`。这里把它翻译成插件内部用的不可变
 * 描述，并把所有能提前发现的问题收进 `errors`（面板会原样显示），而不是抛错挡住插件加载。
 *
 * 设计约束（有意为之）：
 * - 归一化后只有 `status !== 'open'` 的分组会进入运行时，open 的组完全不参与匹配；
 * - `id` 同时是 request 模式下的**工具名**，所以必须是合法的工具名；
 * - 正则只接受字符串，用 `new RegExp(source)` 编译（`search` 语义，不做整串锚定）。
 */

/** 支持的分组状态。 */
export const STATUSES = ['open', 'close', 'request']

/** 分组 id 同时是工具名：沿用宿主工具名的保守字符集，避免出现不可调用的名字。 */
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/

/** 宿主为 PTC 演示传输保留的工具名，任何注册都会被拒。 */
const RESERVED_TOOL_NAMES = new Set(['run_code'])

/**
 * 取出 config 里的分组数组。两种写法都认：
 * - 根数组：`config: [ {...}, {...} ]`（推荐，最短）；
 * - 包一层：`config: { groups: [ {...} ] }`（以后要加顶层字段时用）。
 * @param {unknown} raw 插件行上的 config 原值。
 * @returns {Array<unknown>|undefined} 不是这两种形态时返回 undefined。
 */
export function groupList(raw) {
  if (Array.isArray(raw)) return raw
  if (raw !== null && typeof raw === 'object' && Array.isArray(raw.groups)) return raw.groups
  return undefined
}

/**
 * 把原始 config 归一化成分组列表。
 * @param {unknown} raw 插件行上的 config 原值。
 * @returns {{ groups: Array<object>, errors: Array<{ where: string, message: string }> }}
 */
export function normalizeGroups(raw) {
  /** @type {Array<{ where: string, message: string }>} */
  const errors = []
  /** @type {Array<object>} */
  const groups = []

  if (raw === undefined || raw === null) return { groups, errors }

  const list = groupList(raw)
  if (list === undefined) {
    // 允许对象形态的空配置（Cordis 对无 Config 的插件可能传 {}），其余一律报错。
    if (typeof raw === 'object' && Object.keys(raw).length === 0) return { groups, errors }
    errors.push({
      where: 'config',
      message: 'config 必须是分组数组（[{ id, tools_regex, description, status }]）或 { groups: [...] }',
    })
    return { groups, errors }
  }

  const seen = new Set()
  list.forEach((row, index) => {
    const where = `[${index}]`
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      errors.push({ where, message: '每个元素必须是一个 map' })
      return
    }

    const id = typeof row.id === 'string' ? row.id.trim() : ''
    if (!ID_PATTERN.test(id)) {
      errors.push({ where, message: `id ${JSON.stringify(row.id)} 不是合法工具名（需匹配 ${ID_PATTERN}）` })
      return
    }
    if (RESERVED_TOOL_NAMES.has(id)) {
      errors.push({ where: `${where}.id`, message: `id ${JSON.stringify(id)} 是宿主保留的工具名` })
      return
    }
    if (seen.has(id)) {
      errors.push({ where: `${where}.id`, message: `id ${JSON.stringify(id)} 重复，只保留第一个` })
      return
    }

    const status = row.status === undefined || row.status === null ? 'open' : String(row.status)
    if (!STATUSES.includes(status)) {
      errors.push({ where: `${where}.status`, message: `未知状态 ${JSON.stringify(row.status)}（可选 open / close / request）` })
      return
    }

    const source = typeof row.tools_regex === 'string' ? row.tools_regex.trim() : ''
    if (source === '') {
      errors.push({ where: `${where}.tools_regex`, message: 'tools_regex 必填（字符串形式的正则，按 search 语义匹配工具名）' })
      return
    }
    let regex
    try {
      regex = new RegExp(source)
    } catch (error) {
      errors.push({ where: `${where}.tools_regex`, message: `正则无法编译：${error instanceof Error ? error.message : String(error)}` })
      return
    }

    const description = typeof row.description === 'string' ? row.description.trim() : ''
    if (status === 'request' && description === '') {
      // request 模式下 description 就是这个入口工具给模型看的唯一说明，不能为空。
      errors.push({ where: `${where}.description`, message: 'status 为 request 时必须写 description（它就是入口工具的描述）' })
      return
    }

    seen.add(id)
    groups.push({ id, source, regex, description, status, index })
  })

  return { groups, errors }
}

/**
 * 一组里当前存在的工具名（不考虑优先级，只看正则本身能覆盖到什么）。
 * @param {{ regex: RegExp }} group 已归一化的分组。
 * @param {Iterable<string>} names 当前全局工具名。
 * @returns {string[]}
 */
export function matchNames(group, names) {
  const matched = []
  for (const name of names) {
    // 每次都重置 lastIndex：配置里的正则不带标志位，但这里仍防御性地写成无状态调用。
    group.regex.lastIndex = 0
    if (group.regex.test(name)) matched.push(name)
  }
  return matched.sort()
}

/**
 * 按**从上到下**的优先级认领工具名：一个工具只属于第一个匹配它的分组，之后的分组再也看不到它。
 *
 * 这个顺序语义是刻意的：
 * - `open` 组也会认领——放在前面就能"保护"一组工具不被后面的 `close` 吃掉；
 * - 交叉的正则（例如 `^mcp__openviking__read` 在前、`^mcp__openviking__` 在后）靠顺序裁决，
 *   而不是靠状态强弱；
 * - 认领表就是运行时唯一的真源：隐藏判定、入口工具列出的名字、面板显示的命中，全部从这里来。
 *
 * @param {Iterable<object>} groups 已归一化的分组，**顺序即优先级**（必须包含 open 组）。
 * @param {Iterable<string>} names 当前全局工具名。
 * @returns {Map<string, string[]>} 分组 id → 它认领到的工具名（已排序）。
 */
export function claimNames(groups, names) {
  const list = [...names]
  /** 已经被前面分组认领的名字。 */
  const claimed = new Set()
  /** @type {Map<string, string[]>} */
  const table = new Map()
  for (const group of groups) {
    // 每轮都基于"还没被前面认领的"重新算，所以后置分组只能捡剩下的。
    const free = list.filter((name) => !claimed.has(name))
    const mine = matchNames(group, free)
    for (const name of mine) claimed.add(name)
    table.set(group.id, mine)
  }
  return table
}
