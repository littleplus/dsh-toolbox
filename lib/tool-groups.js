/**
 * 工具分组控制器。
 *
 * 真源约定（宿主机制决定，不是实现口味）：
 * 1. `ctx.tools.restrict({ deny })` 只能从 **scoped ctx**（agent 作用域）调用，全局 ctx 会被
 *    宿主拒绝（"would mask every agent"）；限制在 dispose 时解除。
 * 2. 被限制的全局工具会从该 agent 的 schema 里消失——这才是"不注入上下文"；
 *    `tools.guard()` 只能拒绝调用，省不下上下文。
 * 3. `restrict()` 要求名字在施加时**已经存在**于可限制集合里，否则直接抛错；MCP 之类
 *    后连上来的工具必须靠 `tools/change` 再补一轮。
 * 4. `restrict()` / `undo()` 会**同步**emit `tools/change`，所以监听者必须有重入守卫 +
 *    集合签名去重，否则就是无限递归（宿主里真实踩过的坑）。
 *
 * 因此"按 agent 施加"是唯一可行路径：每个 agent 挂一个微型插件（声明 inject: ['tools']），
 * 由它在自己的作用域里注册限制与入口工具；agent 销毁时这些 effect 随之解绑。
 *
 * 三种状态：
 * - open    完全不参与匹配，不注册任何东西；
 * - close   匹配到的工具在该 agent 里整体隐藏（deny）；
 * - request 匹配到的工具先隐藏，另外注册一个与分组同名的入口工具（描述 = 分组的
 *           description）。模型调用它 ⇒ 解除本组 deny ⇒ 下一 step 的工具列表里出现这组
 *           工具。这个"已展开"状态记在内存里，并在 agent 重建（resume/fork）时从
 *           session 日志的 tool/call 事件重放出来。
 */

import { claimNames } from './config.js'

/** 每个 agent 作用域里那个微型插件的名字，只用于诊断。 */
const AGENT_PLUGIN_NAME = 'toolbox:agent'

/** 入口工具的固定文本（模型侧）：只描述发生了什么，不含策略。 */
function gatewayResultText(groupId, tools) {
  if (tools.length === 0) return `Group "${groupId}" currently matches no tool.`
  return `Group "${groupId}" is now available (${tools.length} tools): ${tools.join(', ')}.`
}

/**
 * 从 session 日志里还原"哪些 request 组已经展开过"。
 *
 * fork/resume 会重建 agent，内存状态丢失；而模型看到过的工具必须能从日志重建
 * （宿主原则：session log 是唯一真源）。判定条件刻意宽松：只要出现过分组同名工具的
 * 调用就算展开过——比"必须成功返回"更简单，也不会因为一次失败重试把工具又收回去。
 * @param {object} agent 宿主 agent 实例。
 * @param {Iterable<object>} groups 需要还原的 request 分组。
 * @returns {Set<string>} 已展开的分组 id。
 */
function readRevealed(agent, groups) {
  const ids = new Set()
  const wanted = new Set()
  for (const group of groups) if (group.status === 'request') wanted.add(group.id)
  if (wanted.size === 0) return ids
  let events = []
  try {
    events = agent?.session?.snapshotEvents?.() ?? []
  } catch {
    // 读不到日志就当"没展开过"：工具先收起来，模型再调一次入口工具即可。
    return ids
  }
  for (const event of events) {
    if (event?.type !== 'tool/call') continue
    const name = event.data?.name
    if (typeof name === 'string' && wanted.has(name)) ids.add(name)
  }
  return ids
}

