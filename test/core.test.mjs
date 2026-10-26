// 核心逻辑单测：配置归一化 + 匹配 + 隐藏集合判定。
// 只覆盖纯函数；宿主集成（restrict / 入口工具 / 面板）靠实际运行验证。
import assert from 'node:assert/strict'
import { normalizeGroups, matchNames, claimNames, STATUSES } from '../lib/config.js'
import { hiddenNames } from '../lib/tool-groups.js'

const NAMES = ['web_search', 'web_fetch', 'browser_open', 'browser_click', 'todo_write', 'bash', 'read']

// ── 归一化：正常配置 ────────────────────────────────────────────────────────
{
  const { groups, errors } = normalizeGroups([
    { id: 'web', tools_regex: '^web_', description: 'Web tools', status: 'request' },
    { id: 'browser', tools_regex: '^browser_', description: 'Browser tools', status: 'close' },
    { id: 'todo', tools_regex: '^todo_', description: 'Todo', status: 'open' },
  ])
  assert.deepEqual(errors, [])
  assert.equal(groups.length, 3)
  assert.deepEqual(matchNames(groups[0], NAMES), ['web_fetch', 'web_search'])
  assert.deepEqual(matchNames(groups[1], NAMES), ['browser_click', 'browser_open'])
  assert.deepEqual(STATUSES, ['open', 'close', 'request'])
}

// ── 归一化：非法配置全部收回 errors，不抛错 ─────────────────────────────────
{
  const { groups, errors } = normalizeGroups([
    null,
    { id: 'ok', tools_regex: '^bash$', description: 'x', status: 'close' },
    { id: 'bad name', tools_regex: '^x', description: '', status: 'open' },
    { id: 'run_code', tools_regex: '^x', description: '', status: 'open' },
    { id: 'dup', tools_regex: '^a', description: '', status: 'open' },
    { id: 'dup', tools_regex: '^b', description: '', status: 'open' },
    { id: 'badre', tools_regex: '([', description: '', status: 'open' },
    { id: 'badstatus', tools_regex: '^c', description: '', status: 'hidden' },
    { id: 'nodesc', tools_regex: '^d', description: '  ', status: 'request' },
    { id: 'noregex', description: '', status: 'open' },
  ])
  // 第一个 dup 合法保留，重复的第二个被拒；其它 7 条全部进 errors。
  assert.equal(groups.length, 2)
  assert.deepEqual(groups.map((group) => group.id), ['ok', 'dup'])
  assert.equal(errors.length, 8, JSON.stringify(errors, null, 2))
}

// ── 归一化：空 / 非法形态的 config 处理 ────────────────────────────────────
{
  assert.deepEqual(normalizeGroups(undefined), { groups: [], errors: [] })
  assert.deepEqual(normalizeGroups({}), { groups: [], errors: [] })
  // `{ groups: [...] }` 是替代写法，等价于根数组。
  assert.deepEqual(normalizeGroups({ groups: [] }), { groups: [], errors: [] })
  const wrapped = normalizeGroups({
    groups: [{ id: 'web', tools_regex: '^web_', description: 'Web', status: 'request' }],
  })
  assert.deepEqual(wrapped.errors, [])
  assert.equal(wrapped.groups.length, 1)
  assert.equal(wrapped.groups[0].id, 'web')
  // 两种都不像就报错。
  assert.equal(normalizeGroups({ items: [] }).errors.length, 1)
  assert.equal(normalizeGroups('nope').errors.length, 1)
}

// ── 隐藏集合：close 恒隐藏，request 展开后放行，open 不动 ───────────────────
{
  const { groups } = normalizeGroups([
    { id: 'web', tools_regex: '^web_', description: 'Web tools', status: 'request' },
    { id: 'browser', tools_regex: '^browser_', description: 'Browser tools', status: 'close' },
    { id: 'todo', tools_regex: '^todo_', description: 'Todo', status: 'open' },
  ])

  // 未展开：web + browser 都隐藏，todo 不动。
  assert.deepEqual(hiddenNames(groups, new Set(), NAMES), [
    'browser_click',
    'browser_open',
    'web_fetch',
    'web_search',
  ])

  // web 展开后只剩 browser。
  assert.deepEqual(hiddenNames(groups, new Set(['web']), NAMES), ['browser_click', 'browser_open'])

  // 空工具列表不应崩。
  assert.deepEqual(hiddenNames(groups, new Set(), []), [])
}

