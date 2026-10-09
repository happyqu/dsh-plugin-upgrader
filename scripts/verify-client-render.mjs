/**
 * Client-half render test.
 *
 * The client half is where the user actually lives, and it is the easiest place to ship a
 * component that throws on first paint (a slot that blanks out is far worse than a failed
 * check). This script loads the real `lib/client.js` through a stub
 * `window.__ModuleLoader__`, then runs `apply()` and RENDERS every registered component with
 * a tiny React stand-in — no browser, no jsdom.
 *
 * The stand-in implements only what the components use: `createElement`, `useState`,
 * `useEffect`, `useCallback`, and `useRef`. Hooks are backed by a simple per-component state
 * array, so components execute their real logic, including their RPC calls.
 *
 * Run: node scripts/verify-client-render.mjs
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

let failures = 0

/**
 * Assert one expectation.
 * @param {string} label - what is asserted.
 * @param {unknown} condition - truthy when it holds.
 * @param {string} [detail] - context on failure.
 */
function ok(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === '' ? '' : `\n       ${detail}`}`)
  }
}

/**
 * Expand function components inside a tree, so the assertions see what React would paint.
 *
 * Child components (`h(PluginRow, {...})`) are elements whose `type` is a function; a real
 * reconciler invokes them. This harness does too, giving each its own hook cell. Components
 * that use hooks are supported because each gets a fresh cell and cursor.
 * @param {any} node - an element tree.
 * @param {number} [depth] - recursion guard.
 * @returns {any} the tree with function components expanded.
 */
function expand(node, depth = 0) {
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map((child) => expand(child, depth + 1))
  if (typeof node.type === 'function') {
    if (depth > 20) throw new Error('component recursion too deep')
    const cell = []
    const hooks = makeHooks(cell, [])
    const saved = { useState: React.useState, useEffect: React.useEffect, useCallback: React.useCallback, useRef: React.useRef }
    Object.assign(React, { useState: hooks.useState, useEffect: hooks.useEffect, useCallback: hooks.useCallback, useRef: hooks.useRef })
    let rendered
    try {
      rendered = node.type(node.props ?? {})
    } finally {
      Object.assign(React, saved)
    }
    return expand(rendered, depth + 1)
  }
  if (node.props?.children !== undefined) {
    return { ...node, props: { ...node.props, children: expand(node.props.children, depth + 1) } }
  }
  return node
}

/**
 * Render a React element tree to text, ignoring null children.
 * @param {any} node - an element from `h()`, or a string/number.
 * @returns {string} the flattened text.
 */
function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  const children = node.props?.children
  if (children === undefined) return ''
  return Array.isArray(children) ? children.map(textOf).join('') : textOf(children)
}

/**
 * Count elements matching a tag/class predicate.
 * @param {any} node - an element tree.
 * @param {(el: any) => boolean} match - the predicate.
 * @returns {number} the number of matches.
 */
function count(node, match) {
  if (node === null || node === undefined || typeof node !== 'object') return 0
  if (Array.isArray(node)) return node.reduce((sum, child) => sum + count(child, match), 0)
  const self = match(node) ? 1 : 0
  const children = node.props?.children
  const rest = children === undefined ? 0 : Array.isArray(children)
    ? children.reduce((sum, child) => sum + count(child, match), 0)
    : count(children, match)
  return self + rest
}

/**
 * Collect every element matching a predicate.
 * @param {any} node - an element tree.
 * @param {(el: any) => boolean} match - the predicate.
 * @param {any[]} [out] - accumulator.
 * @returns {any[]} matching elements.
 */
function collect(node, match, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) collect(child, match, out)
    return out
  }
  if (match(node)) out.push(node)
  const children = node.props?.children
  if (children !== undefined) {
    if (Array.isArray(children)) for (const child of children) collect(child, match, out)
    else collect(children, match, out)
  }
  return out
}

// ---------------------------------------------------------------- minimal React stand-in

/** Per-render hook cursor, reset before each component call. */
let hookCursor = 0
/** Persistent hook storage per component instance, keyed by the component's identity. */
const hookStore = new WeakMap()
/** Effects queued during the current render. */
let pendingEffects = []

/**
 * Create a tiny React substitute covering the hooks the client half uses.
 * @returns {object} the stand-in `React` namespace.
 */
function makeReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }
    },
    useState(initial) {
      const state = hookStore.get(hookCursor++ === 0 ? undefined : undefined)
      // The real bookkeeping happens in the render harness below; see `renderComponent`.
      return [typeof initial === 'function' ? initial() : initial, (next) => {
        if (typeof next === 'function') this.__pending.push(next)
      }]
    },
    useEffect(fn) {
      pendingEffects.push(fn)
    },
    useCallback(fn) {
      return fn
    },
    useRef(value) {
      return { current: value }
    },
  }
}

// The hook stand-in above needs instance-scoped storage, so the harness supplies real hooks
// by swapping `React` for a per-instance implementation before each component call.
/**
 * Build a hook set bound to one component instance's state cell.
 * @param {any[]} cell - the instance's persistent hook values.
 * @param {any[]} pending - the instance's queued setters.
 * @returns {object} hooks bound to that instance.
 */
function makeHooks(cell, pending) {
  let cursor = 0
  return {
    useState(initial) {
      const index = cursor++
      if (!(index in cell)) cell[index] = typeof initial === 'function' ? initial() : initial
      return [cell[index], (next) => {
        cell[index] = typeof next === 'function' ? next(cell[index]) : next
        pending.push(true)
      }]
    },
    useEffect(fn) {
      pendingEffects.push(fn)
    },
    useCallback(fn) {
      return fn
    },
    useRef(value) {
      const index = cursor++
      if (!(index in cell)) cell[index] = { current: value }
      return cell[index]
    },
    __reset: () => {
      cursor = 0
    },
  }
}

// ------------------------------------------------------------------------------- harness

const clientPath = join(import.meta.dirname, '..', 'lib', 'client.js')
const source = await readFile(clientPath, 'utf8')

/** Requests the client issued over the RPC channel during the render. */
const rpcCalls = []
/** Slot registrations the client made. */
const registrations = []
/** Stylesheets the client installed. */
const styleTags = []

/** The checked records, shared by the `check` handler so `only` can scope them. */
const CHECKED = [
  {
    name: 'demo-plugin',
    installedVersion: '1.0.0',
    latestVersion: '1.1.0',
    status: 'outdated',
    shape: 'registry',
    enabled: true,
    description: 'a demo plugin',
    message: '1.0.0 → 1.1.0',
    upgradable: true,
    target: '1.1.0',
  },
  {
    name: 'other-plugin',
    installedVersion: '2.0.0',
    latestVersion: '2.0.0',
    status: 'current',
    shape: 'registry',
    enabled: true,
    message: '已是最新版本',
    upgradable: false,
    target: null,
  },
  {
    name: 'local-plugin',
    installedVersion: '0.1.0',
    latestVersion: null,
    status: 'local',
    shape: 'link',
    enabled: true,
    message: '本地链接（link:），没有远端可比对，需自行管理',
    upgradable: false,
    target: null,
  },
  {
    // The exact record that produced the "升级到 null" button: a git dependency is outdated by
    // COMMIT and has no latestVersion at all. Commit hashes are invented.
    name: 'git-plugin',
    installedVersion: '0.1.0',
    latestVersion: null,
    latestCommit: '1111111111111111111111111111111111111111',
    pinnedCommit: '0000000000000000000000000000000000000000',
    status: 'outdated',
    shape: 'git',
    enabled: true,
    message: '远端有新提交（0000000 → 1111111）',
    upgradable: true,
    target: '1111111',
  },
]

/** Summarize records the way the Host does. */
function summarize(records) {
  return {
    total: records.length,
    outdated: records.filter((r) => r.status === 'outdated').length,
    current: records.filter((r) => r.status === 'current').length,
    local: records.filter((r) => r.status === 'local').length,
    error: records.filter((r) => r.status === 'error').length,
    unchecked: records.filter((r) => r.status === 'unchecked').length,
    ignored: 0,
  }
}

const connection = {
  rpc: {
    call(channel, endpoint, payload) {
      rpcCalls.push({ channel, endpoint, method: payload.method, payload: payload.payload })
      const only = payload.payload?.name

      // The roster: no network, every plugin "unchecked".
      if (payload.method === 'list') {
        const roster = CHECKED.map((r) => ({
          name: r.name,
          installedVersion: r.installedVersion,
          status: 'unchecked',
          shape: r.shape,
          enabled: r.enabled,
          description: r.description,
          message: r.shape === 'link' ? '本地依赖，没有远端可比对' : '尚未检查，点击「检查更新」',
          upgradable: false,
          target: null,
        }))
        return Promise.resolve({
          ok: true,
          value: { profile: 'C:/fake/profile', registry: null, ttlMs: 1000, checkedAt: null, summary: summarize(roster), plugins: roster },
        })
      }

      // The checks. Scope honored, so a one-plugin check must stay one-plugin.
      if (payload.method === 'check') {
        const plugins = typeof only === 'string' ? CHECKED.filter((r) => r.name === only) : CHECKED
        return Promise.resolve({
          ok: true,
          value: { profile: 'C:/fake/profile', registry: null, ttlMs: 1000, checkedAt: Date.now(), summary: summarize(plugins), plugins },
        })
      }

      if (payload.method === 'upgrade.start') {
        return Promise.resolve({
          ok: true,
          value: { requestId: `render-${rpcCalls.length}`, name: payload.payload?.name, phase: 'installing', running: true, logTail: [] },
        })
      }
      if (payload.method === 'upgrade.status') {
        return Promise.resolve({
          ok: true,
          value: {
            run: { requestId: payload.payload?.requestId, phase: 'done', running: false, logTail: [] },
            verdict: { state: 'restart-required', needsRestart: true, headline: '已更新，重启后生效', detail: '' },
          },
        })
      }
      if (payload.method === 'upgrade.cancel') {
        return Promise.resolve({ ok: true, value: { cancellation: { status: 'not-running' }, run: null } })
      }

      return Promise.resolve({ ok: false, error: { code: 'test/unknown-method', message: String(payload.method) } })
    },
  },
}

// Install the stub module loader. The client half calls this at module scope.
let loaded = null
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      loaded = registration
    },
  },
}
globalThis.document = {
  head: {
    appendChild(el) {
      styleTags.push(el)
    },
  },
  createElement() {
    return { textContent: '', setAttribute() {}, remove() {} }
  },
}

console.log('\n# client half: load through the ModuleLoader contract')
await import(`${new URL(`file:///${clientPath.replace(/\\/g, '/')}`).href}`)
// The id must equal the package name: `dsh-client-modules` strips a trailing `/client` from the
// specifier to derive it, so a mismatch means the bundle never attaches — silently.
const pkgName = JSON.parse(await readFile(join(import.meta.dirname, '..', 'package.json'), 'utf8')).name
ok('the bundle registered itself', loaded !== null, JSON.stringify(loaded?.id))
ok('the bundle id equals the package name', loaded?.id === pkgName, `${String(loaded?.id)} vs ${pkgName}`)

const React = makeReact()

const client = loaded.factory((spec) => {
  if (spec === 'react') return React
  throw new Error(`unexpected require: ${spec}`)
})

console.log('\n# apply(): slot registration')
/** A context stand-in recording slot registrations. */
const ctx = {
  connection,
  effect(fn) {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  slots: {
    inject(name, fn) {
      fn()
    },
    register(definition, Component) {
      registrations.push({ definition, Component })
      return () => {}
    },
  },
}

let applyError = null
try {
  client.apply(ctx)
} catch (error) {
  applyError = error
}
ok('apply() runs without throwing', applyError === null, String(applyError?.stack ?? applyError))
ok('installed exactly one stylesheet', styleTags.length === 1, String(styleTags.length))
ok('installed no DSH UI dependency', client.inject.includes('slots') && client.inject.includes('connection'), JSON.stringify(client.inject))

const slotNames = registrations.map((r) => r.definition.name).sort()
console.log(`  registered slots: ${slotNames.join(', ')}`)
ok('registered the upgrade-centre tab', slotNames.includes('settings.plugins.tab'))
ok('registered the detail badge', slotNames.includes('plugins.detail.badge'))
ok('registered the detail section', slotNames.includes('plugins.detail.section'))
ok('every registration names an id and order', registrations.every((r) => typeof r.definition.id === 'string' && r.definition.order !== undefined))
ok('the tab carries a label thunk', typeof registrations.find((r) => r.definition.name === 'settings.plugins.tab')?.definition.label === 'function')
ok('every registration injects the connection', registrations.every((r) => {
  const injected = r.definition.inject()
  return injected.connection === connection
}))

// ------------------------------------------------------------------- render each component

console.log('\n# rendering every registered component')
/** Render one component, flushing its effects and letting its RPC promises settle. */
async function renderComponent(registration, ownerProps) {
  const { Component, definition } = registration
  const cell = []
  const pending = []
  const hooks = makeHooks(cell, pending)
  // Bind the per-instance hooks by shadowing the stand-in's hook members for this call.
  const bound = { ...React, useState: hooks.useState, useEffect: hooks.useEffect, useCallback: hooks.useCallback, useRef: hooks.useRef }

  // The component closes over the module-scope `React`, so the harness temporarily swaps the
  // hook members on it; this is the only way to inject per-instance state without a real
  // reconciler. The hook cursor MUST reset per render, exactly as React calls hooks in a
  // stable order on every pass.
  const saved = { useState: React.useState, useEffect: React.useEffect, useCallback: React.useCallback, useRef: React.useRef }
  Object.assign(React, bound)

  let tree = null
  let error = null
  try {
    const injected = definition.inject ? definition.inject() : {}
    tree = Component({ ...injected, ...ownerProps, t: (key) => key })
  } catch (thrown) {
    error = thrown
  }

  // Flush effects (the components kick off their RPC checks here).
  for (const effect of pendingEffects) {
    try {
      const cleanup = effect()
      if (typeof cleanup === 'function') cleanup()
    } catch (thrown) {
      error = error ?? thrown
    }
  }
  // Let the RPC promises resolve, then re-render once with the settled state.
  await new Promise((resolve) => setTimeout(resolve, 30))
  pendingEffects = []
  hooks.__reset()
  try {
    const injected = definition.inject ? definition.inject() : {}
    tree = Component({ ...injected, ...ownerProps, t: (key) => key })
  } catch (thrown) {
    error = error ?? thrown
  }
  Object.assign(React, saved)
  return { tree, error }
}

/**
 * Render a component, click a button by its label, then re-render with the settled state.
 *
 * The tab now opens with a plain roster and only reaches its action buttons after a check, so a
 * test that wants to click "升级到 …" has to drive that sequence instead of assuming the buttons
 * exist on first paint.
 * @param {any} registration - the slot registration to render.
 * @param {any} ownerProps - owner props for the component.
 * @param {string} label - the exact button text to click.
 * @returns {Promise<{tree: any, error: any, clicked: number}>} the post-click tree.
 */
async function clickAndRender(registration, ownerProps, label) {
  const { Component, definition } = registration
  const cell = []
  const hooks = makeHooks(cell, [])
  const saved = { useState: React.useState, useEffect: React.useEffect, useCallback: React.useCallback, useRef: React.useRef }
  Object.assign(React, { useState: hooks.useState, useEffect: hooks.useEffect, useCallback: hooks.useCallback, useRef: hooks.useRef })

  let tree = null
  let error = null
  /** Render one pass against the SAME hook cell, so state persists across passes. */
  const pass = () => {
    hooks.__reset()
    pendingEffects = []
    const injected = definition.inject ? definition.inject() : {}
    tree = Component({ ...injected, ...ownerProps, t: (key) => key })
    for (const effect of pendingEffects) {
      try {
        const cleanup = effect()
        if (typeof cleanup === 'function') cleanup()
      } catch (thrown) {
        error = error ?? thrown
      }
    }
  }

  try {
    pass()
    await new Promise((resolve) => setTimeout(resolve, 30))

    let clicked = 0
    // Click, then re-render so the state the click set becomes visible. Two rounds covers
    // "check, then act on the checked result".
    for (let round = 0; round < 2; round++) {
      pass()
      const buttons = collect(expand(tree), (el) => el.type === 'button' && textOf(el) === label)
      if (buttons.length === 0) break
      for (const button of buttons) {
        if (typeof button.props?.onClick === 'function') button.props.onClick({ preventDefault() {}, stopPropagation() {} })
        clicked += 1
      }
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    pass()
    return { tree, error, clicked }
  } catch (thrown) {
    error = error ?? thrown
    return { tree, error, clicked: 0 }
  } finally {
    Object.assign(React, saved)
  }
}

for (const registration of registrations) {
  const name = registration.definition.name
  const ownerProps = name === 'settings.plugins.tab'
    ? {}
    : { subject: { kind: 'bundle', pkg: { name: 'demo-plugin', version: '1.0.0', installed: true, enabled: true, rows: [] } } }

  const { tree: rawTree, error } = await renderComponent(registration, ownerProps)
  ok(`${name}: renders without throwing`, error === null, String(error?.stack ?? error))

  const tree = error === null ? expand(rawTree) : null
  if (error === null && tree !== null) {
    const text = textOf(tree)
    if (name === 'settings.plugins.tab') {
      // After opening, the roster is present but NOTHING has been checked.
      ok('  the tab shows its heading', text.includes('升级中心'), text.slice(0, 200))
      ok('  the tab lists every managed plugin', text.includes('demo-plugin') && text.includes('git-plugin'), text.slice(0, 400))
      ok('  the tab shows plugins as unchecked', text.includes('未检查'), text.slice(0, 500))
      ok('  the tab prompts for a manual check', text.includes('点击') && text.includes('检查更新'), text.slice(0, 500))
      ok('  no "null" ever reaches the user', !text.includes('null'), text.slice(0, 600))
      const buttons = collect(tree, (el) => el.type === 'button')
      ok('  a "检查更新" button exists', buttons.some((b) => textOf(b).includes('检查更新')), buttons.map((b) => textOf(b)).join(' | '))
      ok('  no upgrade button before checking', !buttons.some((b) => /^升级/.test(textOf(b))), buttons.map((b) => textOf(b)).join(' | '))
    } else if (name === 'plugins.detail.badge') {
      // The badge checks only its own plugin, and the stub answers it.
      ok('  the badge shows the update', text.includes('可升级') && text.includes('1.1.0'), text)
    } else {
      ok('  the detail section shows both versions', text.includes('1.0.0') && text.includes('1.1.0'), text.slice(0, 300))
      ok('  the detail section names the shape', text.includes('registry'), text.slice(0, 300))
    }
  }
}

// The central behaviour change: opening the page must NOT run the broad network check, and the
// manual button must. This is asserted on the RPC log, not on rendered text.
console.log('\n# opening the page does not check everything')
const openCalls = rpcCalls.filter((c) => c.method === 'list' || c.method === 'check')
ok('opening the tab called list', openCalls.some((c) => c.method === 'list'), JSON.stringify(openCalls.map((c) => c.method)))
ok(
  'opening the tab ran NO unscoped check',
  !openCalls.some((c) => c.method === 'check' && c.payload?.name === undefined),
  JSON.stringify(openCalls.map((c) => c.payload)),
)
const badgeChecks = openCalls.filter((c) => c.method === 'check')
ok(
  'every check made on open was scoped to one plugin',
  badgeChecks.every((c) => typeof c.payload?.name === 'string'),
  JSON.stringify(badgeChecks.map((c) => c.payload)),
)

console.log('\n# the manual "检查更新" button checks everything')
const tabReg = registrations.find((r) => r.definition.name === 'settings.plugins.tab')
if (tabReg !== undefined) {
  const before = rpcCalls.length
  const { tree: rawTab } = await renderComponent(tabReg, {})
  const tabTree = expand(rawTab)
  const checkButtons = collect(tabTree, (el) => el.type === 'button' && textOf(el) === '检查更新')
  ok('the "检查更新" button is present', checkButtons.length === 1, String(checkButtons.length))
  for (const button of checkButtons) {
    if (typeof button.props?.onClick === 'function') button.props.onClick({ preventDefault() {}, stopPropagation() {} })
  }
  await new Promise((resolve) => setTimeout(resolve, 40))

  const issued = rpcCalls.slice(before)
  const unlocks = issued.filter((c) => c.method === 'check')
  ok('clicking "检查更新" issued a check', unlocks.length > 0, JSON.stringify(unlocks.map((c) => c.payload)))
  ok(
    'the manual check was UNSCOPED (every plugin)',
    unlocks.some((c) => c.method === 'check' && c.payload?.name === undefined),
    JSON.stringify(unlocks.map((c) => c.payload)),
  )
}

console.log('\n# after a check, clicking "升级" (the null-label regression path)')
const tabRegistration = registrations.find((r) => r.definition.name === 'settings.plugins.tab')
if (tabRegistration !== undefined) {
  // Drive the real sequence: open, click 检查更新, and inspect what the tab then offers.
  const { tree: checkedTreeRaw, error: checkError } = await clickAndRender(tabRegistration, {}, '检查更新')
  ok('the check-and-render sequence did not throw', checkError === null, String(checkError?.stack ?? checkError))

  // Child components (`h(PluginRow, …)`) only paint once expanded.
  const checkedTree = expand(checkedTreeRaw)
  const checkedText = textOf(checkedTree)
  ok('the checked tab shows the git target commit', checkedText.includes('1111111'), checkedText.slice(0, 600))
  ok('the checked tab labels the git row by commit', checkedText.includes('升级到 1111111'), checkedText.slice(0, 600))
  ok('no "null" reaches the user after checking', !checkedText.includes('null'), checkedText.slice(0, 800))

  const upgradeButtons = collect(checkedTree, (el) => el.type === 'button' && /升级到|^升级$/.test(textOf(el)))
  console.log(`  upgrade buttons: ${upgradeButtons.map((b) => textOf(b)).join(' | ')}`)
  ok('an upgrade button exists for the registry plugin', upgradeButtons.some((b) => textOf(b) === '升级到 1.1.0'), upgradeButtons.map((b) => textOf(b)).join(' | '))
  ok('an upgrade button exists for the git plugin', upgradeButtons.some((b) => textOf(b) === '升级到 1111111'), upgradeButtons.map((b) => textOf(b)).join(' | '))
  ok('every upgrade button label is free of "null"', upgradeButtons.every((b) => !textOf(b).includes('null')), upgradeButtons.map((b) => textOf(b)).join(' | '))

  for (const button of upgradeButtons) {
    const onClick = button.props?.onClick
    if (typeof onClick === 'function') {
      try {
        onClick({ preventDefault() {}, stopPropagation() {} })
      } catch (error) {
        failures += 1
        console.log(`  FAIL clicking "${textOf(button)}" threw: ${String(error?.stack ?? error)}`)
      }
    }
  }
  // Let the RPC calls the clicks started reach the stub.
  await new Promise((resolve) => setTimeout(resolve, 40))
}

console.log('\n# the components actually talked to the host')
ok('an RPC call was issued', rpcCalls.length > 0, JSON.stringify(rpcCalls))
ok('the call used the right channel', rpcCalls.every((c) => c.channel === '/api'), JSON.stringify(rpcCalls.map((c) => c.channel)))
ok('the call used the right endpoint', rpcCalls.every((c) => c.endpoint === 'plugin-upgrader'), JSON.stringify(rpcCalls.map((c) => c.endpoint)))
ok('the call asked for a check', rpcCalls.some((c) => c.method === 'check'), JSON.stringify(rpcCalls.map((c) => c.method)))
// The client sends the NAME as authoritative; a `version` may accompany it ONLY for a real
// semver target, so a refreshed browser keeps working against a pre-change Host half. A git
// target (a commit) must never be sent as a version.
const startCalls = rpcCalls.filter((c) => c.method === 'upgrade.start')
ok('clicking upgrade issued upgrade.start calls', startCalls.length >= 2, JSON.stringify(startCalls.map((c) => c.payload)))
ok('upgrade.start always names the package', startCalls.every((c) => typeof c.payload?.name === 'string'), JSON.stringify(startCalls.map((c) => c.payload)))
ok(
  'any version sent is a real semver',
  startCalls.every((c) => c.payload?.version === undefined || /^\d+\.\d+\.\d+/.test(c.payload.version)),
  JSON.stringify(startCalls.map((c) => c.payload)),
)
ok(
  'the registry plugin sent its version',
  startCalls.some((c) => c.payload?.name === 'demo-plugin' && c.payload?.version === '1.1.0'),
  JSON.stringify(startCalls.map((c) => c.payload)),
)
ok(
  'a git commit is never sent as a version',
  !startCalls.some((c) => typeof c.payload?.version === 'string' && c.payload.version.includes('1111111')),
  JSON.stringify(startCalls.map((c) => c.payload)),
)
ok(
  'the git plugin sent only its name',
  startCalls.some((c) => c.payload?.name === 'git-plugin' && c.payload?.version === undefined),
  JSON.stringify(startCalls.map((c) => c.payload)),
)

// A component must render nothing rather than throw on a subject it has no data for.
console.log('\n# defensive rendering')
const badge = registrations.find((r) => r.definition.name === 'plugins.detail.badge')
const weirdSubjects = [
  { kind: 'item', id: 'x' },
  { kind: 'bundle' },
  { kind: 'row', pkg: {}, row: {} },
  null,
  undefined,
  {},
]
for (const subject of weirdSubjects) {
  const { tree, error } = await renderComponent(badge, { subject })
  ok(
    `badge tolerates subject ${JSON.stringify(subject) ?? 'undefined'}`,
    error === null && (tree === null || typeof tree === 'object'),
    String(error?.stack ?? error),
  )
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — client render checks`)
process.exit(failures === 0 ? 0 : 1)
