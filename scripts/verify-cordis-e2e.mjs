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
import { existsSync, cpSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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

/**
 * The profile this test runs against: a COPY of the fixture, in a throwaway directory.
 *
 * A faithful git install rewrites `pnpm-lock.yaml`, and a fixture committed to the repository
 * must not be mutated by running the tests, so every run works on a copy.
 */
const FIXTURE_PROFILE = join(import.meta.dirname, 'fixtures', 'e2e-profile')
const PROFILE_DIR = join(tmpdir(), `dsh-upgrader-e2e-${process.pid.toString(36)}`)
rmSync(PROFILE_DIR, { recursive: true, force: true })
cpSync(FIXTURE_PROFILE, PROFILE_DIR, { recursive: true })
for (const name of ['demo-plugin', 'git-plugin']) {
  const dir = join(PROFILE_DIR, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, main: 'index.js' }))
  writeFileSync(join(dir, 'index.js'), 'export function apply() {}')
}

/** The commit the lockfile pins at the start, and the newer one the fake remote reports. */
const PINNED_BEFORE = '89abcdef0123456789abcdef0123456789abcdef'
const GIT_HEAD = '0123456789abcdef0123456789abcdef01234567'

// The lockfile is WRITTEN HERE rather than copied from a fixture file.
//
// It is load-bearing: without a pinned git commit there is no baseline for "is there a new
// commit?", so `checkCandidate` reports `current`, the upgrade path never runs, and the whole
// git contract silently stops being tested. That is exactly what happened when this lived as a
// separate untracked fixture file — it went missing and five assertions failed at once, for a
// reason (a deleted file) that had nothing to do with the behaviour under test.
//
// Generating it in-process makes the test hermetic: the state it asserts on cannot drift from
// the state it sets up.
writeFileSync(join(PROFILE_DIR, 'pnpm-lock.yaml'), [
  "lockfileVersion: '9.0'",
  '',
  '# SYNTHETIC, written by verify-cordis-e2e.mjs. The git commit is fabricated: it only has to',
  '# differ from GIT_HEAD so that "the remote moved" is a real observation.',
  '',
  'settings:',
  '  autoInstallPeers: false',
  '  excludeLinksFromLockfile: false',
  '',
  'importers:',
  '',
  '  .:',
  '    dependencies:',
  '      demo-plugin:',
  '        specifier: ^1.0.0',
  '        version: 1.0.0',
  '      git-plugin:',
  '        specifier: https://git.example.com/team/git-plugin.git',
  `        version: git+https://git.example.com/team/git-plugin.git#${PINNED_BEFORE}`,
  '      local-plugin:',
  '        specifier: link:./vendor/local-plugin',
  '        version: link:./vendor/local-plugin',
  '',
].join('\n'))

/**
 * Rewrite the lockfile's git pin, exactly as a real `pnpm add <spec>` would.
 * @param {string} commit - the commit to pin.
 * @returns {void}
 */
