/**
 * Real activation test: load this plugin through the ACTUAL Cordis runtime the Host uses.
 *
 * `plugin_manager install_bundle` proves packaging and the patch layer, but it cannot prove
 * the Host half survives Cordis' own load sequence — and it caches ESM modules, so a fixed
 * module can keep reporting the old failure until the app restarts. This script replays the
 * exact sequence a fiber runs:
 *
 *   resolve plugin -> read plugin.Config -> fiber._resolveConfig(config) -> apply(ctx)
 *
 * The `Config` step is the one that bit us: Cordis calls `runtime.Config['~standard'].validate`
 * whenever a plugin exports a `Config`, so exporting a plain object (rather than a schemastery
 * schema) aborts activation with "Cannot read properties of undefined (reading 'validate')".
 *
 * Stub services stand in for `pluginManager` and `profileContext`, so this exercises the real
 * wiring (`inject`, `apply`, RPC registration) without touching the live profile.
 *
 * Run: node scripts/verify-activation.mjs
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { cordisEntry } from './lib/env.mjs'

// Discovered, never hard-coded: a public package must not embed one machine's install path.
const CORDIS = cordisEntry()
const PLUGIN = new URL('../lib/index.js', import.meta.url).href

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

console.log('\n# the Config contract Cordis enforces')
const plugin = await import(PLUGIN)
console.log(`  exports: ${Object.keys(plugin).join(', ')}`)
ok('exports apply()', typeof plugin.apply === 'function')
ok('exports name', typeof plugin.name === 'string')
ok('declares inject', Array.isArray(plugin.inject))
ok(
  'inject has no static connection (headless safety)',
  !plugin.inject.includes('connection'),
  JSON.stringify(plugin.inject),
)

// The Config export must be a STANDARD SCHEMA, never a plain object: Cordis calls
// `Config['~standard'].validate(config)` and a plain object aborts activation.
ok('exports a Config schema', typeof plugin.Config === 'object' && plugin.Config !== null)
ok(
  'the Config schema is a Standard Schema',
  typeof plugin.Config?.['~standard']?.validate === 'function',
  JSON.stringify(Object.keys(plugin.Config ?? {})),
)
ok(
  'the Config schema declares a version and vendor',
  plugin.Config?.['~standard']?.version === 1 && typeof plugin.Config?.['~standard']?.vendor === 'string',
  JSON.stringify(plugin.Config?.['~standard']),
)

if (CORDIS === null || !existsSync(CORDIS)) {
  console.log('\n# SKIP real Cordis activation (no local Cordis found)')
  console.log('  set DSH_CORDIS_PATH to point at one')
  process.exit(failures === 0 ? 0 : 1)
}

console.log('\n# real Cordis activation')
const cordis = await import(pathToFileURL(CORDIS).href)

// Replay Cordis' OWN schema step (`resolveConfig`) with the real runtime object.
const withEmpty = cordis.resolveConfig({ Config: plugin.Config }, {})
ok('resolveConfig fills defaults for an empty config', withEmpty.checkTtlMs === 21600000 && withEmpty.concurrency === 3, JSON.stringify(withEmpty))
ok('resolveConfig defaults the ignore list to empty', Array.isArray(withEmpty.ignored) && withEmpty.ignored.length === 0, JSON.stringify(withEmpty.ignored))

const withValues = cordis.resolveConfig({ Config: plugin.Config }, { checkTtlMs: 1000, concurrency: 5, ignored: ['a', 'b'] })
ok('resolveConfig honours supplied values', withValues.checkTtlMs === 1000 && withValues.concurrency === 5, JSON.stringify(withValues))
ok('resolveConfig keeps the ignore list', withValues.ignored.join(',') === 'a,b', JSON.stringify(withValues.ignored))

const filtered = cordis.resolveConfig({ Config: plugin.Config }, { ignored: ['ok', '', '  ', 42] })
ok('resolveConfig drops non-string ignore entries', filtered.ignored.join(',') === 'ok', JSON.stringify(filtered.ignored))

let validationThrew = null
try {
  cordis.resolveConfig({ Config: plugin.Config }, { concurrency: -1 })
} catch (error) {
  validationThrew = error
}
ok('resolveConfig rejects a negative concurrency', validationThrew !== null && /invalid config/.test(String(validationThrew?.message)), String(validationThrew?.message))

validationThrew = null
try {
  cordis.resolveConfig({ Config: plugin.Config }, { ignored: 'not-an-array' })
} catch (error) {
  validationThrew = error
}
ok('resolveConfig rejects a non-array ignore list', validationThrew !== null, String(validationThrew?.message))

// Negative control: prove this check has teeth. A plain-object Config is precisely the
// mistake that aborted activation on the first real install, so Cordis must reject it.
let configThrew = null
try {
  cordis.resolveConfig({ Config: { checkTtlMs: 1 } }, {})
} catch (error) {
  configThrew = error
}
ok(
  'a plain-object Config is rejected by Cordis (negative control)',
  configThrew !== null && /validate/.test(String(configThrew?.message)),
  String(configThrew?.message),
)

/** Collect the endpoints and services a plugin half registers, so asserts can inspect them. */
const registered = { routes: [], events: [], injected: [] }

