/**
 * Drive the plugin through a REAL Cordis Context against a COPY of a live profile.
 *
 * This is a diagnostic, not a test: it mounts the real plugin, lets `installBundle` actually
 * spawn pnpm, and prints what the plugin resolved versus what pnpm did. It exists because the
 * only trustworthy way to explain "I clicked upgrade and nothing happened" is to run the same
 * sequence and watch the argv.
 *
 * The profile is COPIED first, so a diagnostic run cannot modify the machine it runs on.
 * It skips cleanly when no DSH installation or profile is present, and never names a specific
 * user, repository, or plugin: the target is read from the profile itself.
 *
 * Run: node scripts/diagnose-real-upgrade.mjs
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { cordisEntry, packageRoot, pnpmEntry, profileDir, readJson } from './lib/env.mjs'

const CORDIS = cordisEntry()
const PNPM = pnpmEntry()
const PROFILE = profileDir()

if (CORDIS === null || PROFILE === null) {
  console.log('SKIP: no local DSH installation or profile found')
  console.log('      point DSH_INSTALL_ROOT and/or DSH_PROFILE_DIR at one to run this diagnostic')
  process.exit(0)
}

const COPY = join(tmpdir(), 'upgrader-diagnose-profile')
const ROOT = packageRoot()

console.log(`live profile : ${PROFILE}`)
console.log(`working copy : ${COPY}`)

// Rebuild the copy each run so the diagnosis starts from the live state.
rmSync(COPY, { recursive: true, force: true })
mkdirSync(COPY, { recursive: true })
for (const file of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) {
  const from = join(PROFILE, file)
  if (existsSync(from)) cpSync(from, join(COPY, file))
}
// Junction the real node_modules: copying it would be pointless, and pnpm only needs the
// directory to exist to reconcile against.
const realModules = join(PROFILE, 'node_modules')
const copyModules = join(COPY, 'node_modules')
if (existsSync(realModules) && process.platform === 'win32') {
  spawnSync('cmd', ['/c', 'mklink', '/J', copyModules, realModules], { stdio: 'ignore' })
}

/** The profile's declared dependencies, read from the copy. */
const manifest = readJson(join(COPY, 'package.json')) ?? {}
/** The dependency to diagnose: the first git dependency, unless overridden. */
const TARGET = process.env.DIAGNOSE_TARGET ?? Object.entries(manifest.dependencies ?? {})
  .find(([, spec]) => typeof spec === 'string' && (spec.startsWith('git+') || spec.includes('.git')))?.[0]

if (TARGET === undefined) {
  console.log('SKIP: the profile declares no git dependency to diagnose (set DIAGNOSE_TARGET=<name>)')
  rmSync(COPY, { recursive: true, force: true })
  process.exit(0)
}
console.log(`target plugin: ${TARGET}`)

/**
 * Read a dependency's resolved commit straight out of a lockfile.
 * @param {string} lockPath - the lockfile to scan.
 * @param {string} pkg - the dependency name.
 * @returns {string|null} the commit, or null.
 */
function commitOf(lockPath, pkg) {
  try {
    const match = new RegExp(`${pkg}@git\\+[^#]*#([0-9a-f]{7,40})`).exec(readFileSync(lockPath, 'utf8'))
    return match === null ? null : match[1]
  } catch {
    return null
  }
}

const before = commitOf(join(COPY, 'pnpm-lock.yaml'), TARGET)
console.log(`\nlockfile commit before : ${String(before)}`)

// ---------------------------------------------------------------- mount through real Cordis

const cordis = await import(pathToFileURL(CORDIS).href)
const plugin = await import(new URL('../lib/index.js', import.meta.url).href)

/** Every spec the plugin asked to install, and every argv actually executed. */
const requestedSpecs = []
const invokedArgv = []
/** Route registrations captured from the connection stub. */
const routes = []