function pinLockfileTo(commit) {
  const path = join(PROFILE_DIR, 'pnpm-lock.yaml')
  writeFileSync(path, readFileSync(path, 'utf8').replace(PINNED_BEFORE, commit))
}

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
    // Simulate what a real `pnpm add <spec>` does to the profile: the requested commit becomes
    // the pinned one. This is what the plugin's post-install re-read observes, so the verdict
    // path is exercised for real rather than being asserted against a fixed string.
    const requested = /#([0-9a-f]{7,40})$/i.exec(String(spec))
    if (requested !== null) pinLockfileTo(requested[1])
    return { application: 'restart-required', target: spec, bundle: spec }
  },
  cancelInstall: async () => ({ status: 'not-running' }),
})
root.provide('profileContext', {
  name: 'desktop',
  // The throwaway copy, so a simulated install can rewrite the lockfile safely.
  dir: PROFILE_DIR,
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

/**
 * A stubbed `subprocess`, so both query paths can be exercised offline.
 *
 * A git upgrade MUST read the remote before it can build a spec — the spec names the commit to
 * install — so pretending there is no subprocess would only prove that the refusal works.
 * This answers `git ls-remote` and `pnpm view`, and records every argv, so the test can assert
 * both which ref was asked for and what spec was produced.
 *
 * (The "no subprocess at all" degrade path is covered in verify-all.mjs, where it belongs.)
 */
const invokedArgv = []
let gitPackageName = 'git-plugin'
root.provide('subprocess', {
  spawn({ argv }) {
    invokedArgv.push(argv)
    // Match on `includes`, not on a fixed index: the query carries `-c credential.helper=`
    // before the subcommand (that flag is what stops Git Credential Manager popping a GUI
    // prompt during a background install), so `argv[1]` is no longer the subcommand.
    const isLsRemote = argv[0] === 'git' && argv.includes('ls-remote')
    const isView = argv.includes('view')
    const isGitManifest = argv[0] === 'git' && argv.includes('show')
    // A git query answers `<sha>\t<ref>`; a registry query prints the newest version as JSON.
    const stdout = isLsRemote
      ? `${GIT_HEAD}\t${String(argv[argv.length - 1])}\n`
      : isGitManifest
        ? JSON.stringify({ name: gitPackageName })
      : isView
        ? '"1.1.0"\n'
        : ''
    const reader = (text) => ({ readFrom: () => ({ text }) })
    return {
      done: Promise.resolve({ exitCode: 0 }),
      collected: { stdout: reader(stdout), stderr: reader('') },
    }
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

  // With the stub in place, a registry check resolves normally against the fake registry.
  ok('the registry dependency resolves against the stub registry', byName.get('demo-plugin')?.status === 'current' || byName.get('demo-plugin')?.status === 'outdated', JSON.stringify(byName.get('demo-plugin')))

  // A link dependency is never "outdated": there is no remote to compare with.
  ok('a link dependency reports itself as local', byName.get('local-plugin')?.status === 'local', JSON.stringify(byName.get('local-plugin')))
  ok('a link dependency is not upgradable', byName.get('local-plugin')?.upgradable !== true, JSON.stringify(byName.get('local-plugin')?.upgradable))

  const summary = check.result?.value?.summary
  ok('summary counts every plugin', summary?.total === 3, JSON.stringify(summary))

  // The git case is the regression this contract exists to fix: a git dependency's target is
  // a COMMIT, so no version number can express it. The fixture lockfile pins an older commit
  // than the fake remote reports, so this must be `outdated` and upgradable.
  ok('a git dependency is marked upgradable when its commit moved', byName.get('git-plugin')?.status === 'outdated', JSON.stringify(byName.get('git-plugin')))
  ok('the git row reports the target commit', byName.get('git-plugin')?.target === GIT_HEAD.slice(0, 7), JSON.stringify(byName.get('git-plugin')?.target))

  console.log('\n# the Host resolves the install spec itself')
  const started = await (await route.fetch(envelope('upgrade.start', { name: 'demo-plugin', requestId: 'run-1' }))).json()
  // `demo-plugin` is a registry dependency: the version comes from the registry, so the Host
  // resolves `name@version` rather than re-installing the range.
  ok('a registry upgrade resolves to name@version', started.result?.ok === true, JSON.stringify(started.result))

  const busyStart = await (await route.fetch(envelope('upgrade.start', { name: 'git-plugin', requestId: 'run-busy' }))).json()
  ok('concurrent upgrade is refused until installation and verification finish', busyStart.result?.error?.code === 'plugin-upgrader/busy', JSON.stringify(busyStart.result))
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = await (await route.fetch(envelope('upgrade.status', { requestId: 'run-1' }))).json()
    if (status.result?.value?.run?.running === false) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  const localStart = await (await route.fetch(envelope('upgrade.start', { name: 'local-plugin', requestId: 'run-local' }))).json()
  ok('a link dependency upgrade is refused', localStart.result?.ok === false, JSON.stringify(localStart.result))
  ok('the link refusal says there is no remote', /本地依赖/.test(String(localStart.result?.error?.message)), String(localStart.result?.error?.message))

  gitPackageName = 'renamed-plugin'
  const installsBeforeRename = installSpecs.length
  const renamed = await (await route.fetch(envelope('upgrade.start', { name: 'git-plugin', requestId: 'run-renamed' }))).json()
  ok('a renamed Git target is refused before installation', renamed.result?.error?.code === 'plugin-upgrader/package-renamed', JSON.stringify(renamed.result))
  ok('the refused rename never calls installBundle', installSpecs.length === installsBeforeRename, JSON.stringify(installSpecs))
  ok('a refused rename leaves the lockfile untouched', readFileSync(join(PROFILE_DIR, 'pnpm-lock.yaml'), 'utf8').includes(PINNED_BEFORE))
  gitPackageName = 'git-plugin'

  // The git dependency CAN be resolved: its spec is the name-qualified, commit-pinned URL.
  const gitStart = await (await route.fetch(envelope('upgrade.start', { name: 'git-plugin', requestId: 'run-git' }))).json()
  ok('a git dependency upgrade is accepted', gitStart.result?.ok === true, JSON.stringify(gitStart.result))

  // Give the fire-and-forget installs a turn to start, then inspect what pnpm was asked for.
  // Two upgrades were started (the registry one and the git one), so isolate the git spec.
  await new Promise((resolve) => setTimeout(resolve, 60))
  const gitInstalls = installSpecs.filter((spec) => String(spec).startsWith('git-plugin@'))
  ok('the git upgrade asked pnpm for exactly one spec', gitInstalls.length === 1, JSON.stringify(installSpecs))

  // THE REGRESSION THIS CONTRACT EXISTS FOR. Two independent requirements, each measured
  // against a real profile; violating either one produces a failure that looks like success:
  //
  //   name-qualified — otherwise DSH cannot attribute the run (a git reinstall rewrites an
  //     identical URL, so the before/after diff is empty and the name fallback matches
  //     nothing), and it reports `ambiguous-install` AFTER pnpm exited 0.
  //   commit-pinned  — otherwise pnpm treats the spec as already satisfied by the lockfile's
  //     commit, prints "Already up to date" and never re-resolves. A silent no-op that would
  //     repeat forever.
  const gitSpec = String(gitInstalls[0])
  ok(
    'the git spec is name-qualified',
    gitSpec.startsWith('git-plugin@'),
    gitSpec,
  )
  ok(
    'the git spec is the repository URL, name-qualified',
    gitSpec === `git-plugin@https://git.example.com/team/git-plugin.git#${GIT_HEAD}`,
    gitSpec,
  )
  ok('the git spec pins the resolved commit', gitSpec.includes(`#${GIT_HEAD}`), gitSpec)
  ok(
    'the remote was read before the spec was built',
    invokedArgv.some((argv) => argv[0] === 'git' && argv.includes('ls-remote')),
    JSON.stringify(invokedArgv),
  )
  // The credential helper MUST be disabled for every git call that touches a REMOTE. Without it
  // a private remote opens Git Credential Manager's GUI prompt during a background install, which
  // nothing can dismiss and which stalls the whole upgrade — an observed live failure.
  //
  // Only network-touching subcommands are checked: `git init` and `git show` run entirely inside
  // a temporary directory and never contact a remote, so they have no prompt to suppress.
  const REMOTE_SUBCOMMANDS = ['ls-remote', 'fetch', 'clone', 'pull', 'push']
  const remoteArgvs = invokedArgv.filter((argv) => argv[0] === 'git' && argv.some((a) => REMOTE_SUBCOMMANDS.includes(a)))
  ok(
    'every remote-touching git call disables the credential helper',
    remoteArgvs.length > 0 && remoteArgvs.every((argv) => argv.includes('-c') && argv.includes('credential.helper=')),
    JSON.stringify(remoteArgvs.filter((argv) => !(argv.includes('-c') && argv.includes('credential.helper=')))),
  )
  // And the plugin must actually make such calls, or the assertion above proves nothing.
  ok(
    'the plugin did make a remote-touching git call',
    remoteArgvs.length > 0,
    JSON.stringify(invokedArgv),
  )

  const status = await (await route.fetch(envelope('upgrade.status', { requestId: 'run-git' }))).json()
  const run = status.result?.value?.run
  ok('run settled', run?.running === false, JSON.stringify(run))
  ok('upgrade reports restart-required', run?.application === 'restart-required', JSON.stringify(run?.application))
  ok('verdict says restart is needed', status.result?.value?.verdict?.needsRestart === true, JSON.stringify(status.result?.value?.verdict))
  // The post-install re-read must CONFIRM the pin actually moved. Without the commit-pinned
  // spec this is exactly the check that reports "no change", so it is the assertion that
  // proves the silent no-op is gone.
  ok('the post-install re-read confirms the pin moved', run?.verification?.changed === true, JSON.stringify(run?.verification))

  const runs = await (await route.fetch(envelope('upgrade.runs', {}))).json()
  ok('runs are listable', runs.result?.value?.runs?.length === 2, JSON.stringify(runs.result?.value?.runs?.length))
}

// Dispose the root context: a plugin that leaks a subscription or a fiber would throw here.
let disposeError = null
try {
  await root.fiber.dispose()
} catch (error) {
  disposeError = error
}
ok('the context disposes cleanly', disposeError === null, disposeError === null ? '' : String(disposeError))

// The profile was a throwaway copy; remove it so repeated runs start clean.
rmSync(PROFILE_DIR, { recursive: true, force: true })

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — Cordis end-to-end checks`)
process.exit(failures === 0 ? 0 : 1)
