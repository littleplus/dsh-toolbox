/**
 * 面板服务：Web 面板（左侧栏那一页）与宿主之间唯一的通道。
 *
 * 四个方法：
 * - `state()`      — 快照：分组、正则命中情况、运行时诊断、能否写回配置；
 * - `saveGroup()`  — 新增或改写一组（按 `previousId` 定位旧行，没有就追加）；
 * - `deleteGroup()`— 删掉一组；
 * - `preview()`    — 只算正则命中，不落盘（面板边输入边看效果）。
 *
 * 写入一律走宿主的 `configEditor.edit(entry, change)`：它负责加锁、保留 YAML 注释、
 * 原子写文件，然后触发 Loader 热协调（本插件随之重启）。我们自己绝不重写 YAML。
 *
 * 传输用宿主自带的 Typert Remote：这里手写 wire 描述符（等同生成物）。**入参必须是
 * strict codec**（客户端 `$mount` 只认这个），result 用 `src-json` 透传即可。
 */

import { STATUSES, matchNames, claimNames, groupList, normalizeGroups } from './config.js'
import { strictCodec } from './codec.js'

/** 插件行的 id，同时也是 profile 里覆盖行要用的 id。 */
export const ROW_ID = 'toolbox'

/** Remote 命名空间（客户端 `ctx.get('remote.<namespace>')`）。 */
export const NAMESPACE = 'toolbox'

/** 包名，用于 wire 描述符的 id 前缀。 */
const PACKAGE = 'dsh-toolbox'

/**
 * 结果用宽松 codec：`src-json` 表示"就是合法 JSON"，客户端原样透传、宿主不校验。
 * 入参不能用它——客户端的 `requireStrictCodec` 只接受 strict。
 */
const SRC_JSON = { mode: 'src-json' }

/** 入参 codec 的类型符号（宿主与浏览器两侧必须一致）。 */
export const SYMBOLS = {
  saveGroup: `${PACKAGE}#SaveGroupPayload`,
  deleteGroup: `${PACKAGE}#DeleteGroupPayload`,
  moveGroup: `${PACKAGE}#MoveGroupPayload`,
  preview: `${PACKAGE}#PreviewPayload`,
}

/** 服务缺失时的统一错误文本。 */
function unavailable(what) {
  return new Error(`${what} 不可用：当前 profile 没有加载这个服务`)
}

/** 读一个字段：可选字段缺省即空串，必填字段缺省直接报错。 */
function readText(value, field, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new TypeError(`缺少 ${field}`)
    return ''
  }
  if (typeof value !== 'string') throw new TypeError(`${field} 必须是字符串`)
  return value
}

const saveGroupPayload = strictCodec(SYMBOLS.saveGroup, (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('saveGroup 需要一个对象 { id, tools_regex, description, status, previousId? }')
  }
  return {
    id: readText(value.id, 'id', { required: true }),
    tools_regex: readText(value.tools_regex, 'tools_regex', { required: true }),
    description: readText(value.description, 'description'),
    status: readText(value.status, 'status'),
    previousId: readText(value.previousId, 'previousId'),
  }
})

const deleteGroupPayload = strictCodec(SYMBOLS.deleteGroup, (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('deleteGroup 需要一个对象 { id }')
  }
  return { id: readText(value.id, 'id', { required: true }) }
})

const previewPayload = strictCodec(SYMBOLS.preview, (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('preview 需要一个对象 { tools_regex, id?, previousId? }')
  }
  return {
    tools_regex: readText(value.tools_regex, 'tools_regex', { required: true }),
    id: readText(value.id, 'id'),
    previousId: readText(value.previousId, 'previousId'),
  }
})

const moveGroupPayload = strictCodec(SYMBOLS.moveGroup, (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('moveGroup 需要一个对象 { id, direction }')
  }
  return {
    id: readText(value.id, 'id', { required: true }),
    direction: readText(value.direction, 'direction', { required: true }),
  }
})

/**
 * 当前全局（无作用域）工具名——面板用它展示"这组现在会命中什么"。
 * 限制是 per-scope 的，不会影响这个视角。
 */
function globalToolNames(ctx) {
  try {
    const tools = ctx.get('tools')
    if (tools === undefined) return []
    return tools.schemas().map((schema) => schema.name)
  } catch {
    return []
  }
}