// ── 优先级：一个工具只归**第一个**匹配它的分组，后面的组不再参与 ─────────────
{
  // 用户的例子：先 open 认领 openviking_read，后面的 close 通配就吃不掉它。
  const names = ['mcp__openviking__read', 'mcp__openviking__write', 'web_search']
  const { groups } = normalizeGroups([
    { id: 'read', tools_regex: '^mcp__openviking__read$', description: '', status: 'open' },
    { id: 'rest', tools_regex: '^mcp__openviking__', description: '', status: 'close' },
  ])
  // read 认领了 read；rest 只捡剩下的 write。
  assert.deepEqual(claimNames(groups, names).get('read'), ['mcp__openviking__read'])
  assert.deepEqual(claimNames(groups, names).get('rest'), ['mcp__openviking__write'])
  // 所以只隐藏 write —— 没被前面的 open 保护的那一个。
  assert.deepEqual(hiddenNames(groups, new Set(), names), ['mcp__openviking__write'])

  // 顺序反过来，close 先吃光，后面的 open 什么也拿不到。
  const flipped = normalizeGroups([
    { id: 'rest', tools_regex: '^mcp__openviking__', description: '', status: 'close' },
    { id: 'read', tools_regex: '^mcp__openviking__read$', description: '', status: 'open' },
  ])
  assert.deepEqual(claimNames(flipped.groups, names).get('read'), [])
  assert.deepEqual(hiddenNames(flipped.groups, new Set(), names), [
    'mcp__openviking__read',
    'mcp__openviking__write',
  ])

  // 完全相同正则的两组：前面全拿，后面 0 个（顺序裁决，不按状态强弱）。
  const twins = normalizeGroups([
    { id: 'first', tools_regex: '^web_', description: 'x', status: 'request' },
    { id: 'second', tools_regex: '^web_', description: 'y', status: 'close' },
  ])
  assert.deepEqual(twins.errors, [])
  assert.deepEqual(claimNames(twins.groups, names).get('first'), ['web_search'])
  assert.deepEqual(claimNames(twins.groups, names).get('second'), [])
  // 因此 first 展开后 web_search 就真的出来了，second 无论如何都挡不住它。
  assert.deepEqual(hiddenNames(twins.groups, new Set(), names), ['web_search'])
  assert.deepEqual(hiddenNames(twins.groups, new Set(['first']), names), [])
}

// ── 重叠但不相邻的分组：只有第一个匹配的组认领 ──────────────────────────────
{
  const { groups } = normalizeGroups([
    { id: 'a', tools_regex: '^web_', description: 'x', status: 'request' },
    { id: 'mid', tools_regex: '^todo_', description: '', status: 'open' },
    { id: 'b', tools_regex: '_search$', description: 'y', status: 'close' },
  ])
  // web_search 被 a 先认领；b 的正则还能匹配 web_search，但那时它已经被拿走 → b 认领 0 个。
  assert.deepEqual(claimNames(groups, NAMES).get('a'), ['web_fetch', 'web_search'])
  assert.deepEqual(claimNames(groups, NAMES).get('b'), [])
  // 展开 a 后 b 没有能挡的东西，整组放出来。
  assert.deepEqual(hiddenNames(groups, new Set(['a']), NAMES), [])
}

// ── 匹配语义是 search 而非整串锚定 ──────────────────────────────────────────
{
  const { groups } = normalizeGroups([{ id: 'mid', tools_regex: 'eb_fe', description: '', status: 'close' }])
  assert.deepEqual(matchNames(groups[0], NAMES), ['web_fetch'])
}

console.log('lib/config.js + lib/tool-groups.js: all assertions passed')
