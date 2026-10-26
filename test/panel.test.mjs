// 面板服务的行为测试：用假的 configEditor 跑真实的 createPanelService。
// 覆盖增删改的落盘形状、校验（非法正则 / 重复 id / 未知状态）、改 id 的重命名、
// 以及 `{ groups: [...] }` 外层形态的保留。
import assert from 'node:assert/strict'
import { createPanelService, MANIFEST, SYMBOLS, ROW_ID, NAMESPACE } from '../lib/panel-service.js'
import { normalizeGroups } from '../lib/config.js'

const TOOLS = ['web_search', 'web_fetch', 'browser_open', 'todo_write', 'bash']

/** 假的 configEditor：`edit` 的契约是 change(current, inherited) → next。 */
function fakeEditor(seed) {
  const state = { config: seed, writes: [] }
  return {
    documentPath: 'C:/profiles/desktop/cordis.patch.yml',
    state,
    entries() {
      return [{ options: { id: ROW_ID, name: '@littleplus/dsh-toolbox', config: state.config }, fiber: {} }]
    },
    async edit(_entry, change) {
      const current = structuredClone(state.config)
      const next = change(current, {})
      state.config = next
      state.writes.push(next)
    },
  }
}

function fakeCtx(editor) {
  return {
    get(key) {
      if (key === 'configEditor') return editor
      if (key === 'tools') return { schemas: () => TOOLS.map((name) => ({ name })) }
      return undefined
    },
  }
}

function build(seed) {
  const editor = fakeEditor(seed)
  const groups = () => {
    const raw = editor.state.config
    const list = Array.isArray(raw) ? raw : (raw?.groups ?? [])
    return normalizeGroups(raw?.groups === undefined ? raw : { groups: list })
  }
  const controller = { notes: () => new Map(), warnings: [], activeCount: 2 }
  const service = createPanelService(fakeCtx(editor), () => ({
    groups: groups().groups,
    errors: groups().errors,
    controller,
  }))
  return { editor, service }
}

// ── 快照：可编辑 + 空列表 ──────────────────────────────────────────────────
{
  const { service } = build(undefined)
  const snap = service.state()
  assert.equal(snap.editable, true)
  assert.deepEqual(snap.groups, [])
  assert.equal(snap.toolTotal, TOOLS.length)
  assert.equal(snap.agents, 2)
  assert.ok(snap.snippet.includes(`- id: ${ROW_ID}`))
  assert.equal(snap.patchPath.endsWith('cordis.patch.yml'), true)
}

// ── 新增：写进文件的是归一化后的四个字段 ───────────────────────────────────
{
  const { editor, service } = build(undefined)
  await service.saveGroup({
    id: ' web ',
    tools_regex: '^web_',
    description: '  Web 工具  ',
    status: 'request',
    previousId: '',
  })
  assert.deepEqual(editor.state.writes.at(-1), [
    { id: 'web', tools_regex: '^web_', description: 'Web 工具', status: 'request' },
  ])
  const snap = service.state()
  assert.equal(snap.groups.length, 1)
  assert.deepEqual(snap.groups[0].matched, ['web_fetch', 'web_search'])
  assert.equal(snap.groups[0].tool, 'web')
}

// ── 校验：非法正则 / 非法 id / 未知状态 / 重复 id 全部拒绝写盘 ─────────────
{
  const { editor, service } = build(undefined)
  await assert.rejects(
    () => service.saveGroup({ id: 'bad', tools_regex: '([', description: '', status: 'open', previousId: '' }),
    /正则无法编译/,
  )
  await assert.rejects(
    () => service.saveGroup({ id: 'bad name', tools_regex: '^x', description: '', status: 'open', previousId: '' }),
    /不是合法工具名/,
  )
  await assert.rejects(
    () => service.saveGroup({ id: 'ok', tools_regex: '^x', description: '', status: 'hidden', previousId: '' }),
    /未知状态/,
  )
  await assert.rejects(
    () => service.saveGroup({ id: 'grp', tools_regex: '^x', description: '', status: 'request', previousId: '' }),
    /description/,
  )
  assert.equal(editor.state.writes.length, 0, '被拒绝的写入不应该碰文件')

  await service.saveGroup({ id: 'web', tools_regex: '^web_', description: '', status: 'close', previousId: '' })
  await assert.rejects(
    () => service.saveGroup({ id: 'web', tools_regex: '^x', description: '', status: 'open', previousId: '' }),
    /已经有 id/,
  )
  assert.equal(editor.state.config.length, 1)
}