const fakeConnection = {
  fetch: {
    register(route) {
      registered.routes.push(route)
      return () => {}
    },
  },
}
// A live-shaped `profileContext`: `packageManager` present, as the desktop host supplies it.
const fakeProfile = {
  name: 'desktop',
  dir: process.cwd(),
  installAnchor: join(process.cwd(), 'package.json'),
  packageManager: { command: process.execPath, args: ['--expose-internals', 'pnpm.mjs'], env: { ELECTRON_RUN_AS_NODE: '1' } },
}
const fakePluginManager = {
  listBundles: async () => [],
  registries: async () => ({ registry: 'https://registry.npmmirror.com/', fallbackRegistries: [], resolved: null }),
}

const stubs = new Map([
  ['pluginManager', fakePluginManager],
  ['profileContext', fakeProfile],
  ['connection', fakeConnection],
])

/** Minimal context: real enough for apply() to wire itself up, with no Cordis internals. */
const ctx = {
  config: undefined,
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  pluginManager: fakePluginManager,
  profileContext: fakeProfile,
  get(name) {
    return stubs.get(name)
  },
  on(event, handler) {
    registered.events.push({ event, handler })
    return () => {}
  },
  emit() {},
  effect(fn) {
    // `ctx.effect` runs the callback and keeps its disposer; the styles install is client-side,
    // so a no-op here is faithful.
    const dispose = typeof fn === 'function' ? fn() : undefined
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  },
  inject(names, callback) {
    registered.injected.push([...names])
    // Cordis only calls the callback once every named service exists.
    const available = names.every((n) => stubs.has(n))
    if (!available) return
    const scoped = {
      connection: stubs.get('connection'),
      get: (n) => stubs.get(n),
    }
    callback(scoped)
  },
}

let threw = null
try {
  plugin.apply(ctx)
} catch (error) {
  threw = error
}
ok('apply() runs without throwing', threw === null, threw === null ? '' : String(threw?.stack ?? threw))
ok('registered the optional connection injection', registered.injected.some((n) => n.includes('connection')), JSON.stringify(registered.injected))
ok('registered exactly one RPC route', registered.routes.length === 1, JSON.stringify(registered.routes.map((r) => r.path)))
ok('route path is /api/plugin-upgrader', registered.routes[0]?.path === '/api/plugin-upgrader', String(registered.routes[0]?.path))
ok('route accepts POST', registered.routes[0]?.methods?.includes('POST'), JSON.stringify(registered.routes[0]?.methods))
ok('route buffers its body', registered.routes[0]?.requestBody === 'buffered', String(registered.routes[0]?.requestBody))