/**
 * 一个 agent 此刻应该隐藏的工具名（去重 + 排序）。
 *
 * 判定核心，抽成纯函数以便单测：
 * - 先按**配置顺序**认领（`claimNames`）：一个工具只归第一个匹配它的分组，`open` 组也参与认领；
 * - `close` 组隐藏它认领到的；
 * - `request` 组在"本 agent 已展开"之前隐藏它认领到的，展开之后放出来。
 *
 * 注意 `groups` 必须按配置顺序、且**包含 open 组**——open 组虽然不隐藏任何东西，
 * 但它会认领，这正是"把 open 组放在前面就能保住一组工具不被后面 close"的机制。
 * @param {Iterable<object>} groups 已归一化的分组（顺序即优先级，含 open）。
 * @param {Set<string>} revealed 本 agent 已展开的分组 id。
 * @param {Iterable<string>} names 当前全局工具名。
 * @returns {string[]}
 */
export function hiddenNames(groups, revealed, names) {
  return denyFromClaims(groups, revealed, claimNames(groups, names))
}

/**
 * 由认领表推导隐藏集合。运行时手里已经有认领表（入口工具要用同一份），
 * 所以单独拆出来避免重复计算。
 * @param {Iterable<object>} groups 已归一化的分组（顺序即优先级，含 open）。
 * @param {Set<string>} revealed 本 agent 已展开的分组 id。
 * @param {Map<string, string[]>} claims 认领表。
 * @returns {string[]}
 */
export function denyFromClaims(groups, revealed, claims) {
  const deny = new Set()
  for (const group of groups) {
    if (group.status !== 'close' && group.status !== 'request') continue
    if (group.status === 'request' && revealed.has(group.id)) continue
    for (const name of claims.get(group.id) ?? []) deny.add(name)
  }
  return [...deny].sort()
}

/** 一条可直接读的诊断文本。 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 建一个挂在单个 agent 作用域里的微型插件。
 * @param {ToolGroupController} controller 拥有者。
 * @param {object} agent 宿主 agent 实例。
 * @returns {{ plugin: object, holder: { sync: () => void } }}
 */
function createAgentPlugin(controller, agent) {
  // 认领要按完整顺序算（open 组也参与），所以这里存两份：全部分组 + 需要注册入口工具的分组。
  const allGroups = controller.allGroups
  const activeGroups = controller.groups
  const revealed = readRevealed(agent, activeGroups)

  /** 控制器在 `tools/change` 时调这里（插件实例自己**不**订阅该事件，否则会自己触发自己）。 */
  const holder = { sync: () => {} }

  const plugin = {
    name: AGENT_PLUGIN_NAME,
    inject: ['tools'],
    apply(c) {
      /** 当前生效的 deny 限制的 disposer。 */
      let undoRestriction
      /** 上一次真正施加的 deny 集合签名；undefined 表示当前没有施加。 */
      let appliedSignature
      /** 每个分组的入口工具 disposer。 */
      const gateways = new Map()
      /** 本实例内部的重入守卫：restrict()/undo()/register() 都会同步绕回 sync()。 */
      let inside = false
      let live = true
      /** 最近一次认领结果（group id → 名字）；入口工具列名单和隐藏判定共用同一份。 */
      let claims = new Map()

      /** 全局（无作用域）视角下的工具名——限制不会改变这个视角，所以它可以稳定重算。 */
      const globalNames = () => {
        try {
          return c.tools.schemas().map((schema) => schema.name)
        } catch (error) {
          controller.warn(`读取工具列表失败：${errorText(error)}`)
          return []
        }
      }

      /** 三个状态下本 agent 应该隐藏的工具名（复用 sync() 已经算好的认领表）。 */
      const computeDeny = () => denyFromClaims(allGroups, revealed, claims)

      /** request 分组各注册一个同名入口工具；名字被占用时不注册（否则会静默遮蔽真工具）。 */
      const ensureGateways = (names) => {
        const taken = new Set(names)
        for (const group of activeGroups) {
          if (group.status !== 'request' || gateways.has(group.id)) continue
          if (taken.has(group.id)) {
            controller.note(group.id, `工具名 ${group.id} 已被现有工具占用，入口工具未注册`)
            continue
          }
          // 展开是**按 agent** 的：只放开本实例这一份限制，别的 agent 不受影响。
          const onReveal = () => {
            revealed.add(group.id)
            sync()
          }
          // 入口工具只报"本组认领到的"名字：被前面分组抢走的不算它的。
          const ownedHere = () => claims.get(group.id) ?? []
          try {
            gateways.set(group.id, c.tools.register(createGatewayDefinition(group, ownedHere, onReveal)))
          } catch (error) {
            controller.warn(`注册入口工具 ${group.id} 失败：${errorText(error)}`)
          }
        }
      }

      const applyDeny = (deny) => {
        const signature = deny.join('\u0000')
        if (signature === appliedSignature) return
        if (undoRestriction !== undefined) {
          try {
            undoRestriction()
          } catch (error) {
            controller.warn(`撤销上一轮限制失败：${errorText(error)}`)
          }
          undoRestriction = undefined
          appliedSignature = undefined
        }
        if (deny.length === 0) {
          appliedSignature = ''
          return
        }
        try {
          undoRestriction = c.tools.restrict({ deny })
          appliedSignature = signature
        } catch (error) {
          // 名字可能在这一瞬间消失：留给下一次 tools/change 再试。
          controller.warn(`施加工具限制失败：${errorText(error)}`)
        }
      }

      const sync = () => {
        if (!live || inside) return
        inside = true
        try {
          const names = globalNames()
          // 先认领再注册入口工具：入口工具要报出本组真正占有的名字。
          claims = claimNames(allGroups, names)
          ensureGateways(names)
          applyDeny(computeDeny())
        } finally {
          inside = false
        }
      }

      holder.sync = sync

      c.effect(() => () => {
        live = false
        holder.sync = () => {}
      })

      sync()
    },
  }

  return { plugin, holder }
}