/** 在 configEditor 的条目里找本插件那一行。 */
function findEntry(editor) {
  try {
    const entries = editor.entries()
    if (!Array.isArray(entries)) return undefined
    return entries.find((entry) => entry?.options?.id === ROW_ID)
  } catch {
    return undefined
  }
}

/** 没建立可编辑行时直接给用户抄的配置片段。 */
function exampleSnippet() {
  return [
    `- id: ${ROW_ID}`,
    '  config:',
    '    - id: web',
    "      tools_regex: '^web_'",
    '      description: Web search and page fetch tools.',
    '      status: request',
  ].join('\n')
}

/**
 * 读当前行里的分组数组，并记住写回时要保持的外层形态。
 * @returns {{ rows: Array<unknown>, wrap: (next: Array<unknown>) => unknown }}
 */
function readRows(base) {
  const list = groupList(base)
  if (list !== undefined) {
    return { rows: [...list], wrap: (next) => (Array.isArray(base) ? next : { ...base, groups: next }) }
  }
  // 还没有任何配置（继承层是 {}）：第一次写入直接写数组。
  return { rows: [], wrap: (next) => next }
}

/** 一组在文件里的最小形状（只写这四个字段）。 */
function nextRow(group) {
  return {
    id: group.id,
    tools_regex: group.source,
    description: group.description,
    status: group.status,
  }
}

/**
 * 建面板快照。
 * @param {object} ctx 插件上下文。
 * @param {{ groups: Array<object>, errors: Array<object>, controller?: object, entry?: object }} input
 */
export function snapshot(ctx, input) {
  const names = globalToolNames(ctx)
  const notes = input.controller?.notes?.() ?? new Map()
  // 认领表就是运行时用的那份逻辑：面板显示的命中必须和模型实际看到的一致。
  const claims = claimNames(input.groups, names)
  /** 工具名 → 认领它的分组 id。 */
  const owner = new Map()
  for (const group of input.groups) {
    for (const name of claims.get(group.id) ?? []) owner.set(name, group.id)
  }
  /** 分组 id → 分组（避免在 O(工具数) 的循环里反复 find）。 */
  const byId = new Map(input.groups.map((group) => [group.id, group]))
  /**
   * 每个工具当前**实际**的状态，是"经过本插件处理之后"的样子：
   * - active：会出现在模型上下文里（没被任何组认领，或被 open 组认领）；
   * - hidden：被 close 组认领，永远不进上下文；
   * - ondemand：被 request 组认领，本会话展开前不进上下文。
   * 这是全局视角（展开状态是按会话的），所以 ondemand 的含义是"新会话默认隐藏"。
   */
  const tools = names
    .map((name) => {
      const groupId = owner.get(name) ?? null
      const group = groupId === null ? null : byId.get(groupId) ?? null
      const state =
        group === null || group.status === 'open' ? 'active' : group.status === 'close' ? 'hidden' : 'ondemand'
      return { name, state, group: groupId }
    })
    // 稳定排序：面板是"扫一眼"的视图，注册表的顺序（后连进来的 MCP 会追加）不适合直接看。
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  const groups = input.groups.map((group) => {
    const owned = claims.get(group.id) ?? []
    const raw = matchNames(group, names)
    return {
      id: group.id,
      status: group.status,
      description: group.description,
      regex: group.source,
      // request 组的工具名就是 id；close/open 组没有入口工具。
      tool: group.status === 'request' ? group.id : null,
      matched: owned,
      // 正则能匹配、但已被上面更靠前的分组认领走的数量——讲清楚"为什么命中这么少"。
      shadowed: raw.length - owned.length,
      note: notes.get(group.id) ?? null,
    }
  })

  // 去重统计：同一工具只可能被一个组认领，这里仍用 Set 以防将来语义再变。
  const hidden = new Set()
  const onDemand = new Set()
  for (const group of groups) {
    const bucket = group.status === 'close' ? hidden : group.status === 'request' ? onDemand : undefined
    if (bucket === undefined) continue
    for (const name of group.matched) bucket.add(name)
  }

  let patchPath = null
  try {
    const editor = ctx.get('configEditor')
    patchPath = editor?.documentPath ?? null
  } catch {
    patchPath = null
  }

  return {
    groups,
    tools,
    errors: input.errors,
    warnings: input.controller?.warnings ?? [],
    toolTotal: names.length,
    hidden: hidden.size,
    onDemand: onDemand.size,
    agents: input.controller?.activeCount ?? 0,
    editable: input.entry !== undefined,
    rowId: ROW_ID,
    patchPath,
    snippet: exampleSnippet(),
  }
}

