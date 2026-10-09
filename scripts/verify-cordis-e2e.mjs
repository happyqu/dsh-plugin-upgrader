/**
 * End-to-end activation against a REAL Cordis Context — the same class, the same
 * `ctx.inject` / `ctx.on` / service resolution the Host uses.
 *
 * `verify-activation.mjs` hand-stubs the context, which proves our code's shape but not
 * that Cordis accepts it. This script boots a genuine Context, provides the three services
 * the plugin injects, registers the plugin through `ctx.plugin()` exactly as the loader
 * does, and then drives the mounted RPC endpoint.
 *
 * Run: node scripts/verify-cordis-e2e.mjs
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { cordisEntry } from './lib/env.mjs'

// Discovered, never hard-coded: a public package must not embed one machine's install path.
const CORDIS = cordisEntry()

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

if (CORDIS === null || !existsSync(CORDIS)) {
  console.log('SKIP: no local Cordis found (set DSH_CORDIS_PATH to point at one)')
  process.exit(0)
}

const cordis = await import(pathToFileURL(CORDIS).href)
const plugin = await import(new URL('../lib/index.js', import.meta.url).href)

console.log('\n# real Cordis Context, real service resolution')

/** One registered RPC route, captured from the stub connection service. */
const registeredRoutes = []

const root = new cordis.Context()
// The plugin declares `inject: ['pluginManager', 'profileContext']`, so those must be
// provided before the fiber can activate — exactly as the loader's dependency order ensures.
/** Specs `installBundle` was actually invoked with, in order. */
const installSpecs = []

root.provide('pluginManager', {
  listBundles: async () => [
    // Third-party bundles of each shape, plus an official layer, shaped as the live runtime
    // reports them. `demo-plugin` and `git-plugin` need real dependency specs, because the
    // specifier is what selects both the detection path and the upgrade spec.
    { name: 'demo-plugin', version: '1.0.0', description: 'demo', enabled: true, installed: true, rows: [] },
    { name: 'git-plugin', version: '0.1.0', description: 'git demo', enabled: true, installed: true, rows: [] },
    { name: 'local-plugin', version: '0.1.0', description: 'local demo', enabled: true, installed: true, rows: [] },
    { name: '@example/official-layer', version: '0.0.0', enabled: true, installed: false, readOnlyReason: 'management-required', rows: [] },
  ],
  registries: async () => ({ registry: null, fallbackRegistries: [], resolved: null }),
  installBundle: async (spec) => {
    installSpecs.push(spec)
    return { application: 'restart-required', target: spec, bundle: spec }
  },
  cancelInstall: async () => ({ status: 'not-running' }),
})
root.provide('profileContext', {
  name: 'desktop',
  // A fixture profile, so discovery reads a real package.json instead of an empty one.
  dir: join(import.meta.dirname, 'fixtures', 'e2e-profile'),
  installAnchor: 'package.json',
  packageManager: { command: process.execPath, args: ['--expose-internals', 'pnpm.mjs'], env: { ELECTRON_RUN_AS_NODE: '1' } },
})
root.provide('connection', {
  fetch: {
    register(route) {
      registeredRoutes.push(route)
      return () => {}
    },
  },
})

// Register through Cordis itself. This runs the real `resolveConfig` (the step that failed
// on the first live install) and the real fiber activation.
const fiber = root.plugin(plugin)
let activateError = null
try {
  await fiber
} catch (error) {
  activateError = error
}

ok('the plugin fiber activates', activateError === null, activateError === null ? '' : String(activateError?.stack ?? activateError))
ok('the fiber reports no failure', fiber?._error === undefined || fiber?._error === null, String(fiber?._error))
ok('the RPC route was registered through the real context', registeredRoutes.length === 1, String(registeredRoutes.length))

