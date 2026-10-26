/**
 * dsh-toolbox —— 浏览器半区（普通 ES 模块，由宿主模块表加载）。
 *
 * 三件事：
 * 1. 在左侧栏注册一个入口（`sidebar.panellist`），图标跟随宿主的 currentColor；
 * 2. 在中央主区注册同名 key 的整页（`main`）——分组列表 + 增删改 + 正则实时预览；
 * 3. 所有写入都交给宿主的 configEditor，本文件从不直接碰 YAML。
 *
 * 数据全部走本包自己的 Remote 命名空间（`remote.toolbox`）：
 * - `state()`       读快照；
 * - `saveGroup()`   新增/改写一组（previousId 用于改 id）；
 * - `deleteGroup()` 删一组；
 * - `preview()`     只算正则命中，不落盘。
 *
 * 这里不 import 任何宿主 Client 包（宿主明确禁止），样式只用 `--dsw-alias-*` 令牌，
 * 所以主题切换下自动跟随。Remote 描述符的**入参必须用 strict codec**：客户端的
 * `$mount` 只认 `mode: 'strict'`，`src-json` 仅对 result 有效。
 */
window.__ModuleLoader__.load({
  id: '@littleplus/dsh-toolbox',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 客户端字典命名空间。 */
    const NS = 'toolbox'
    /** 侧栏行 id 与中央主区 key 必须一致。 */
    const PANEL_ID = 'toolbox'
    /** 宿主侧 Remote 命名空间（与插件行 id、service key 相同）。 */
    const REMOTE_NS = 'toolbox'
    /** 包名，用于 wire 描述符 id 与类型符号。 */
    const PACKAGE = '@littleplus/dsh-toolbox'

    const STATUSES = ['open', 'close', 'request']
    const STATUS_LABEL = { open: 'statusOpen', close: 'statusClose', request: 'statusRequest' }

    // ── 字典 ────────────────────────────────────────────────────────────────
    const en = {
      nav: 'Toolbox',
      title: 'Toolbox',
      subtitle: 'Group the globally registered tools and decide what the model sees.',
      refresh: 'Refresh',
      back: 'Conversation',
      loading: 'Loading…',
      loadFailed: 'Could not read the snapshot.',
      writeFailed: 'Could not write the config.',
      saved: 'Saved.',
      deleted: 'Deleted.',
      empty: 'No groups yet. Add one to start.',
      add: 'Add group',
      save: 'Save',
      cancel: 'Cancel',
      edit: 'Edit',
      remove: 'Delete',
      confirmRemove: 'Confirm delete',
      moveUp: 'Move up',
      moveDown: 'Move down',
      shadowed: 'matched by an earlier group',
      groups: 'groups',
      hiddenTools: 'hidden tools',
      onDemandTools: 'on-demand tools',
      totalTools: 'registered tools',
      agents: 'live sessions',
      toolState: 'Tool state',
      stateActive: 'live',
      stateHidden: 'disabled',
      stateOnDemand: 'on demand',
      matches: 'matches',
      noMatch: 'no tool matches right now',
      matchCount: 'matched tools',
      gateway: 'gateway tool',
      fieldId: 'Group id',
      fieldIdHint: 'Also the gateway tool name for on-demand groups: letters, digits, _ and -, must start with a letter.',
      fieldRegex: 'Tools regex',
      fieldRegexHint: 'JavaScript regexp, matched with search semantics — add ^ or $ yourself.',
      fieldDescription: 'Description',
      fieldDescriptionHint: 'For on-demand groups this is the only text the model sees before calling the gateway tool.',
      fieldStatus: 'Status',
      statusOpen: 'On',
      statusClose: 'Off',
      statusRequest: 'On demand',
      statusHint: 'On: untouched. Off: removed from the tool list. On demand: hidden until the model calls the gateway tool.',
      preview: 'Preview',
      previewEmpty: 'Type a regexp to preview the matches.',
      requiredId: 'Group id is required.',
      requiredRegex: 'Tools regex is required.',
      editable: 'Changes are written back to the profile patch.',
      readOnlyTitle: 'Read-only: no editable config row yet',
      readOnlyBody: 'Add this row to your profile cordis.patch.yml, save it, then refresh this page. After that this page writes there directly.',
      copy: 'Copy',
      copied: 'Copied',
      errors: 'Config problems',
      warnings: 'Runtime notes',
      hint: 'Matches are computed against the live global tool registry; per-session visibility is applied after this page reads it.',
      priority: 'Top-down priority: a tool belongs to the first group that matches it. Later groups only get what is left — whether or not the statuses differ.',
    }

    const zh = {
      nav: '工具箱',
      title: '工具箱',
      subtitle: '把全局注册的工具分组，决定模型能看到什么。',
      refresh: '刷新',
      back: '会话',
      loading: '加载中…',
      loadFailed: '读取快照失败。',
      writeFailed: '写入配置失败。',
      saved: '已保存。',
      deleted: '已删除。',
      empty: '还没有分组。新增一个开始。',
      add: '新增分组',
      save: '保存',
      cancel: '取消',
      edit: '编辑',
      remove: '删除',
      confirmRemove: '确认删除',
      moveUp: '上移',
      moveDown: '下移',
      shadowed: '个匹配已被上面更靠前的分组认领',
      groups: '分组',
      hiddenTools: '隐藏工具',
      onDemandTools: '按需工具',
      totalTools: '已注册工具',
      agents: '在线会话',
      toolState: '工具状态',
      stateActive: '生效',
      stateHidden: '已禁用',
      stateOnDemand: '按需',
      matches: '命中',
      noMatch: '当前没有命中任何工具',
      matchCount: '命中工具',
      gateway: '入口工具',
      fieldId: '分组 id',
      fieldIdHint: '按需模式下它同时是入口工具名：字母开头，可用字母、数字、下划线、短横线。',
      fieldRegex: '工具正则',
      fieldRegexHint: 'JavaScript 正则，按 search 语义匹配工具名——需要整串匹配请自己写 ^ 和 $。',
      fieldDescription: '描述',
      fieldDescriptionHint: '按需模式下，这是模型在调用入口工具前看到的唯一说明。',
      fieldStatus: '状态',
      statusOpen: '开启',
      statusClose: '关闭',
      statusRequest: '按需',
      statusHint: '开启：不处理。关闭：从工具列表里移除。按需：先隐藏，模型调用入口工具后才出现。',
      preview: '预览',
      previewEmpty: '输入正则后这里会实时显示命中的工具。',
      requiredId: '分组 id 不能为空。',
      requiredRegex: '工具正则不能为空。',
      editable: '改动会写回 profile 配置。',
      readOnlyTitle: '只读：没有可编辑的配置行',
      readOnlyBody: '把下面这行加进 profile 的 cordis.patch.yml，保存后刷新本页；之后本页就直接写那边了。',
      copy: '复制',
      copied: '已复制',
      errors: '配置问题',
      warnings: '运行时提示',
      hint: '命中结果按全局工具注册表实时计算；按会话生效的可见性在读取快照之后才施加。',
      priority: '从上到下优先：一个工具只归属第一个匹配它的分组，后面的分组只能捡剩下的——不管两者状态是否相同。',
    }

    // ── Remote 贡献 ─────────────────────────────────────────────────────────
    // 手写描述符（等同宿主生成的产物）。strict codec 的契约只有一句：
    // `create().parse(value)`；客户端不会在发送前调用它，宿主会用它做边界解码。
    const srcJson = () => ({ mode: 'src-json' })
    const strict = (typeSymbol, parse) => {
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
    const objectPayload = (label, fields) =>
      strict(`${PACKAGE}#${label}`, (value) => {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} 需要一个对象`)
        for (const field of fields) {
          if (typeof value[field] !== 'string') throw new TypeError(`${label}.${field} 必须是字符串`)
        }
        return value
      })

    const CONTRIBUTION = {
      package: PACKAGE,
      descriptors: [
        {
          id: `${PACKAGE}#${REMOTE_NS}/state`,
          service: REMOTE_NS,
          namespace: REMOTE_NS,
          method: 'state',
          invocation: { kind: 'direct' },
          parameters: [],
          result: srcJson(),
        },
        {
          id: `${PACKAGE}#${REMOTE_NS}/saveGroup`,
          service: REMOTE_NS,
          namespace: REMOTE_NS,
          method: 'saveGroup',
          invocation: { kind: 'direct' },
          parameters: [
            {
              name: 'payload',
              wire: 'payload',
              source: 'json',
              codec: objectPayload('SaveGroupPayload', ['id', 'tools_regex', 'description', 'status', 'previousId']),
            },
          ],
          result: srcJson(),
        },
        {
          id: `${PACKAGE}#${REMOTE_NS}/deleteGroup`,
          service: REMOTE_NS,
          namespace: REMOTE_NS,
          method: 'deleteGroup',
          invocation: { kind: 'direct' },
          parameters: [
            { name: 'payload', wire: 'payload', source: 'json', codec: objectPayload('DeleteGroupPayload', ['id']) },
          ],
          result: srcJson(),
        },
        {
          id: `${PACKAGE}#${REMOTE_NS}/moveGroup`,
          service: REMOTE_NS,
          namespace: REMOTE_NS,
          method: 'moveGroup',
          invocation: { kind: 'direct' },
          parameters: [
            { name: 'payload', wire: 'payload', source: 'json', codec: objectPayload('MoveGroupPayload', ['id', 'direction']) },
          ],
          result: srcJson(),
        },
        {
          id: `${PACKAGE}#${REMOTE_NS}/preview`,
          service: REMOTE_NS,
          namespace: REMOTE_NS,
          method: 'preview',
          invocation: { kind: 'direct' },
          parameters: [
            {
              name: 'payload',
              wire: 'payload',
              source: 'json',
              codec: objectPayload('PreviewPayload', ['tools_regex', 'id', 'previousId']),
            },
          ],
          result: srcJson(),
        },
      ],
    }

    // ── 样式 ────────────────────────────────────────────────────────────────
    // 只用主题令牌：令牌改名最坏是外观退化，不会破坏渲染。
    // 注意：这里引用的每个 --dsw-* 都必须真实存在（见 test/client.test.mjs 的令牌断言）。
    // 踩过的坑：曾经用 --dsw-alias-label-inverse 给主按钮上反色文字，宿主根本没这个令牌，
    // 于是文字颜色回退成正文色 —— 深色底 + 深色字，按钮看起来"只有黑色没有文字"。
    const CSS = `
.TB_page { height:100%; overflow:auto; padding:26px 30px 44px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-size:13px; line-height:1.5; box-sizing:border-box; }
.TB_inner { max-width:980px; margin:0 auto; }
.TB_head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:14px; }
.TB_headLeft { min-width:0; }
.TB_back { appearance:none; border:0; background:transparent; color:var(--dsw-alias-label-secondary); font-size:12px; padding:0 0 6px; cursor:pointer; display:inline-flex; align-items:center; gap:5px; }
.TB_back:hover { color:var(--dsw-alias-label-primary); }
.TB_title { margin:0; font-size:19px; font-weight:600; letter-spacing:.01em; }
.TB_sub { margin:6px 0 0; color:var(--dsw-alias-label-secondary); font-size:12.5px; }
.TB_actions { display:flex; gap:8px; flex:none; }
.TB_btn { appearance:none; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); border-radius:8px; padding:6px 12px; font-size:12.5px; cursor:pointer; }
.TB_btn:hover { border-color:var(--dsw-alias-border-l2); }
.TB_btn:disabled { opacity:.55; cursor:default; }
.TB_btnPrimary { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-bg-layer-1); font-weight:600; }
.TB_btnPrimary:hover { border-color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-bg-layer-2); }
.TB_btnDanger { color:var(--dsw-alias-state-error-primary); border-color:var(--dsw-alias-border-l1); }
.TB_btnDanger:hover { border-color:var(--dsw-alias-state-error-primary); }
.TB_btnSmall { padding:4px 10px; font-size:11.5px; }
.TB_stats { display:flex; flex-wrap:wrap; gap:8px; margin:0 0 16px; }
.TB_stat { border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); border-radius:999px; padding:4px 11px; font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.TB_stat b { color:var(--dsw-alias-label-primary); font-weight:600; margin-right:4px; }
.TB_banner { border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); border-radius:10px; padding:12px 14px; margin-bottom:16px; }
.TB_banner[data-tone="error"] { border-color:var(--dsw-alias-state-error-primary); }
.TB_banner[data-tone="ok"] { border-color:var(--dsw-alias-state-success-primary); }
.TB_bannerTitle { margin:0 0 4px; font-weight:600; font-size:12.5px; }
.TB_bannerBody { margin:0; color:var(--dsw-alias-label-secondary); font-size:12px; }
.TB_list { margin:6px 0 0; padding-left:18px; color:var(--dsw-alias-label-secondary); font-size:12px; }
.TB_snippetWrap { position:relative; margin-top:10px; }
.TB_snippet { margin:0; padding:10px 12px; border-radius:8px; background:var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l1); font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:11.5px; line-height:1.65; overflow:auto; white-space:pre; color:var(--dsw-alias-label-primary); }
.TB_copy { position:absolute; top:8px; right:8px; }
.TB_cards { display:grid; gap:10px; }
.TB_card { border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-1); border-radius:10px; padding:13px 15px; }
.TB_cardTop { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.TB_idRow { display:inline-flex; align-items:center; min-width:0; gap:8px; }
.TB_order { flex:none; min-width:14px; font-size:11px; color:var(--dsw-alias-label-secondary); font-variant-numeric:tabular-nums; }
.TB_dot { width:7px; height:7px; border-radius:999px; flex:none; }
.TB_dot[data-status="open"] { background:var(--dsw-alias-state-success-primary); }
.TB_dot[data-status="close"] { background:var(--dsw-alias-state-idle-primary); }
.TB_dot[data-status="request"] { background:var(--dsw-alias-state-warn-primary); }
.TB_id { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12.5px; font-weight:600; }
.TB_rowActions { display:inline-flex; align-items:center; gap:6px; flex:none; }
.TB_select { border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); border-radius:8px; padding:4px 9px; font-size:11.5px; cursor:pointer; }
.TB_desc { margin:8px 0 0; color:var(--dsw-alias-label-secondary); font-size:12.5px; }
.TB_meta { margin-top:9px; display:flex; flex-wrap:wrap; align-items:center; gap:8px; font-size:11.5px; color:var(--dsw-alias-label-secondary); }
.TB_regex { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; padding:2px 6px; border-radius:6px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); }
.TB_chips { margin-top:9px; display:flex; flex-wrap:wrap; gap:6px; }
.TB_chip { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:11px; padding:2px 7px; border-radius:6px; border:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-base); }
.TB_chip[data-tool="true"] { color:var(--dsw-alias-label-primary); border-color:var(--dsw-alias-border-l2); }
.TB_note { margin-top:9px; font-size:11.5px; color:var(--dsw-alias-state-warn-primary); }
.TB_form { margin-top:12px; border-top:1px solid var(--dsw-alias-border-l1); padding-top:12px; display:grid; gap:10px; }
.TB_field { display:grid; gap:4px; }
.TB_label { font-size:11.5px; font-weight:600; color:var(--dsw-alias-label-primary); }
.TB_input, .TB_area { appearance:none; width:100%; box-sizing:border-box; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); border-radius:8px; padding:7px 10px; font-size:12.5px; font-family:inherit; }
.TB_input:focus, .TB_area:focus { outline:none; border-color:var(--dsw-alias-brand-primary); }
.TB_input[data-mono="true"] { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
.TB_area { min-height:62px; resize:vertical; line-height:1.55; }
.TB_hintText { font-size:11px; color:var(--dsw-alias-label-secondary); }
.TB_formRow { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.TB_formButtons { display:flex; gap:8px; justify-content:flex-end; }
.TB_previewBox { border:1px solid var(--dsw-alias-border-l1); border-radius:8px; padding:8px 10px; background:var(--dsw-alias-bg-layer-2); }
.TB_previewHead { font-size:11px; color:var(--dsw-alias-label-secondary); margin-bottom:6px; }
.TB_previewError { color:var(--dsw-alias-state-error-primary); font-size:11.5px; }
.TB_empty { color:var(--dsw-alias-label-secondary); border:1px dashed var(--dsw-alias-border-l1); border-radius:10px; padding:22px; text-align:center; font-size:12.5px; }
.TB_toolBar { margin:0 0 16px; padding:10px 12px; border:1px solid var(--dsw-alias-border-l1); border-radius:10px; background:var(--dsw-alias-bg-layer-1); }
.TB_toolHead { display:flex; align-items:center; flex-wrap:wrap; gap:12px; margin-bottom:8px; }
.TB_toolHead b { font-size:11.5px; font-weight:600; color:var(--dsw-alias-label-primary); }
.TB_legend { display:inline-flex; align-items:center; gap:5px; font-size:10.5px; color:var(--dsw-alias-label-secondary); }
.TB_legend i { width:7px; height:7px; border-radius:2px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-label-primary); }
.TB_legend i[data-state="hidden"] { background:transparent; border-style:dashed; }
.TB_legend i[data-state="ondemand"] { background:transparent; border-color:var(--dsw-alias-state-warn-primary); }
.TB_toolGrid { display:flex; flex-wrap:wrap; gap:4px; }
.TB_tool { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:10.5px; line-height:1.5; padding:1px 5px; border-radius:4px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); white-space:nowrap; }
.TB_tool[data-state="hidden"] { color:var(--dsw-alias-label-secondary); opacity:.45; text-decoration:line-through; }
.TB_tool[data-state="ondemand"] { color:var(--dsw-alias-label-secondary); opacity:.8; border-style:dashed; }
.TB_error { color:var(--dsw-alias-state-error-primary); font-size:12px; }
.TB_hint { margin:18px 0 0; color:var(--dsw-alias-label-secondary); font-size:11.5px; }
.TB_loading { color:var(--dsw-alias-label-secondary); font-size:12.5px; padding:20px 0; }
`

    // ── 图标 ────────────────────────────────────────────────────────────────
    /** 侧栏图标：两条滑杆 + 两个圆点，尺寸由宿主给。 */
    function PanelIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 18
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          'aria-hidden': true,
        },
        h('line', { x1: 4, y1: 8, x2: 20, y2: 8 }),
        h('circle', { cx: 9, cy: 8, r: 2.4, fill: 'currentColor', stroke: 'none' }),
        h('line', { x1: 4, y1: 16, x2: 20, y2: 16 }),
        h('circle', { cx: 15, cy: 16, r: 2.4, fill: 'currentColor', stroke: 'none' }),
      )
    }

    // ── 小组件 ──────────────────────────────────────────────────────────────
    function Chip(props) {
      return h('span', { className: 'TB_chip', 'data-tool': String(props.tool === true) }, props.children)
    }

    function Banner(props) {
      return h(
        'div',
        { className: 'TB_banner', 'data-tone': props.tone ?? 'plain' },
        props.title === undefined || props.title === null
          ? null
          : h('p', { className: 'TB_bannerTitle' }, props.title),
        props.children,
      )
    }

    function MatchChips(props) {
      const { t, matches } = props
      if (matches === null || matches === undefined) {
        return h('p', { className: 'TB_hintText' }, t('previewEmpty'))
      }
      if (matches.length === 0) {
        return h('p', { className: 'TB_hintText' }, t('noMatch'))
      }
      return h(
        'div',
        { className: 'TB_chips' },
        matches.map((name) => h(Chip, { key: name, tool: true }, name)),
      )
    }

    /**
     * 分组编辑/新增表单。新增与编辑共用一个组件：`initial.id === null` 表示新增。
     * 正则改动会防抖后请宿主算命中，所以输入时就能看到效果。
     */
    function GroupForm(props) {
      const { t, initial, busy, onSubmit, onCancel, preview } = props
      const [id, setId] = React.useState(initial.id ?? '')
      const [regex, setRegex] = React.useState(initial.tools_regex ?? '')
      const [description, setDescription] = React.useState(initial.description ?? '')
      const [status, setStatus] = React.useState(initial.status ?? 'open')
      const [matches, setMatches] = React.useState(null)
      const [shadowed, setShadowed] = React.useState(0)
      const [previewError, setPreviewError] = React.useState(null)
      const [formError, setFormError] = React.useState(null)

      // 预览要按优先级模拟：编辑=替换原位置，新增=末尾，所以把 previousId 一起带上。
      const previousId = initial.previousId ?? ''
      React.useEffect(() => {
        const source = regex.trim()
        if (source === '') {
          setMatches(null)
          setShadowed(0)
          setPreviewError(null)
          return undefined
        }
        let live = true
        const timer = setTimeout(() => {
          Promise.resolve()
            .then(() => preview({ tools_regex: source, id: id.trim(), previousId }))
            .then((result) => {
              if (!live) return
              setMatches(Array.isArray(result?.matches) ? result.matches : [])
              setShadowed(typeof result?.shadowed === 'number' ? result.shadowed : 0)
              setPreviewError(result?.error ?? null)
            })
            .catch((cause) => {
              if (!live) return
              setMatches(null)
              setShadowed(0)
              setPreviewError(String(cause?.message ?? cause))
            })
        }, 220)
        return () => {
          live = false
          clearTimeout(timer)
        }
      }, [regex, id, previousId, preview])

      const submit = () => {
        if (id.trim() === '') return setFormError(t('requiredId'))
        if (regex.trim() === '') return setFormError(t('requiredRegex'))
        setFormError(null)
        onSubmit({ id: id.trim(), tools_regex: regex.trim(), description: description.trim(), status })
      }

      return h(
        'div',
        { className: 'TB_form' },
        h(
          'div',
          { className: 'TB_field' },
          h('label', { className: 'TB_label' }, t('fieldId')),
          h('input', {
            className: 'TB_input',
            'data-mono': 'true',
            value: id,
            spellCheck: false,
            onChange: (event) => setId(event.target.value),
          }),
          h('span', { className: 'TB_hintText' }, t('fieldIdHint')),
        ),
        h(
          'div',
          { className: 'TB_field' },
          h('label', { className: 'TB_label' }, t('fieldRegex')),
          h('input', {
            className: 'TB_input',
            'data-mono': 'true',
            value: regex,
            spellCheck: false,
            placeholder: '^mcp__openviking__',
            onChange: (event) => setRegex(event.target.value),
          }),
          h('span', { className: 'TB_hintText' }, t('fieldRegexHint')),
        ),
        h(
          'div',
          { className: 'TB_previewBox' },
          h('div', { className: 'TB_previewHead' }, `${t('preview')} · ${t('matchCount')}`),
          previewError === null
            ? h(MatchChips, { t, matches })
            : h('div', { className: 'TB_previewError' }, previewError),
          shadowed > 0 ? h('div', { className: 'TB_previewHead' }, `${shadowed} ${t('shadowed')}`) : null,
        ),
        h(
          'div',
          { className: 'TB_field' },
          h('label', { className: 'TB_label' }, t('fieldDescription')),
          h('textarea', {
            className: 'TB_area',
            value: description,
            onChange: (event) => setDescription(event.target.value),
          }),
          h('span', { className: 'TB_hintText' }, t('fieldDescriptionHint')),
        ),
        h(
          'div',
          { className: 'TB_field' },
          h('label', { className: 'TB_label' }, t('fieldStatus')),
          h(
            'select',
            {
              className: 'TB_select',
              value: status,
              onChange: (event) => setStatus(event.target.value),
            },
            STATUSES.map((value) => h('option', { key: value, value }, t(STATUS_LABEL[value]))),
          ),
          h('span', { className: 'TB_hintText' }, t('statusHint')),
        ),
        formError === null ? null : h('div', { className: 'TB_error' }, formError),
        h(
          'div',
          { className: 'TB_formButtons' },
          h(
            'button',
            { className: 'TB_btn', onClick: onCancel, disabled: busy === true, type: 'button' },
            t('cancel'),
          ),
          h(
            'button',
            { className: 'TB_btn TB_btnPrimary', onClick: submit, disabled: busy === true, type: 'button' },
            t('save'),
          ),
        ),
      )
    }

    /**
     * 一张分组卡片：默认展示 + 状态下拉框 + 编辑/删除；编辑时就地展开表单。
     * 删除是两步（再点一次确认），避免误触把整组配置写掉。
     */
    function GroupCard(props) {
      const { group, t, editable, busy, onSave, onDelete, onMove, index, count, preview } = props
      const [editing, setEditing] = React.useState(false)
      const [confirming, setConfirming] = React.useState(false)

      const changeStatus = (status) => {
        if (status === group.status) return
        onSave({
          id: group.id,
          previousId: group.id,
          tools_regex: group.regex,
          description: group.description,
          status,
        })
      }

      return h(
        'div',
        { className: 'TB_card' },
        h(
          'div',
          { className: 'TB_cardTop' },
          h(
            'div',
            { className: 'TB_idRow' },
            h('span', { className: 'TB_order' }, String(index + 1)),
            h('span', { className: 'TB_dot', 'data-status': group.status }),
            h('span', { className: 'TB_id' }, group.id),
            group.tool === null ? null : h('span', { className: 'TB_hintText' }, `· ${t('gateway')} ${group.tool}`),
          ),
          h(
            'div',
            { className: 'TB_rowActions' },
            editable
              ? h(
                  'button',
                  {
                    className: 'TB_btn TB_btnSmall',
                    type: 'button',
                    title: t('moveUp'),
                    disabled: busy || index === 0,
                    onClick: () => onMove(group.id, 'up'),
                  },
                  '↑',
                )
              : null,
            editable
              ? h(
                  'button',
                  {
                    className: 'TB_btn TB_btnSmall',
                    type: 'button',
                    title: t('moveDown'),
                    disabled: busy || index === count - 1,
                    onClick: () => onMove(group.id, 'down'),
                  },
                  '↓',
                )
              : null,
            editable
              ? h(
                  'select',
                  {
                    className: 'TB_select',
                    value: group.status,
                    disabled: busy,
                    onChange: (event) => changeStatus(event.target.value),
                  },
                  STATUSES.map((value) => h('option', { key: value, value }, t(STATUS_LABEL[value]))),
                )
              : h('span', { className: 'TB_hintText' }, t(STATUS_LABEL[group.status])),
            editable
              ? h(
                  'button',
                  {
                    className: 'TB_btn TB_btnSmall',
                    type: 'button',
                    disabled: busy,
                    onClick: () => {
                      setEditing((value) => !value)
                      setConfirming(false)
                    },
                  },
                  editing ? t('cancel') : t('edit'),
                )
              : null,
            editable
              ? h(
                  'button',
                  {
                    className: 'TB_btn TB_btnSmall TB_btnDanger',
                    type: 'button',
                    disabled: busy,
                    onClick: () => {
                      if (!confirming) {
                        setConfirming(true)
                        return
                      }
                      setConfirming(false)
                      onDelete(group.id)
                    },
                    onBlur: () => setConfirming(false),
                  },
                  confirming ? t('confirmRemove') : t('remove'),
                )
              : null,
          ),
        ),
        group.description === '' ? null : h('p', { className: 'TB_desc' }, group.description),
        h(
          'div',
          { className: 'TB_meta' },
          h('span', { className: 'TB_regex' }, group.regex),
          h('span', {}, `${t('matches')} ${group.matched.length}`),
          group.shadowed > 0
            ? h('span', { className: 'TB_hintText' }, `${group.shadowed} ${t('shadowed')}`)
            : null,
        ),
        h(
          'div',
          { className: 'TB_chips' },
          group.matched.length === 0
            ? h('span', { className: 'TB_hintText' }, t('noMatch'))
            : group.matched.map((name) => h(Chip, { key: name, tool: true }, name)),
        ),
        group.note === null || group.note === undefined
          ? null
          : h('p', { className: 'TB_note' }, group.note),
        editing
          ? h(GroupForm, {
              key: `edit:${group.id}`,
              t,
              busy,
              preview,
              initial: {
                id: group.id,
                tools_regex: group.regex,
                description: group.description,
                status: group.status,
                // 预览要按"这一行留在原位"模拟优先级；缺了它会被当成新行排到末尾。
                previousId: group.id,
              },
              onCancel: () => setEditing(false),
              onSubmit: (draft) => {
                // 写成功后收起表单；失败则留在原地，错误显示在页面顶部。
                Promise.resolve(onSave({ ...draft, previousId: group.id })).then((ok) => {
                  if (ok === true) setEditing(false)
                })
              },
            })
          : null,
      )
    }

    /** 全部工具一张密集的图：一眼看清哪些生效、哪些被禁用、哪些还得按需展开。 */
    function ToolGrid(props) {
      const { t, tools } = props
      if (!Array.isArray(tools) || tools.length === 0) return null
      const rows = [...tools].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
      return h(
        'div',
        { className: 'TB_toolBar' },
        h(
          'div',
          { className: 'TB_toolHead' },
          h('b', {}, `${t('toolState')} · ${rows.length}`),
          h('span', { className: 'TB_legend' }, h('i', { 'data-state': 'active' }), t('stateActive')),
          h('span', { className: 'TB_legend' }, h('i', { 'data-state': 'hidden' }), t('stateHidden')),
          h('span', { className: 'TB_legend' }, h('i', { 'data-state': 'ondemand' }), t('stateOnDemand')),
        ),
        h(
          'div',
          { className: 'TB_toolGrid' },
          rows.map((tool) =>
            h(
              'span',
              {
                key: tool.name,
                className: 'TB_tool',
                'data-state': tool.state,
                // 悬停能看到它归哪个分组管，省得挨张卡片去翻。
                title: tool.group === null ? tool.name : `${tool.name} ← ${tool.group}`,
              },
              tool.name,
            ),
          ),
        ),
      )
    }

    // ── 页面 ────────────────────────────────────────────────────────────────
    function PanelPage(props) {
      const { t, call, goConversation } = props
      const [snap, setSnap] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [adding, setAdding] = React.useState(false)
      const [copied, setCopied] = React.useState(false)

      const load = React.useCallback(async () => {
        try {
          const value = await call('state')
          setSnap(value)
          setError(null)
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        }
      }, [call])

      React.useEffect(() => {
        load()
      }, [load])

      /** 写入会让宿主重启本插件，服务在几百毫秒内可能短暂不可用，所以重试若干次。 */
      const refreshAfterWrite = React.useCallback(
        async (attempts) => {
          let lastError
          for (let attempt = 0; attempt < attempts; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 180))
            try {
              const value = await call('state')
              setSnap(value)
              setError(null)
              return
            } catch (cause) {
              lastError = cause
            }
          }
          throw lastError ?? new Error('state unavailable')
        },
        [call],
      )

      const run = React.useCallback(
        (key, action, done) => {
          setBusy(key)
          setError(null)
          setNotice(null)
          return Promise.resolve()
            .then(action)
            .then(() => refreshAfterWrite(8))
            .then(() => {
              setNotice(done)
              return true
            })
            .catch((cause) => {
              setError(`${t('writeFailed')} ${String(cause?.message ?? cause)}`)
              return false
            })
            .finally(() => setBusy(null))
        },
        [refreshAfterWrite, t],
      )

      const preview = React.useCallback((payload) => call('preview', payload), [call])

      /** 保存一组；解析为 true 表示写成功（表单据此收起）。 */
      const save = React.useCallback(
        (draft) => {
          const isAdd = draft.previousId === undefined || draft.previousId === ''
          return run(
            isAdd ? 'add' : `save:${draft.previousId}`,
            () => call('saveGroup', draft),
            t('saved'),
          ).then((ok) => {
            if (ok && isAdd) setAdding(false)
            return ok
          })
        },
        [call, run, t],
      )

      const remove = React.useCallback(
        (id) => {
          run(`delete:${id}`, () => call('deleteGroup', { id }), t('deleted'))
        },
        [call, run, t],
      )

      /** 上移/下移：顺序就是优先级，所以这会改变谁先认领工具。 */
      const move = React.useCallback(
        (id, direction) => {
          run(`move:${id}`, () => call('moveGroup', { id, direction }), t('saved'))
        },
        [call, run, t],
      )

      const copySnippet = React.useCallback(() => {
        const text = snap?.snippet ?? ''
        Promise.resolve(navigator?.clipboard?.writeText(text))
          .then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1400)
          })
          .catch(() => setError(String(t('writeFailed'))))
      }, [snap, t])

      const groups = Array.isArray(snap?.groups) ? snap.groups : []
      const editable = snap?.editable === true
      const stats =
        snap === null
          ? []
          : [
              [t('groups'), groups.length],
              [t('totalTools'), snap.toolTotal],
              [t('hiddenTools'), snap.hidden],
              [t('onDemandTools'), snap.onDemand],
              [t('agents'), snap.agents],
            ]

      return h(
        'div',
        { className: 'TB_page' },
        h('style', {}, CSS),
        h(
          'div',
          { className: 'TB_inner' },
          h(
            'div',
            { className: 'TB_head' },
            h(
              'div',
              { className: 'TB_headLeft' },
              h('button', { className: 'TB_back', type: 'button', onClick: goConversation }, `← ${t('back')}`),
              h('h1', { className: 'TB_title' }, t('title')),
              h('p', { className: 'TB_sub' }, t('subtitle')),
            ),
            h(
              'div',
              { className: 'TB_actions' },
              h('button', { className: 'TB_btn', type: 'button', onClick: () => load() }, t('refresh')),
              editable
                ? h(
                    'button',
                    {
                      className: 'TB_btn TB_btnPrimary',
                      type: 'button',
                      disabled: busy !== null,
                      onClick: () => {
                        setAdding(true)
                        setNotice(null)
                      },
                    },
                    t('add'),
                  )
                : null,
            ),
          ),
          error === null ? null : h(Banner, { tone: 'error', title: t('loadFailed') }, h('p', { className: 'TB_bannerBody' }, error)),
          notice === null ? null : h(Banner, { tone: 'ok' }, h('p', { className: 'TB_bannerBody' }, notice)),
          stats.length === 0
            ? null
            : h(
                'div',
                { className: 'TB_stats' },
                stats.map(([label, value]) =>
                  h('span', { className: 'TB_stat', key: label }, h('b', {}, String(value)), label),
                ),
              ),
          snap === null
            ? h('div', { className: 'TB_loading' }, t('loading'))
            : h(
                'div',
                {},
                // 默认视图就是这张工具状态表：生效的白色，禁用的灰色。
                h(ToolGrid, { t, tools: snap.tools }),
                snap.editable
                  ? null
                  : h(
                      Banner,
                      { title: t('readOnlyTitle') },
                      h('p', { className: 'TB_bannerBody' }, t('readOnlyBody')),
                      h(
                        'div',
                        { className: 'TB_snippetWrap' },
                        h('pre', { className: 'TB_snippet' }, snap.snippet ?? ''),
                        h(
                          'button',
                          { className: 'TB_btn TB_btnSmall TB_copy', type: 'button', onClick: copySnippet },
                          copied ? t('copied') : t('copy'),
                        ),
                      ),
                    ),
                Array.isArray(snap.errors) && snap.errors.length > 0
                  ? h(
                      Banner,
                      { tone: 'error', title: t('errors') },
                      h(
                        'ul',
                        { className: 'TB_list' },
                        snap.errors.map((row, index) =>
                          h('li', { key: index }, `${row.where}: ${row.message}`),
                        ),
                      ),
                    )
                  : null,
                Array.isArray(snap.warnings) && snap.warnings.length > 0
                  ? h(
                      Banner,
                      { title: t('warnings') },
                      h(
                        'ul',
                        { className: 'TB_list' },
                        snap.warnings.map((line, index) => h('li', { key: index }, line)),
                      ),
                    )
                  : null,
                adding && editable
                  ? h(
                      'div',
                      { className: 'TB_card' },
                      h('div', { className: 'TB_cardTop' }, h('span', { className: 'TB_id' }, t('add'))),
                      h(GroupForm, {
                        key: 'add',
                        t,
                        busy: busy === 'add',
                        preview,
                        initial: { id: '', tools_regex: '', description: '', status: 'request' },
                        onCancel: () => setAdding(false),
                        onSubmit: (draft) => save(draft),
                      }),
                    )
                  : null,
                groups.length === 0
                  ? h('p', { className: 'TB_empty' }, t('empty'))
                  : h(
                      'div',
                      { className: 'TB_cards' },
                      groups.map((group, index) =>
                        h(GroupCard, {
                          key: group.id,
                          group,
                          t,
                          editable,
                          preview,
                          index,
                          count: groups.length,
                          busy:
                            busy === `save:${group.id}` ||
                            busy === `delete:${group.id}` ||
                            busy === `move:${group.id}`,
                          onSave: save,
                          onDelete: remove,
                          onMove: move,
                        }),
                      ),
                    ),
                h('p', { className: 'TB_hint' }, t('priority')),
                h('p', { className: 'TB_hint' }, t('hint')),
              ),
        ),
      )
    }

    // ── 插件体 ──────────────────────────────────────────────────────────────
    return {
      inject: ['slots', 'locale', 'remote', 'layout'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'toolbox: dictionaries')
        const t = ctx.locale.bind(NS)
        const mount = ctx.remote.$mount(CONTRIBUTION)

        /** 统一的 Remote 调用：异常与 { ok:false } 都收敛成 throw。 */
        const call = async (method, ...args) => {
          await mount
          const remote = ctx.get(`remote.${REMOTE_NS}`)
          if (remote === null || typeof remote !== 'object' || typeof remote[method] !== 'function') {
            throw new Error(`remote.${REMOTE_NS}.${method} is unavailable`)
          }
          const result = await remote[method](...args)
          if (result === null || typeof result !== 'object') throw new Error(`${method}: malformed remote result`)
          if (!result.ok) {
            const detail = result.error ?? {}
            throw new Error(`${method}: ${detail.code ?? 'unknown'} ${detail.message ?? ''}`.trim())
          }
          return result.value
        }

        const goConversation = () => {
          const layout = ctx.get('layout')
          if (layout !== null && typeof layout === 'object' && typeof layout.selectPanel === 'function') {
            layout.selectPanel(null)
          }
        }

        // 左侧栏入口：order 6 排在宿主自带条目之后，不抢它们的位置。
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 6,
              label: () => t('nav'),
              locale: NS,
            },
            PanelIcon,
          ),
        )

        // 中央主区整页：key 必须与上面的行 id 相同，否则宿主选中时找不到页面。
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              locale: NS,
              inject: () => ({ t, call, goConversation }),
            },
            PanelPage,
          ),
        )
      },
    }
  },
})