/**
 * 建面板服务对象。不继承宿主 Service：只要把对象 `provide` 到命名空间上，并带上
 * `typertRemote` 绑定，Gateway 就能按 `{service, namespace}` 找到它。
 * @param {object} ctx 插件上下文。
 * @param {() => { groups: Array<object>, errors: Array<object>, controller?: object }} resolve 读取当前插件状态。
 */
export function createPanelService(ctx, resolve) {
  /**
   * 用 configEditor 改写分组数组。
   * @param {(rows: Array<any>) => Array<any>} change 基于当前行算出下一份数组。
   */
  const writeRows = async (change) => {
    const editor = ctx.get('configEditor')
    if (editor === undefined) throw unavailable('configEditor')
    const entry = findEntry(editor)
    if (entry === undefined) {
      throw new Error('没有找到可编辑的插件行：profile 的 cordis.patch.yml 里需要有一行 `- id: toolbox`（bundle 会插入它，重启一次即可恢复）')
    }
    await editor.edit(entry, (current, inherited) => {
      const { rows, wrap } = readRows(current ?? inherited)
      return wrap(change(rows))
    })
  }

  const service = {
    /** 读快照。 */
    state() {
      const state = resolve()
      return snapshot(ctx, { ...state, entry: findEntry(ctx.get('configEditor')) })
    },

    /**
     * 新增或改写一组。`previousId` 用来定位旧行（改 id 时它和 `id` 不同）。
     * @param {{ id: string, tools_regex: string, description: string, status: string, previousId: string }} payload
     */
    async saveGroup(payload) {
      const status = payload.status === '' ? 'open' : payload.status
      if (!STATUSES.includes(status)) {
        throw new Error(`未知状态 ${JSON.stringify(payload.status)}（可选 open / close / request）`)
      }

      // 用与手写配置完全相同的规则校验：面板不能存进手写配置不允许的东西。
      const { groups, errors } = normalizeGroups([
        { id: payload.id, tools_regex: payload.tools_regex, description: payload.description, status },
      ])
      if (groups.length === 0) throw new Error(errors[0]?.message ?? '分组配置不合法')
      const normalized = groups[0]
      // `previousId === ''` 表示新增；否则是修改（previousId 是旧 id，改 id 时与 id 不同）。
      const isAdd = payload.previousId === ''
      const key = payload.previousId

      await writeRows((rows) => {
        const sameId = (row) => row !== null && typeof row === 'object' && row.id === normalized.id

        if (isAdd) {
          if (rows.some(sameId)) throw new Error(`已经有 id 为 ${JSON.stringify(normalized.id)} 的分组`)
          return [...rows, nextRow(normalized)]
        }

        const index = rows.findIndex((row) => row !== null && typeof row === 'object' && row.id === key)
        if (index < 0) {
          throw new Error(`配置里已经没有 id 为 ${JSON.stringify(key)} 的分组（可能被别处改掉了），请刷新后重试`)
        }
        if (normalized.id !== key && rows.some((row, at) => at !== index && sameId(row))) {
          throw new Error(`已经有 id 为 ${JSON.stringify(normalized.id)} 的分组`)
        }
        // 保留用户手写的其它字段，只覆盖这四个。
        const next = [...rows]
        next[index] = { ...rows[index], ...nextRow(normalized) }
        return next
      })
      return { saved: true }
    },

    /**
     * 删掉一组。
     * @param {{ id: string }} payload
     */
    async deleteGroup(payload) {
      await writeRows((rows) => {
        const next = rows.filter((row) => !(row !== null && typeof row === 'object' && row.id === payload.id))
        if (next.length === rows.length) throw new Error(`配置里没有 id 为 ${JSON.stringify(payload.id)} 的分组`)
        return next
      })
      return { deleted: true }
    },

    /**
     * 上移/下移一组。顺序就是优先级，所以这个操作会改变谁先认领工具。
     * @param {{ id: string, direction: string }} payload
     */
    async moveGroup(payload) {
      const step = payload.direction === 'up' ? -1 : payload.direction === 'down' ? 1 : 0
      if (step === 0) throw new Error('direction 必须是 up 或 down')
      await writeRows((rows) => {
        const index = rows.findIndex((row) => row !== null && typeof row === 'object' && row.id === payload.id)
        if (index < 0) throw new Error(`配置里没有 id 为 ${JSON.stringify(payload.id)} 的分组`)
        const target = index + step
        if (target < 0 || target >= rows.length) return rows
        const next = [...rows]
        const [row] = next.splice(index, 1)
        next.splice(target, 0, row)
        return next
      })
      return { moved: true }
    },

    /**
     * 只算正则命中，不落盘：面板边输入边预览。
     *
     * 因为认领是**有优先级**的，预览必须把候选行放在它真实的位置上模拟：
     * 编辑=替换原位置，新增=末尾。这样看到的就是保存后它真正会拿到的工具。
     * @param {{ tools_regex: string, id: string, previousId: string }} payload
     */
    preview(payload) {
      const source = payload.tools_regex.trim()
      if (source === '') return { matches: [], shadowed: 0, error: null }
      let regex
      try {
        regex = new RegExp(source)
      } catch (error) {
        return { matches: [], shadowed: 0, error: `正则无法编译：${error instanceof Error ? error.message : String(error)}` }
      }

      const state = resolve()
      const list = [...state.groups]
      const key = payload.previousId === '' ? '' : payload.previousId
      // 还没填 id 时用哨兵 id，避免和真实分组撞名。
      const candidateId = payload.id.trim() === '' ? '\u0000candidate' : payload.id.trim()
      const candidate = { id: candidateId, source, regex, description: '', status: 'open', index: -1 }
      const at = key === '' ? -1 : list.findIndex((group) => group.id === key)
      if (at >= 0) list[at] = candidate
      else list.push(candidate)

      const names = globalToolNames(ctx)
      const owned = claimNames(list, names).get(candidateId) ?? []
      return { matches: owned, shadowed: matchNames(candidate, names).length - owned.length, error: null }
    },
  }

  // Gateway 校验：typertRemote.service 必须就是被 provide 的那个对象本身。
  service.typertRemote = Object.freeze({ service, serviceKey: NAMESPACE, namespace: NAMESPACE })
  return service
}