console.log('\n# the RPC endpoint answers the real client envelope')
const route = registered.routes[0]
if (route !== undefined) {
  /** Build a client request exactly as the browser connection sends it. */
  const request = (method, payload) => new Request('http://localhost/api/plugin-upgrader', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'plugin-upgrader', payload: { method, payload } }),
  })

  const badContentType = await route.fetch(new Request('http://localhost/api/plugin-upgrader', { method: 'POST' }))
  ok('rejects a non-JSON content type with 415', badContentType.status === 415, String(badContentType.status))

  const getResponse = await route.fetch(new Request('http://localhost/api/plugin-upgrader', { method: 'GET' }))
  ok('rejects GET with 405', getResponse.status === 405, String(getResponse.status))

  const malformed = await route.fetch(new Request('http://localhost/api/plugin-upgrader', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ not json',
  }))
  ok('rejects a malformed body with 400', malformed.status === 400, String(malformed.status))

  const wrongEnvelope = await route.fetch(new Request('http://localhost/api/plugin-upgrader', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'nope', rpcId: 'x', method: 'plugin-upgrader', payload: {} }),
  }))
  const wrongBody = await wrongEnvelope.json()
  ok('rejects a bad envelope', wrongBody.result?.ok === false, JSON.stringify(wrongBody))

  const unknown = await (await route.fetch(request('nope.method', {}))).json()
  ok('unknown method is reported, not thrown', unknown.result?.ok === false, JSON.stringify(unknown))
  ok('reply echoes the rpcId', unknown.rpcId === 'r1', String(unknown.rpcId))

  // `list` is the roster: no network, safe on page open.
  const roster = await (await route.fetch(request('list', {}))).json()
  ok('list succeeds against a stub profile', roster.result?.ok === true, JSON.stringify(roster).slice(0, 400))
  ok('list reports a summary', typeof roster.result?.value?.summary?.total === 'number', JSON.stringify(roster.result?.value?.summary))
  ok('list reports nothing checked yet', roster.result?.value?.checkedAt === null, JSON.stringify(roster.result?.value?.checkedAt))
  ok('list has no plugins for an empty profile', roster.result?.value?.plugins?.length === 0, JSON.stringify(roster.result?.value?.plugins))

  // `check` is the network half, and must be reachable unscoped (the manual button) and scoped
  // (one row) without a transport error either way.
  const check = await (await route.fetch(request('check', {}))).json()
  ok('an unscoped check is answered for an empty profile', check.result?.ok === false, JSON.stringify(check).slice(0, 400))
  ok(
    'the unscoped empty answer explains itself',
    /没有可检查的第三方插件/.test(String(check.result?.error?.message)),
    String(check.result?.error?.message),
  )
  const scoped = await (await route.fetch(request('check', { name: 'no-such-plugin' }))).json()
  ok('a scoped check for an unknown plugin is refused', scoped.result?.ok === false, JSON.stringify(scoped).slice(0, 400))
  ok(
    'the scoped refusal names the plugin',
    /no-such-plugin/.test(String(scoped.result?.error?.message)),
    String(scoped.result?.error?.message),
  )

  const badStart = await (await route.fetch(request('upgrade.start', { name: 'a;rm -rf /' }))).json()
  ok('rejects a shell-metacharacter package name', badStart.result?.ok === false, JSON.stringify(badStart.result))
  const missingName = await (await route.fetch(request('upgrade.start', {}))).json()
  ok('rejects a request with no package name', missingName.result?.ok === false, JSON.stringify(missingName.result))
  // The Host resolves the install spec itself, so an unmanaged name must be refused rather
  // than blindly handed to pnpm.
  const unmanaged = await (await route.fetch(request('upgrade.start', { name: 'no-such-plugin' }))).json()
  ok('refuses a name that is not a managed plugin', unmanaged.result?.ok === false, JSON.stringify(unmanaged.result))
  ok(
    'the refusal names the reason',
    /不在可管理的第三方插件列表/.test(String(unmanaged.result?.error?.message)),
    String(unmanaged.result?.error?.message),
  )
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — activation checks`)
process.exit(failures === 0 ? 0 : 1)
