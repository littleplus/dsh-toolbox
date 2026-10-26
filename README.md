# dsh-toolbox（工具箱）

按正则把**全局注册的工具**分组，并用三种状态控制它们在模型上下文里的存在方式。左侧栏提供一个面板，可以直接增删改分组——写的是 profile 的 `cordis.patch.yml`。

## 三种状态

| status | 行为 |
| --- | --- |
| `open`（开启） | 完全不处理（默认）。 |
| `close`（关闭） | 匹配到的工具**从该会话的工具 schema 里消失**，不注入任何上下文。 |
| `request`（按需） | 匹配到的工具先隐藏，同时注册**一个与分组同名的入口工具**（描述 = 分组 `description`）。模型调用这个入口工具后，该组工具才出现在下一次请求的工具列表里。 |

`request` 就是渐进式披露：模型默认只看到一条"这组有什么"的说明，需要时才展开整组工具。

## 优先级：从上到下，先匹配先得

分组是**有序**的，一个工具只归属**第一个**匹配它的分组，后面的分组只看剩下的名字。这不是按状态比强弱，而是按顺序裁决。

```yaml
- { id: vk_read,  tools_regex: '^mcp__openviking__read$', status: open  }   # 先认领 read
- { id: vk_rest,  tools_regex: '^mcp__openviking__',      status: close }   # 只剩 write/…，吃不掉 read
```

上面这样写，`open` 先把 `mcp__openviking__read` 拿走了，后面那个 `close` 通配就**碰不到它**——这正是 `open` 组"保护"工具的办法。把两行对调，`close` 先吃光，`open` 一个也拿不到，于是整组 `mcp__openviking__*` 都被隐藏（包括 read）。

几个推论：

- `open` 组也会认领工具名，所以它既可能是"什么都不做"，也可能是"占位保护"，取决于放在哪。
- 正则完全相同的两组：上面那组全拿，下面那组 0 个。
- 面板上每张卡片左上角有序号，卡片上的 ↑ / ↓ 直接改优先级（就是改 YAML 里的顺序）。
- 如果某组的正则明明能匹配到工具、却一个都没拿到，卡片会写"*N* 个匹配已被上面更靠前的分组认领"，这类沉默的失效一眼能看见。

## 面板（推荐用法）

左侧栏「工具箱」里：

- **工具状态表**（默认展示）：面板顶部按名字密排**全部**工具，颜色就是它们经过本插件处理后的实际状态——正常色=会进模型上下文，灰色删除线=被 `close` 禁用，灰色虚线=被 `request` 收在按需入口后面（新会话默认隐藏）。鼠标悬停显示它归哪个分组管。
- **列表**：每个分组一节，带序号、状态、正则、当前实时命中的工具名（调正则时一眼能看到效果）。
- **新增**：右上「新增分组」→ 填 id、正则、描述、选状态。正则边输边预览命中结果，预览按"这一行会落在哪个位置"模拟，所以加在末尾的新组会如实显示"被上面的组挡掉了几个"。
- **修改**：卡片上的「编辑」就地展开表单，四个字段都能改；改 id 会按旧 id 定位那一行并替换。
- **删除**：卡片上的「删除」（再点一次「确认删除」，防误触）。
- **调顺序**：卡片上的 ↑ / ↓ 上移下移，顺序即优先级（见上一节）。
- **状态**：卡片上直接有下拉框（开启 / 关闭 / 按需），改完立刻生效。

所有写入都经过宿主的 `configEditor`：它加锁、保留 YAML 注释、原子替换文件，然后让 Loader 热协调——本插件随之重启，配置立即生效，**不需要重启 DSH**。

第一次写入时如果 profile 里还没有本插件的配置行，`configEditor` 会自动追加一行：

```yaml
- id: toolbox
  name: dsh-toolbox
  config:
    - { id: web, tools_regex: '^web_', description: '...', status: request }
```

## 手写配置

配置也可以直接写在 profile 的 `cordis.patch.yml`（`%USERPROFILE%\.dsh\profiles\<profile>\`），用与本插件行相同的 id 覆盖 `config`。`config` 本身是分组数组（也接受 `{ groups: [...] }`）：

```yaml
- id: toolbox
  config:
    - id: web                       # 同时是 request 模式下的工具名
      tools_regex: '^web_'          # JS 正则，按 search 语义匹配工具名
      description: Web search and page fetch tools. Call this to load them.
      status: request
    - id: browser
      tools_regex: '^(browser|computer)_'
      description: Browser control tools.
      status: close
    - id: todo
      tools_regex: '^todo_'
      description: Task list tools.
      status: open
