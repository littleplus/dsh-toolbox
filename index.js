/**
 * dsh-toolbox —— 宿主半区。
 *
 * 目标：把散落在全局工具注册表里的工具按正则分组，按组决定
 *   open    → 完全不处理；
 *   close   → 整组隐藏（不进模型上下文）；
 *   request → 整组隐藏，但注册一个与分组同名的入口工具（描述 = 分组描述），
 *             模型调用后该组工具下一次装配时才出现在工具列表里（渐进式披露）。
 *
 * **优先级**：分组从上到下依次认领工具名，一个工具只归第一个匹配它的分组，后面的分组
 * 只看剩下的。`open` 组也参与认领——把它放在前面就能保住一组工具不被后面的 `close`
 * 吃掉；顺序反过来则相反。所以"顺序"是有语义的配置项，面板可以上下移动。
 *
 * 三个部分：
 *   lib/config.js        配置归一化 + 按序认领（claimNames）
 *   lib/tool-groups.js   每个 agent 一个作用域的"限制 + 入口工具"微型插件
 *   lib/panel-service.js 面板的 Remote 服务（state / saveGroup / deleteGroup / moveGroup / preview）
 *
 * 为什么"按 agent"：宿主的 `ctx.tools.restrict()` 只接受 scoped ctx，并且要求名字在
 * 施加时已经存在；细则见 lib/tool-groups.js 顶部。
 */

import { normalizeGroups } from './lib/config.js'
import { ToolGroupController } from './lib/tool-groups.js'
import { MANIFEST, NAMESPACE, createPanelService } from './lib/panel-service.js'

/** Loader 里的插件名，也用于诊断。 */
export const name = 'toolbox'

/** 硬依赖：没有工具注册表这个插件毫无意义。 */
export const inject = ['tools']

/**
 * @param {object} ctx 插件上下文。
 * @param {unknown} config 插件行上的 config（分组数组）。
 */
export async function apply(ctx, config) {
  const { groups, errors } = normalizeGroups(config)
  const controller = new ToolGroupController(ctx, groups)

  // 面板服务从闭包里读当前状态；配置变更会让本插件重新 apply，闭包随之重建。
  const readState = () => ({ groups, errors, controller })

  // 插件卸载时把挂在各 agent 作用域上的微型插件全部拆掉（它们属于 agent 作用域，
  // 不会因为本插件卸载而自动消失）。
  ctx.effect(() => () => controller.dispose(), 'toolbox: agent scopes')

  // agent 生命周期：created 时挂载，并**等挂载完成**再返回——否则新 agent 第一次请求
  // 可能抢在限制生效前装配出完整工具列表。disposed 时清账（限制随作用域解绑）。
  ctx.on('agent/created', (payload) => controller.applyTo(payload?.agent))
  ctx.on('agent/disposed', (payload) => {
    const id = payload?.agent?.id
    if (typeof id === 'string') controller.release(id)
  })
  // 工具集合变化（后连上来的 MCP、动态注册）：对每个 agent 补一轮。
  // controller.syncAll() 自带重入守卫——restrict()/undo()/register() 自己也会同步 emit
  // 这个事件，不挡就是无限递归。
  ctx.on('tools/change', () => controller.syncAll())

  // 面板只是附加能力：注册失败不能把工具侧的隐藏/按需能力一起拖下水。
  const warn = (message) => {
    try {
      const logger = ctx.get('logger')
      if (typeof logger?.warn === 'function') return logger.warn(`[toolbox] ${message}`)
    } catch {
      // logger 缺失：退回 console
    }
    console.warn(`[toolbox] ${message}`)
  }

  // 面板通道：service key 即命名空间，`typertRemote` 绑定让 Gateway 能找到它。
  try {
    ctx.provide(NAMESPACE, createPanelService(ctx, readState))
  } catch (error) {
    warn(`面板服务未注册：${error instanceof Error ? error.message : String(error)}`)
  }
  ctx.inject(['typert'], (typeCtx) => {
    typeCtx.effect(() => {
      try {
        return typeCtx.typert.register(MANIFEST)
      } catch (error) {
        warn(`面板接口描述符未注册：${error instanceof Error ? error.message : String(error)}`)
        return () => {}
      }
    }, 'toolbox: typert manifest')
  })

  // 插件可能因为配置热更新在已有 agent 之上重启：先给现存 agent 补一轮并等它生效。
  await controller.mountAll()
}