// ── 修改：改状态、改正则、改 id（previousId 定位旧行） ─────────────────────
{
  const { editor, service } = build(undefined)
  await service.saveGroup({ id: 'web', tools_regex: '^web_', description: 'd', status: 'request', previousId: '' })
  await service.saveGroup({ id: 'web', tools_regex: '^web_', description: 'd', status: 'close', previousId: 'web' })
  assert.equal(editor.state.config[0].status, 'close')
  assert.equal(editor.state.config.length, 1)

  await service.saveGroup({ id: 'webtools', tools_regex: '^web_', description: 'd', status: 'close', previousId: 'web' })
  assert.deepEqual(editor.state.config.map((row) => row.id), ['webtools'])

  // 改名撞上别的分组要拒绝。
  await service.saveGroup({ id: 'bash', tools_regex: '^bash$', description: '', status: 'open', previousId: '' })
  await assert.rejects(
    () => service.saveGroup({ id: 'bash', tools_regex: '^x', description: '', status: 'open', previousId: 'webtools' }),
    /已经有 id/,
  )
}

// ── 修改：保留用户手写的额外字段 ───────────────────────────────────────────
{
  const { editor, service } = build([{ id: 'web', tools_regex: '^web_', description: '', status: 'open', note: '手写' }])
  await service.saveGroup({ id: 'web', tools_regex: '^web_', description: '', status: 'close', previousId: 'web' })
  assert.equal(editor.state.config[0].status, 'close')
  assert.equal(editor.state.config[0].note, '手写')
}

// ── 删除 ───────────────────────────────────────────────────────────────────
{
  const { editor, service } = build(undefined)
  await service.saveGroup({ id: 'web', tools_regex: '^web_', description: '', status: 'close', previousId: '' })
  await service.saveGroup({ id: 'todo', tools_regex: '^todo_', description: '', status: 'open', previousId: '' })
  await service.deleteGroup({ id: 'web' })
  assert.deepEqual(editor.state.config.map((row) => row.id), ['todo'])
  assert.equal(service.state().groups.length, 1)
  await assert.rejects(() => service.deleteGroup({ id: 'web' }), /没有 id/)
}

// ── 外层形态：`{ groups: [...] }` 写回时保持，别的顶层字段不动 ─────────────
{
  const { editor, service } = build({ groups: [{ id: 'web', tools_regex: '^web_', description: '', status: 'open' }], note: 'keep' })
  await service.saveGroup({ id: 'todo', tools_regex: '^todo_', description: '', status: 'open', previousId: '' })
  const written = editor.state.writes.at(-1)
  assert.equal(Array.isArray(written), false)
  assert.equal(written.note, 'keep')
  assert.deepEqual(written.groups.map((row) => row.id), ['web', 'todo'])
}

// ── 预览：只算命中，不写盘；并按优先级模拟候选行位置 ───────────────────────
{
  const { editor, service } = build(undefined)
  assert.deepEqual(service.preview({ tools_regex: '^web_', id: 'web', previousId: '' }), {
    matches: ['web_fetch', 'web_search'],
    shadowed: 0,
    error: null,
  })
  assert.deepEqual(service.preview({ tools_regex: '   ', id: '', previousId: '' }), {
    matches: [],
    shadowed: 0,
    error: null,
  })
  const bad = service.preview({ tools_regex: '([', id: 'bad', previousId: '' })
  assert.deepEqual(bad.matches, [])
  assert.match(bad.error, /正则无法编译/)
  assert.equal(editor.state.writes.length, 0)
}

// ── 预览：被上面更靠前的分组认领走的，预览里就要如实体现 ────────────────────
{
  // 已有 web(close, ^web_)；再加一个 ^web_search$ 的新分组 → 排在末尾，一个都拿不到。
  const { service } = build([{ id: 'web', tools_regex: '^web_', description: '', status: 'close' }])
  const late = service.preview({ tools_regex: '^web_search$', id: 'one', previousId: '' })
  assert.deepEqual(late, { matches: [], shadowed: 1, error: null })
  // 把它放在 web 前面（编辑 web 那一行本身）则相反：它先拿，web 剩下 web_fetch。
  const early = service.preview({ tools_regex: '^web_search$', id: 'web', previousId: 'web' })
  assert.deepEqual(early, { matches: ['web_search'], shadowed: 0, error: null })
}