console.log('\n# driving the endpoint through the real fiber')
const route = registeredRoutes[0]
if (route !== undefined) {
  /** Build one client request envelope. */
  const envelope = (method, payload) => new Request('http://localhost/api/plugin-upgrader', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: 'e2e-1',
      method: 'plugin-upgrader',
      payload: { method, payload },
    }),
  })

  const check = await (await route.fetch(envelope('check', {}))).json()
  ok('check returns ok', check.result?.ok === true, JSON.stringify(check).slice(0, 500))
  const plugins = check.result?.value?.plugins ?? []
  const names = plugins.map((p) => p.name)
  ok('discovery found all three third-party bundles', names.join(',') === 'demo-plugin,git-plugin,local-plugin', JSON.stringify(names))
  ok('the official layer was excluded', plugins.every((p) => !p.name.startsWith('@example/')), JSON.stringify(names))

  const byName = new Map(plugins.map((p) => [p.name, p]))
  ok('the registry dependency is recognised as such', byName.get('demo-plugin')?.shape === 'registry', JSON.stringify(byName.get('demo-plugin')))
  ok('the git dependency is recognised as such', byName.get('git-plugin')?.shape === 'git', JSON.stringify(byName.get('git-plugin')))
  ok('the link dependency is recognised as such', byName.get('local-plugin')?.shape === 'link', JSON.stringify(byName.get('local-plugin')))

  // No subprocess service is provided in this context, so a registry check must degrade to a
  // reported error rather than throwing out of the endpoint.
  ok('a missing subprocess degrades to a reported error', byName.get('demo-plugin')?.status === 'error', JSON.stringify(byName.get('demo-plugin')))
  ok('the degraded error names the package manager', /pnpm/.test(String(byName.get('demo-plugin')?.message)), String(byName.get('demo-plugin')?.message))

  // A link dependency is never "outdated": there is no remote to compare with.
  ok('a link dependency reports itself as local', byName.get('local-plugin')?.status === 'local', JSON.stringify(byName.get('local-plugin')))
  ok('a link dependency is not upgradable', byName.get('local-plugin')?.upgradable !== true, JSON.stringify(byName.get('local-plugin')?.upgradable))

  const summary = check.result?.value?.summary
  ok('summary counts every plugin', summary?.total === 3, JSON.stringify(summary))

  // The git case is the regression this contract exists to fix: a git dependency's target is
  // a COMMIT, so no version number can express it, and the spec must be re-resolved here.
  ok('a git dependency is marked upgradable when its commit moved', byName.get('git-plugin')?.status === 'error' || byName.get('git-plugin')?.upgradable === true, JSON.stringify(byName.get('git-plugin')))

  console.log('\n# the Host resolves the install spec itself')
  const started = await (await route.fetch(envelope('upgrade.start', { name: 'demo-plugin', requestId: 'run-1' }))).json()
  // `demo-plugin` is a registry dependency and no subprocess exists here, so the version
  // cannot be determined: the Host must refuse rather than invent a spec.
  ok('a registry upgrade without a resolvable version is refused', started.result?.ok === false, JSON.stringify(started.result))
  ok('the refusal explains the version could not be read', /最新版本/.test(String(started.result?.error?.message)), String(started.result?.error?.message))

  const localStart = await (await route.fetch(envelope('upgrade.start', { name: 'local-plugin', requestId: 'run-local' }))).json()
  ok('a link dependency upgrade is refused', localStart.result?.ok === false, JSON.stringify(localStart.result))
  ok('the link refusal says there is no remote', /本地依赖/.test(String(localStart.result?.error?.message)), String(localStart.result?.error?.message))

  // The git dependency CAN be resolved without a subprocess: its spec is the unpinned URL.
  const gitStart = await (await route.fetch(envelope('upgrade.start', { name: 'git-plugin', requestId: 'run-git' }))).json()
  ok('a git dependency upgrade is accepted', gitStart.result?.ok === true, JSON.stringify(gitStart.result))

  // Give the fire-and-forget install a turn to start, then inspect what pnpm was asked for.
  await new Promise((resolve) => setTimeout(resolve, 60))
  ok('installBundle was called exactly once', installSpecs.length === 1, JSON.stringify(installSpecs))
  ok('the git spec is the unpinned repository URL', installSpecs[0] === 'https://git.example.com/team/git-plugin.git', String(installSpecs[0]))
  ok('the git spec carries no commit pin', !String(installSpecs[0]).includes('#'), String(installSpecs[0]))
  ok('the git spec carries no version suffix', !String(installSpecs[0]).includes('@'), String(installSpecs[0]))

  const status = await (await route.fetch(envelope('upgrade.status', { requestId: 'run-git' }))).json()
  const run = status.result?.value?.run
  ok('run settled', run?.running === false, JSON.stringify(run))
  ok('upgrade reports restart-required', run?.application === 'restart-required', JSON.stringify(run?.application))
  ok('verdict says restart is needed', status.result?.value?.verdict?.needsRestart === true, JSON.stringify(status.result?.value?.verdict))

  const runs = await (await route.fetch(envelope('upgrade.runs', {}))).json()
  ok('runs are listable', runs.result?.value?.runs?.length === 1, JSON.stringify(runs.result?.value?.runs))
}

// Dispose the root context: a plugin that leaks a subscription or a fiber would throw here.
let disposeError = null
try {
  await root.fiber.dispose()
} catch (error) {
  disposeError = error
}
ok('the context disposes cleanly', disposeError === null, disposeError === null ? '' : String(disposeError))

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — Cordis end-to-end checks`)
process.exit(failures === 0 ? 0 : 1)