/**
 * 一个 request 分组的入口工具定义。
 *
 * 模型看到的只有 `description`（原样取自配置）——这就是"渐进式披露"的第一层；
 * 调用后本组工具才会出现在工具列表里。
 * @param {object} group 归一化后的分组。
 * @param {() => string[]} ownedNames 本组**认领到的**名字（被前面分组抢走的不算它的）。
 * @param {() => void} onReveal 展开本组（绑定到具体 agent 实例）。
 */
function createGatewayDefinition(group, ownedNames, onReveal) {
  return {
    name: group.id,
    // 原样使用配置里的描述：它同时承担"这组是什么"和"调用它会加载什么"两个职责。
    description: group.description,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          group: { type: 'string' },
          tools: { type: 'array', items: { type: 'string' } },
        },
        required: ['group', 'tools'],
      },
      render(_args, value) {
        return [{ type: 'text', text: gatewayResultText(value.group, value.tools) }]
      },
    },
    execute() {
      const tools = [...ownedNames()]
      onReveal()
      return { group: group.id, tools }
    },
  }
}

/**
 * 所有 agent 共用的控制器：负责挂载/卸载、事件订阅、对外快照。
 */
export class ToolGroupController {
  /** @type {object} */
  #ctx
  /** @type {Array<object>} 全部已归一化分组，**顺序即优先级**（含 open）。 */
  #all
  /** @type {Array<object>} 需要施加隐藏/注册入口工具的分组（status !== 'open'）。 */
  #groups
  /** @type {Map<string, { fiber: object, holder: object }>} */
  #mounted = new Map()
  /** @type {Set<string>} 正在挂载中的 agent id（挂载途中会同步 emit tools/change）。 */
  #mounting = new Set()
  /** `tools/change` 的重入守卫。 */
  #syncing = false
  #disposed = false
  /** @type {string[]} 运行时诊断（面板会显示）。 */
  #warnings = []
  /** @type {Map<string, string>} 分组级运行时提示（面板会显示）。 */
  #notes = new Map()

  constructor(ctx, groups) {
    this.#ctx = ctx
    // 顺序即优先级，所以 open 组也要留着：它会认领工具，从而"保护"住它们。
    this.#all = [...groups]
    this.#groups = groups.filter((group) => group.status !== 'open')
  }

  /** 需要注册入口工具 / 施加隐藏的分组（open 已过滤）。 */
  get groups() {
    return this.#groups
  }