// ── 工具状态表：默认列出全部工具，并标注经过本插件处理后的实际状态 ──────────
{
  const { service } = build([
    { id: 'web', tools_regex: '^web_', description: 'x', status: 'request' },
    { id: 'browser', tools_regex: '^browser_', description: '', status: 'close' },
    { id: 'bash', tools_regex: '^bash$', description: '', status: 'open' },
  ])
  const snap = service.state()
  assert.deepEqual(
    snap.tools.map((row) => [row.name, row.state, row.group]),
    [
      ['bash', 'active', 'bash'], // open 组认领了，但状态仍是生效
      ['browser_open', 'hidden', 'browser'],
      ['todo_write', 'active', null], // 没被任何组认领
      ['web_fetch', 'ondemand', 'web'],
      ['web_search', 'ondemand', 'web'],
    ],
  )
  assert.equal(snap.hidden, 1)
  assert.equal(snap.onDemand, 2)
}

// ── 顺序即优先级：上移/下移会改变认领结果 ─────────────────────────────────
{
  const { editor, service } = build([
    { id: 'web', tools_regex: '^web_', description: '', status: 'close' },
    { id: 'one', tools_regex: '^web_search$', description: '', status: 'open' },
  ])
  // 一开始：web 认领 web_search + web_fetch，one 空手。
  assert.deepEqual(service.state().groups.map((row) => row.matched), [['web_fetch', 'web_search'], []])
  assert.equal(service.state().groups[1].shadowed, 1)

  await service.moveGroup({ id: 'one', direction: 'up' })
  assert.deepEqual(editor.state.writes.at(-1).map((row) => row.id), ['one', 'web'])
  // 现在 one 先认领 web_search，web 只剩 web_fetch —— 于是 close 挡不住 web_search 了。
  const after = service.state()
  assert.deepEqual(after.groups.map((row) => row.matched), [['web_search'], ['web_fetch']])
  assert.equal(after.hidden, 1)

  // 到底/到顶：不动，但仍算成功。
  await service.moveGroup({ id: 'one', direction: 'up' })
  assert.deepEqual(editor.state.writes.at(-1).map((row) => row.id), ['one', 'web'])
  await assert.rejects(() => service.moveGroup({ id: 'one', direction: 'sideways' }), /direction/)
  await assert.rejects(() => service.moveGroup({ id: 'gone', direction: 'up' }), /没有 id/)
}

// ── 没有可编辑行：state 标记只读，写入给出可执行的提示 ─────────────────────
{
  const editor = {
    documentPath: 'x',
    entries: () => [],
    edit: async () => {
      throw new Error('should not be called')
    },
  }
  const service = createPanelService(fakeCtx(editor), () => ({ groups: [], errors: [], controller: { notes: () => new Map() } }))
  assert.equal(service.state().editable, false)
  await assert.rejects(
    () => service.saveGroup({ id: 'x', tools_regex: '^x', description: '', status: 'open', previousId: '' }),
    /没有找到可编辑的插件行/,
  )
}

// ── wire 描述符：五个方法、入参 strict、命名空间与行 id 一致 ────────────────
{
  assert.equal(NAMESPACE, ROW_ID)
  const methods = MANIFEST.invocations.map((row) => row.method).sort()
  assert.deepEqual(methods, ['deleteGroup', 'moveGroup', 'preview', 'saveGroup', 'state'])
  assert.deepEqual(Object.keys(SYMBOLS).sort(), ['deleteGroup', 'moveGroup', 'preview', 'saveGroup'])
  for (const row of MANIFEST.invocations) {
    assert.equal(row.namespace, NAMESPACE)
    assert.equal(row.service, NAMESPACE)
    for (const parameter of row.parameters) {
      assert.equal(parameter.codec.mode, 'strict', `${row.method} 的入参必须是 strict codec`)
      assert.equal(typeof parameter.codec.create().parse, 'function')
    }
    assert.equal(row.result.mode, 'src-json')
  }
  // codec 真的在拦坏数据。
  const save = MANIFEST.invocations.find((row) => row.method === 'saveGroup')
  assert.throws(() => save.parameters[0].codec.create().parse({ id: 1 }), /id/)
  assert.deepEqual(
    save.parameters[0].codec.create().parse({ id: 'a', tools_regex: '^a', description: '', status: 'open', previousId: '' }),
    { id: 'a', tools_regex: '^a', description: '', status: 'open', previousId: '' },
  )
}

console.log('lib/panel-service.js: all assertions passed')