/** 注册给 `ctx.typert` 的 wire 描述符（等同生成物，手写）。 */
export const MANIFEST = {
  package: PACKAGE,
  face: 'host',
  schemas: [],
  invocations: [
    {
      id: `${PACKAGE}#${NAMESPACE}/state`,
      service: NAMESPACE,
      namespace: NAMESPACE,
      method: 'state',
      invocation: { kind: 'direct' },
      parameters: [],
      result: SRC_JSON,
    },
    {
      id: `${PACKAGE}#${NAMESPACE}/saveGroup`,
      service: NAMESPACE,
      namespace: NAMESPACE,
      method: 'saveGroup',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'payload', wire: 'payload', source: 'json', codec: saveGroupPayload }],
      result: SRC_JSON,
    },
    {
      id: `${PACKAGE}#${NAMESPACE}/deleteGroup`,
      service: NAMESPACE,
      namespace: NAMESPACE,
      method: 'deleteGroup',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'payload', wire: 'payload', source: 'json', codec: deleteGroupPayload }],
      result: SRC_JSON,
    },
    {
      id: `${PACKAGE}#${NAMESPACE}/moveGroup`,
      service: NAMESPACE,
      namespace: NAMESPACE,
      method: 'moveGroup',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'payload', wire: 'payload', source: 'json', codec: moveGroupPayload }],
      result: SRC_JSON,
    },
    {
      id: `${PACKAGE}#${NAMESPACE}/preview`,
      service: NAMESPACE,
      namespace: NAMESPACE,
      method: 'preview',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'payload', wire: 'payload', source: 'json', codec: previewPayload }],
      result: SRC_JSON,
    },
  ],
  model: { services: [], events: [], objects: [] },
}