  /** 全部配置分组，**顺序即优先级**（含 open）。认领判定要用它。 */
  get allGroups() {
    return this.#all
  }

  /** 当前挂着分组逻辑的 agent 数。 */
  get activeCount() {
    return this.#mounted.size
  }

  get warnings() {
    return [...this.#warnings]
  }

  /** 分组级提示：id → 文本。 */
  notes() {
    return new Map(this.#notes)
  }

  warn(message) {
    const line = `[toolbox] ${message}`
    if (this.#warnings.length < 50) this.#warnings.push(line)
    try {
      const logger = this.#ctx.get('logger')
      if (typeof logger?.warn === 'function') {
        logger.warn(line)
        return
      }
    } catch {
      // logger 缺失就退回 console
    }
    try {
      console.warn(line)
    } catch {
      // 极简宿主：放弃这条日志
    }
  }

  note(groupId, message) {
    this.#notes.set(groupId, message)
  }

  /** 给当前已存在的 agent 全部挂上（插件刚激活时补一轮）。 */
  async mountAll() {
    for (const agent of this.listAgents()) await this.applyTo(agent)
  }

  listAgents() {
    try {
      const agents = this.#ctx.get('agents')
      const rows = agents?.list?.()
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    }
  }

  /**
   * 给一个 agent 施加分组逻辑；已挂过（或正在挂）的跳过。
   *
   * 返回值必须被 await（`agent/created` 监听器直接 return 它）：`ctx.plugin()` 本身的 apply
   * 是异步排队的，不等它，新 agent 的**第一次**请求装配就可能抢在限制生效之前，把整组工具
   * 的 schema 注入进去——那就等于没隐藏。
   * @returns {Promise<void>|undefined}
   */
  applyTo(agent) {
    if (this.#disposed || this.#groups.length === 0) return undefined
    const id = typeof agent?.id === 'string' ? agent.id : undefined
    if (id === undefined || this.#mounted.has(id) || this.#mounting.has(id)) return undefined
    const scope = agent.ctx
    if (scope === undefined || typeof scope.plugin !== 'function') return undefined
    this.#mounting.add(id)
    try {
      const { plugin, holder } = createAgentPlugin(this, agent)
      // `ctx.plugin()` 返回的 fiber 是 thenable：await 到 apply 真正跑完（而不是被 dispose）为止。
      const fiber = scope.plugin(plugin)
      this.#mounted.set(id, { fiber, holder })
      return Promise.resolve(fiber)
        .then(() => undefined)
        .catch((error) => {
          // 挂载失败不能让 agent 创建失败：记一条诊断，其它 agent 照常。
          this.warn(`挂载 agent ${id} 失败：${errorText(error)}`)
        })
        .finally(() => {
          this.#mounting.delete(id)
        })
    } catch (error) {
      // 作用域已销毁或拒绝挂载：跳过这一个 agent，不影响其它 agent。
      this.warn(`挂载 agent ${id} 失败：${errorText(error)}`)
      this.#mounting.delete(id)
      return undefined
    }
  }

  /** 对每个已挂载的 agent 补一轮（工具集合变了以后调用）。 */
  syncAll() {
    if (this.#disposed || this.#syncing) return
    this.#syncing = true
    try {
      for (const entry of [...this.#mounted.values()]) {
        try {
          entry.holder.sync()
        } catch (error) {
          this.warn(`重新施加工具分组失败：${errorText(error)}`)
        }
      }
    } finally {
      this.#syncing = false
    }
  }

  /** agent 销毁后清账（限制本身随 agent 作用域解绑）。 */
  release(id) {
    this.#mounted.delete(id)
  }

  dispose() {
    this.#disposed = true
    for (const [id, entry] of [...this.#mounted.entries()]) {
      this.#mounted.delete(id)
      try {
        entry.fiber?.dispose?.()
      } catch (error) {
        this.warn(`卸载 agent ${id} 的分组逻辑失败：${errorText(error)}`)
      }
    }
  }
}
