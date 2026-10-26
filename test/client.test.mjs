// 浏览器半区冒烟测试：不开浏览器，用假的 window/react 把 client.js 跑一遍。
//
// 覆盖四件在宿主里很难早期发现的事：
// 1. bundle 能正常求值、factory 只依赖 react（多要一个外部模块宿主会静默不加载）；
// 2. apply() 真的注册了侧栏行与主区页面，而且**两者的 id/key 一致**；
// 3. Remote 描述符的每个入参都带 strict codec —— 客户端 $mount 只认这个，
//    用 src-json 会在点开面板时报 "field ... has no strict codec"（真实踩过的坑）；
// 4. 样式里引用的每个 --dsw-* 令牌都真实存在 —— 引用不存在的令牌会让颜色回退，
//    曾经把主按钮变成"黑底无字"（真实踩过的坑）。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { MANIFEST } from '../lib/panel-service.js'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

// ── 主题令牌白名单（来自宿主 client Theme inspect 的 listTokens） ───────────
const THEME_TOKENS = new Set([
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-brand-primary',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-specific-sidebar-fill',
])
{
  // 只扫样式表本身，别把注释里的令牌名也算进来。
  const css = source.match(/const CSS = `([\s\S]*?)`\n/)?.[1] ?? ''
  assert.ok(css.length > 0, '没有找到 CSS 模板字符串')
  const used = new Set([...css.matchAll(/--dsw-[a-z0-9-]+/g)].map((match) => match[0]))
  const unknown = [...used].filter((token) => !THEME_TOKENS.has(token))
  assert.deepEqual(unknown, [], `样式引用了宿主没有的主题令牌：${unknown.join(', ')}`)
  // 至少真的用到了令牌，否则断言会空转。
  assert.ok(used.size >= 10, `样式里的令牌太少：${used.size}`)
}

// ── 极简 react：只要够跑组件函数的顶层逻辑 ──────────────────────────────────
const React = {
  Fragment: 'Fragment',
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
}

let bundle
const sandbox = {
  window: { __ModuleLoader__: { load: (definition) => (bundle = definition) } },
  console,
  setTimeout,
  clearTimeout,
  navigator: {},
}
vm.runInNewContext(source, sandbox, { filename: 'client.js' })

assert.ok(bundle, 'client.js 没有调用 window.__ModuleLoader__.load')
assert.equal(bundle.id, '@littleplus/dsh-toolbox')

const requests = []
const exported = bundle.factory((id) => {
  requests.push(id)
  if (id === 'react') return React
  throw new Error(`客户端多请求了外部模块：${id}`)
})
assert.deepEqual(requests, ['react'])
assert.deepEqual([...exported.inject], ['slots', 'locale', 'remote', 'layout'])
assert.equal(typeof exported.apply, 'function')

// ── 跑 apply：用一个记录型 ctx ──────────────────────────────────────────────
let contribution
const registered = []
const ctx = {
  effect: (fn) => {
    const dispose = fn()
    return () => dispose?.()
  },
  on: () => () => {},
  get: () => undefined,
  locale: {
    register: () => () => {},
    bind: () => (key) => key,
  },
  remote: {
    $mount: (value) => {
      contribution = value
      return Promise.resolve(() => {})
    },
  },
  slots: {
    inject: (_name, fn) => fn(),
    register: (options, component) => {
      registered.push({ options, component })
      return () => {}
    },
  },
}
exported.apply(ctx)

assert.equal(registered.length, 2)
const sidebar = registered.find((row) => row.options.name === 'sidebar.panellist')
const main = registered.find((row) => row.options.name === 'main')
assert.ok(sidebar, '没有注册 sidebar.panellist')
assert.ok(main, '没有注册 main')
assert.equal(typeof sidebar.component, 'function')
assert.equal(typeof main.component, 'function')
assert.equal(typeof sidebar.options.label, 'function')
// 侧栏行 id 与主区 key 必须相同，否则点图标切不到页面。
assert.equal(sidebar.options.id, main.options.key)
assert.equal(sidebar.options.id, 'toolbox')
assert.equal(typeof main.options.inject, 'function')
assert.deepEqual(Object.keys(main.options.inject()).sort(), ['call', 'goConversation', 't'])

// ── 图标组件能被调用（pure，用不到 hook） ──────────────────────────────────
{
  const icon = sidebar.component({ size: 18, active: true })
  assert.equal(icon.type, 'svg')
  assert.equal(icon.props.width, 18)
}

// ── 页面组件能被渲染（拿不到快照 = 加载中那一屏） ──────────────────────────
{
  const page = main.component({
    t: (key) => key,
    call: async () => ({}),
    goConversation: () => {},
  })
  assert.equal(page.type, 'div')
}

// ── Remote 描述符：入参必须 strict，且与宿主 MANIFEST 对齐 ──────────────────
assert.ok(contribution, '没有调用 ctx.remote.$mount')
assert.equal(contribution.package, '@littleplus/dsh-toolbox')
{
  const ids = new Set()
  for (const descriptor of contribution.descriptors) {
    assert.ok(!ids.has(descriptor.id), `描述符 id 重复：${descriptor.id}`)
    ids.add(descriptor.id)
    assert.equal(descriptor.namespace, 'toolbox')
    for (const parameter of descriptor.parameters) {
      assert.equal(parameter.codec.mode, 'strict', `${descriptor.id} 的入参 ${parameter.wire} 不是 strict codec`)
      assert.equal(typeof parameter.codec.create, 'function')
      assert.equal(typeof parameter.codec.create().parse, 'function')
    }
  }
}

/** (namespace/method) → { wires, symbols, result } */
function shapeOf(descriptors) {
  const table = new Map()
  // 客户端的描述符来自 vm 沙箱：数组要跨 realm 拷贝，否则 deepEqual 因原型不同而失败。
  for (const descriptor of Array.from(descriptors)) {
    table.set(`${descriptor.namespace}/${descriptor.method}`, {
      wires: Array.from(descriptor.parameters, (parameter) => parameter.wire),
      symbols: Array.from(descriptor.parameters, (parameter) => parameter.codec.typeSymbol ?? null),
      result: descriptor.result.mode,
    })
  }
  return table
}

{
  const client = shapeOf(contribution.descriptors)
  const host = shapeOf(MANIFEST.invocations)
  assert.deepEqual([...client.keys()].sort(), [...host.keys()].sort())
  for (const [endpoint, hostShape] of host) {
    const clientShape = client.get(endpoint)
    assert.deepEqual(clientShape.wires, hostShape.wires, `${endpoint} 两侧入参 wire 不一致`)
    assert.deepEqual(clientShape.symbols, hostShape.symbols, `${endpoint} 两侧 codec 类型符号不一致`)
    assert.equal(clientShape.result, hostShape.result, `${endpoint} 两侧 result codec 模式不一致`)
    // 宿主侧的入参同样必须是 strict：网关会拿它做边界解码。
    for (const parameter of MANIFEST.invocations.find((row) => `${row.namespace}/${row.method}` === endpoint).parameters) {
      assert.equal(parameter.codec.mode, 'strict')
    }
  }
}

console.log('client.js + lib/panel-service.js: all assertions passed')
