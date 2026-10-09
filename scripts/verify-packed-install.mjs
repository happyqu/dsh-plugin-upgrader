/**
 * Install the packed tarball into an ISOLATED profile and prove it activates.
 *
 * `npm pack` proves the file list; only a real install proves the package is loadable. This
 * script builds a throwaway profile directory, installs the tarball into it with the desktop's
 * own pnpm, and then mounts the INSTALLED copy through real Cordis — so a broken `exports`,
 * a wrong `dsh.bundle.patch` path, or a stale package name fails here rather than in the user's
 * profile.
 *
 * Deliberately does NOT touch the live desktop profile.
 *
 * Run: node scripts/verify-packed-install.mjs
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { cordisEntry, pnpmEntry } from './lib/env.mjs'

// Discovered, never hard-coded: a public package must not embed one machine's install path.
const CORDIS = cordisEntry()
const PNPM_MJS = pnpmEntry()
const ROOT = join(import.meta.dirname, '..')
const SANDBOX = join(tmpdir(), 'upgrader-pack-check')

let failures = 0

/** Assert one expectation. */
function ok(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === '' ? '' : `\n       ${detail}`}`)
  }
}

// The install half needs the desktop app's pnpm; the activation half needs Cordis. Without
// either, only the packaging assertions can run, so say so rather than reporting a false failure.
if (PNPM_MJS === null) {
  console.log('SKIP: no local pnpm entry point found (set DSH_INSTALL_ROOT or DSH_PNPM_PATH)')
  process.exit(0)
}

console.log(`sandbox profile: ${SANDBOX}`)

// ------------------------------------------------------------------ build the tarball fresh
rmSync(SANDBOX, { recursive: true, force: true })
mkdirSync(SANDBOX, { recursive: true })

// Run npm's JS entry with this same node binary. Spawning `npm`/`npm.cmd` directly is not
// reliable here: Windows needs a shell for `.cmd`, and Node 24 refuses to spawn one without it,
// while `shell: true` would concatenate arguments unescaped. Calling the CLI file avoids both.
const NPM_CLI = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
ok('npm CLI entry is locatable', existsSync(NPM_CLI), NPM_CLI)

const packed = spawnSync(process.execPath, [NPM_CLI, 'pack', '--json'], {
  cwd: ROOT,
  encoding: 'utf8',
  env: { ...process.env, npm_config_registry: 'https://registry.npmjs.org/' },
})
if (packed.status !== 0 || !packed.stdout) {
  console.log(`FAIL npm pack (status ${String(packed.status)})`)
  console.log(String(packed.stderr ?? '').slice(-2000))
  process.exit(1)
}
const filename = JSON.parse(packed.stdout).at(-1).filename
const tarball = join(ROOT, filename)
ok('npm pack produced a tarball', existsSync(tarball), tarball)

// ------------------------------------------------------- an empty profile that selects it
const pkgName = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name
writeFileSync(join(SANDBOX, 'package.json'), `${JSON.stringify({
  name: 'pack-check-profile',
  private: true,
  dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', pkgName] } },
}, null, 2)}\n`)
writeFileSync(join(SANDBOX, 'cordis.yml'), '[]\n')
writeFileSync(join(SANDBOX, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')

console.log('\n# installing the tarball into an isolated profile')
const install = spawnSync(process.execPath, [
  '--expose-internals', PNPM_MJS,
  'add', `file:${tarball}`,
  '--dir', SANDBOX,
  '--ignore-workspace-root-check',
], {
  encoding: 'utf8',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
})
ok('pnpm add succeeded', install.status === 0, `${install.stdout ?? ''}${install.stderr ?? ''}`.slice(-1500))

const installedDir = join(SANDBOX, 'node_modules', '@happyqu', 'dsh-plugin-upgrader')
ok('the scoped package landed at its scoped path', existsSync(installedDir), installedDir)

// ------------------------------------------------------------- the installed manifest is sane
console.log('\n# the installed package resolves')
const installedPkg = JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8'))
ok('installed name is the scoped name', installedPkg.name === pkgName, installedPkg.name)
ok('installed version matches', installedPkg.version === JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version, installedPkg.version)
ok('no scripts/PLAN.md shipped', !existsSync(join(installedDir, 'PLAN.md')) && !existsSync(join(installedDir, 'scripts')))

// The patch path is what the loader reads to compose the profile tree; a wrong path means the
// bundle installs but contributes nothing.
const patchPath = join(installedDir, installedPkg.dsh.bundle.patch)
ok('dsh.bundle.patch resolves inside the package', existsSync(patchPath), patchPath)
const patchText = readFileSync(patchPath, 'utf8')
ok('the shipped patch names the scoped package', patchText.includes(`'${pkgName}'`), patchText)

const hostEntry = join(installedDir, 'lib', 'index.js')
const clientEntry = join(installedDir, 'lib', 'client.js')
ok('the declared host entry exists', existsSync(hostEntry), hostEntry)
ok('the declared client entry exists', existsSync(clientEntry), clientEntry)

// ------------------------------------------------------- activate the INSTALLED copy for real
if (CORDIS === null || !existsSync(CORDIS)) {
  console.log('\n# SKIP real Cordis activation (no local Cordis found; set DSH_CORDIS_PATH)')
  rmSync(tarball, { force: true })
  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — packed-install checks (packaging only)`)
  process.exit(failures === 0 ? 0 : 1)
}