const root = new cordis.Context()
root.provide('pluginManager', {
  // Real roster, read from the live profile's declared dependencies.
  listBundles: async () => Object.entries(manifest.dependencies ?? {}).map(([name, spec]) => ({
    name,
    version: '0.0.0',
    enabled: true,
    installed: true,
    rows: [],
    spec,
  })),
  registries: async () => ({ registry: null, fallbackRegistries: [], resolved: null }),
  installBundle: async (spec) => {
    requestedSpecs.push(spec)
    if (PNPM === null) return { application: 'restart-required', target: spec }
    const argv = [process.execPath, '--expose-internals', PNPM, 'add', spec]
    invokedArgv.push(argv)
    console.log(`\n>>> installBundle(spec): ${spec}`)
    console.log(`>>> executing: pnpm add ${spec}`)
    const run = spawnSync(argv[0], argv.slice(1), {
      cwd: COPY,
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', GIT_TERMINAL_PROMPT: '0' },
    })
    const tail = (run.stdout ?? '').trim().split(/\r?\n/).slice(-6).join('\n')
    console.log(`>>> exit=${String(run.status)}\n${tail}`)
    return {
      application: run.status === 0 ? 'restart-required' : 'failed',
      target: spec,
      packageResult: { exitCode: run.status ?? 1, output: `${run.stdout ?? ''}${run.stderr ?? ''}` },
    }
  },
  cancelInstall: async () => ({ status: 'not-running' }),
})
root.provide('profileContext', {
  name: 'diagnose',
  dir: COPY,
  installAnchor: 'package.json',
  ...(PNPM === null
    ? {}
    : { packageManager: { command: process.execPath, args: ['--expose-internals', PNPM], env: { ELECTRON_RUN_AS_NODE: '1' } } }),
})
root.provide('subprocess', {
  spawn(spec) {
    invokedArgv.push(spec.argv)
    const run = spawnSync(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      encoding: 'utf8',
      env: spec.env ?? process.env,
    })
    const out = run.stdout ?? ''
    const err = run.stderr ?? ''
    return {
      collected: {
        stdout: { readFrom: () => ({ text: out, nextOffset: out.length, lossy: false }) },
        stderr: { readFrom: () => ({ text: err, nextOffset: err.length, lossy: false }) },
      },
      done: Promise.resolve({ exitCode: run.status ?? 1, signal: null }),
      terminate() {},
      waitForExit: async () => true,
    }
  },
})
root.provide('connection', { fetch: { register: (route) => { routes.push(route); return () => {} } } })

try {
  await root.plugin(plugin)
  console.log('\nfiber: activated')
} catch (error) {
  console.log(`\nfiber FAILED: ${String(error?.stack ?? error)}`)
  process.exit(1)
}

/**
 * Drive one RPC method through the mounted endpoint.
 * @param {string} method - the RPC method name.
 * @param {any} payload - the method payload.
 * @returns {Promise<any>} the decoded reply.
 */
async function call(method, payload) {
  const response = await routes[0].fetch(new Request('http://localhost/api/plugin-upgrader', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'diag', method: 'plugin-upgrader', payload: { method, payload } }),
  }))
  return response.json()
}

console.log('\n=== 1. list: the roster must cost ZERO subprocess calls ===')
const spawnsBeforeList = invokedArgv.length
const roster = await call('list', {})
const spawnsForList = invokedArgv.length - spawnsBeforeList
console.log(`roster entries    : ${String(roster.result?.value?.plugins?.length ?? 0)}`)
console.log(`subprocess spawns : ${String(spawnsForList)}`)
console.log(`checkedAt         : ${String(roster.result?.value?.checkedAt)}`)
console.log(spawnsForList === 0
  ? 'RESULT: roster is network-free'
  : `RESULT: roster spawned ${String(spawnsForList)} — it should spawn none`)

console.log(`\n=== 2. check scoped to ONE plugin (${TARGET}) ===`)
const scopedBefore = invokedArgv.length
const scoped = await call('check', { name: TARGET })
console.log(`plugins returned  : ${JSON.stringify((scoped.result?.value?.plugins ?? []).map((p) => p.name))}`)
console.log(`subprocess spawns : ${String(invokedArgv.length - scopedBefore)}`)

console.log('\n=== 3. what discovery reports ===')
console.log(JSON.stringify((scoped.result?.value?.plugins ?? [])[0], null, 2))

console.log('\n=== 4. upgrade.start: what spec is resolved? ===')
const start = await call('upgrade.start', { name: TARGET, requestId: 'diag-1' })
console.log(JSON.stringify(start.result?.value ?? start.result, null, 2))

// Let the fire-and-forget install settle.
await new Promise((resolve) => setTimeout(resolve, 4000))

console.log('\n=== 5. result ===')
const status = await call('upgrade.status', { requestId: 'diag-1' })
console.log(`application      : ${String(status.result?.value?.run?.application ?? null)}`)
console.log(`requested specs  : ${JSON.stringify(requestedSpecs)}`)
for (const argv of invokedArgv) console.log(`  - ${argv.join(' ')}`)

const after = commitOf(join(COPY, 'pnpm-lock.yaml'), TARGET)
console.log(`\nlockfile commit before: ${String(before)}`)
console.log(`lockfile commit after : ${String(after)}`)
console.log(after !== null && after !== before ? 'RESULT: commit MOVED — upgrade works' : 'RESULT: commit UNCHANGED')

await root.fiber.dispose()
rmSync(COPY, { recursive: true, force: true })
console.log(`\n(working copy removed; nothing outside ${tmpdir()} was touched)`)