```

字段约束：

- `id`：必填，工具名字符集 `^[A-Za-z][A-Za-z0-9_-]*$`，不能是宿主保留名 `run_code`，不能重复。
- `tools_regex`：必填，字符串正则。**不做整串锚定**，`^`/`$` 自己写。
- `description`：`request` 组必填（它就是入口工具给模型看的唯一说明），其它组可空。
- `status`：`open` / `close` / `request`，缺省按 `open`。

写错的行不会让插件加载失败：它出现在面板的「配置问题」里，其余分组照常工作。手写的东西面板也认——面板改一组时只覆盖这四个字段，其它字段原样保留。

## 设计取舍（为什么这么实现）

- **隐藏必须走 `ctx.tools.restrict()`**，且只能从 scoped ctx 施加，所以每个 agent 挂一个声明了 `inject: ['tools']` 的微型插件，由它在 agent 作用域里注册限制和入口工具；agent 销毁时 effect 自动解绑。`tools.guard()` 做不到这件事——它只拒绝调用，省不下上下文。
- **挂载必须等完成**：`ctx.plugin()` 的 apply 是异步排队的，`agent/created` 监听器要 `await` 它，否则新会话的**第一次**请求会抢在限制生效前装配出完整工具列表（等于没隐藏）。这条是踩出来的。
- **`open` 组也要参与认领**：如果只在"需要隐藏的组"里算，`open` 就无法保护工具；所以控制器同时存"全部分组（按序，含 open）"和"需要动作的分组（不含 open）"两份视图。
- **展开 = 撤回本组那条 deny**。没有"注入 schema 文本"这种旁路：工具列表本身变了，模型下一 step 就能直接调用。
- **限制按名字集合整体重算**（先按顺序认领，再由各组状态推出 deny），`tools/change` 时对每个 agent 补一轮（MCP 之类后连上来的工具也能被管住）。重入守卫 + 签名去重是必须的：`restrict()`/`undo()`/`register()` 都会**同步** emit `tools/change`，不挡就是无限递归。
- **认领表是唯一真源**：隐藏集合、入口工具返回的名单、面板显示的命中，全部来自同一份 `claimNames()` 结果，所以面板上看到的和模型实际拿到的永远一致（包括"被上面的组抢先"的情况）。
- **展开状态按会话记**，并在 agent 重建（resume / fork）时从 session 日志里的 `tool/call` 事件重放——模型看到过的东西必须能从日志重建。新会话从"未展开"开始，这正是渐进式披露的语义。
- **入口工具名 = 分组 id**；若该名字已被现有工具占用，则不注册（宁可报错也不静默遮蔽真工具），面板会提示。
- **不自己写 YAML**：CRUD 全部交给 `configEditor.edit()`，注释、`!!js` 表达式、文件锁、失败回滚都由宿主负责。
- **不引 zod**：Remote 的 wire 描述符手写，入参用 `lib/codec.js` 里的最小 strict codec（宿主与客户端都只要求 `create().parse(value)`），所以这个包没有 `dependencies`。

## 开发

```bash
cd dsh-toolbox
node test/core.test.mjs     # 归一化 / 匹配 / 按序认领 / 隐藏集合判定
node test/panel.test.mjs    # 面板服务的增删改移：落盘形状、校验、改 id、顺序、预览、形态保留
node test/client.test.mjs   # 浏览器半区冒烟：bundle 求值、槽位注册、Remote 描述符校验、主题令牌
```

`client.test.mjs` 用假的 `window`/`react` 在 Node 里跑一遍 `client.js`，专治两类难查的问题：客户端多要求一个外部模块（宿主会静默不加载）、以及 Remote 描述符的入参 codec 不合格（点开面板才报 `has no strict codec`）。

宿主半区依赖：`ctx.tools`。面板通道需要 `typert` 与 `configEditor`（Web/Desktop profile 默认都有）：缺 `configEditor` 时面板退化为只读。