console.log('\n# activating the INSTALLED copy through real Cordis')
const cordis = await import(pathToFileURL(CORDIS).href)
// Import the installed file, not the working copy: that is what the loader would do.
const plugin = await import(pathToFileURL(hostEntry).href)

ok('the installed host half exports apply()', typeof plugin.apply === 'function')
ok('the installed host half declares inject', Array.isArray(plugin.inject), JSON.stringify(plugin.inject))
ok('the installed host half exports a Standard Schema Config', typeof plugin.Config?.['~standard']?.validate === 'function')

const routes = []
const root = new cordis.Context()
root.provide('pluginManager', {
  listBundles: async () => [
    { name: 'some-third-party', version: '1.0.0', enabled: true, installed: true, rows: [] },
    { name: pkgName, version: installedPkg.version, enabled: true, installed: true, rows: [] },
    { name: '@deepseek-ai/dsh-base', version: '0.2.0-rc.2', enabled: true, installed: false, readOnlyReason: 'management-required', rows: [] },
  ],
  registries: async () => ({ registry: null, fallbackRegistries: [], resolved: null }),
  installBundle: async () => ({ application: 'restart-required' }),
  cancelInstall: async () => ({ status: 'not-running' }),
})
root.provide('profileContext', { name: 'pack-check', dir: SANDBOX, installAnchor: 'package.json' })
root.provide('connection', { fetch: { register: (route) => { routes.push(route); return () => {} } } })

let activateError = null
try {
  await root.plugin(plugin)
} catch (error) {
  activateError = error
}
ok('the installed copy activates', activateError === null, String(activateError?.stack ?? activateError))
ok('it registered its RPC route', routes.length === 1, String(routes.length))

// The roster must list the other plugin and NOT itself.
if (routes[0] !== undefined) {
  const response = await routes[0].fetch(new Request('http://localhost/api/plugin-upgrader', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'pack', method: 'plugin-upgrader', payload: { method: 'list', payload: {} } }),
  }))
  const body = await response.json()
  const names = (body.result?.value?.plugins ?? []).map((p) => p.name)
  ok('the roster lists the third-party plugin', names.includes('some-third-party'), JSON.stringify(names))
  ok('the roster excludes the official layer', !names.some((n) => n.startsWith('@deepseek-ai/')), JSON.stringify(names))
  ok('the roster EXCLUDES ITSELF', !names.includes(pkgName), JSON.stringify(names))
}

await root.fiber.dispose()
rmSync(tarball, { force: true })

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — packed-install checks`)
process.exit(failures === 0 ? 0 : 1)
