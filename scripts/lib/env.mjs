/**
 * Runtime discovery of the local DSH installation.
 *
 * The verification scripts need three things that are specific to ONE machine: the Cordis
 * module the Host loads, the DSH install root, and the pnpm entry point the desktop app uses.
 * Hard-coding any of them would put a private path in a public package and break on every other
 * machine, so every location is discovered here instead, in this order:
 *
 *   1. an explicit environment variable (for CI or unusual layouts);
 *   2. a well-known install location for this platform;
 *   3. wherever `dsh` on PATH resolves to.
 *
 * A discovered value is CACHED, and a failure is returned as `null` rather than thrown: the
 * scripts that need DSH treat "not installed here" as SKIP, so `npm test` stays green on a
 * machine that only wants the dependency-free checks.
 *
 * Nothing in this file references a specific user, repository, or package name.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

/** Cached discovery results, so repeated lookups do not re-scan the filesystem. */
const cache = new Map()

/**
 * Run a lookup once and remember its result (including a negative one).
 * @param {string} key - cache key.
 * @param {() => any} compute - the lookup.
 * @returns {any} the cached value.
 */
function once(key, compute) {
  if (!cache.has(key)) cache.set(key, compute())
  return cache.get(key)
}

/**
 * Check whether a path exists.
 * @param {unknown} path - candidate path.
 * @returns {boolean} true when it exists.
 */
function present(path) {
  return typeof path === 'string' && path !== '' && existsSync(path)
}

/**
 * Locate the `dsh` executable's real path via the platform shell.
 * @returns {string|null} the resolved path, or null when not on PATH.
 */
function dshOnPath() {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  try {
    const run = spawnSync(finder, ['dsh'], { encoding: 'utf8', shell: false })
    if (run.status !== 0) return null
    return (run.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? null
  } catch {
    return null
  }
}

/**
 * Resolve the DSH installation root: the directory that holds `resources/app.asar`.
 *
 * Checked locations cover the desktop app's default install, the environment override, and a
 * PATH-derived guess, because the CLI package lives under a different root than the desktop app.
 * @returns {string|null} an absolute directory, or null when DSH is not installed here.
 */
export function dshRoot() {
  return once('root', () => {
    const fromEnv = [process.env.DSH_INSTALL_ROOT, process.env.DSH_ROOT]
      .find((value) => present(value) && present(join(value, 'resources')))
    if (fromEnv !== undefined) return resolve(fromEnv)

    const candidates = []
    if (process.platform === 'win32') {
      for (const drive of ['C:', 'D:']) {
        candidates.push(`${drive}\\Program Files\\DeepSeek Harness`)
        candidates.push(`${drive}\\DeepSeek Harness`)
      }
      candidates.push(join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness'))
    } else {
      candidates.push('/Applications/DeepSeek Harness.app/Contents/Resources')
      candidates.push(join(homedir(), '.local', 'share', 'deepseek-harness'))
      candidates.push('/opt/deepseek-harness')
    }
    for (const candidate of candidates) {
      if (present(join(candidate, 'resources'))) return resolve(candidate)
    }

    // Fall back to the CLI install: `<npm-prefix>/node_modules/@deepseek-ai/dsh`.
    const dshBin = dshOnPath()
    if (dshBin !== null) {
      let dir = dirname(dshBin)
      for (let depth = 0; depth < 6; depth++) {
        const pkg = join(dir, 'node_modules', '@deepseek-ai', 'dsh')
        if (present(pkg)) return resolve(dir)
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    }
    return null
  })
}

/**
 * Resolve this plugin's own package root.
 * @returns {string} an absolute directory.
 */
export function packageRoot() {
  return resolve(import.meta.dirname, '..', '..')
}

/**
 * Locate `@deepseek-ai/cordis`, the module the Host uses to load plugins.
 *
 * The desktop app packs its dependencies inside `app.asar`, which cannot be imported directly,
 * so the CLI install under the npm prefix is the practical source. An explicit
 * `DSH_CORDIS_PATH` wins when a machine keeps it elsewhere.
 * @returns {string|null} an absolute path to cordis's entry file, or null.
 */
export function cordisEntry() {
  return once('cordis', () => {
    const fromEnv = process.env.DSH_CORDIS_PATH
    if (present(fromEnv)) return resolve(fromEnv)

    const roots = []
    const root = dshRoot()
    if (root !== null) roots.push(join(root, 'node_modules'))

    // npm's global prefix, which is where the CLI install keeps its dependency tree.
    const dshBin = dshOnPath()
    if (dshBin !== null) roots.push(join(dirname(dshBin), 'node_modules'))

    const npmPrefix = process.env.NPM_CONFIG_PREFIX ?? (process.platform === 'win32' ? null : '/usr/local')
    if (npmPrefix !== null) roots.push(join(npmPrefix, 'node_modules'))

    for (const modules of roots) {
      const candidates = [
        join(modules, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js'),
        join(modules, '@deepseek-ai', 'cordis', 'lib', 'index.js'),
      ]
      for (const candidate of candidates) {
        if (present(candidate)) return candidate
      }
    }
    return null
  })
}

/**
 * Locate the pnpm entry point the desktop app runs.
 *
 * The desktop app runs pnpm as Electron re-entered as Node, from a path under its own resources
 * directory. That path is derived from the install root, never hard-coded.
 * @returns {string|null} an absolute path to `pnpm.mjs`, or null.
 */
export function pnpmEntry() {
  return once('pnpm', () => {
    const fromEnv = process.env.DSH_PNPM_PATH
    if (present(fromEnv)) return resolve(fromEnv)

    const root = dshRoot()
    if (root === null) return null
    const candidates = [
      join(root, 'resources', 'runtime', 'pnpm', 'bin', 'pnpm.mjs'),
      join(root, 'resources', 'pnpm', 'bin', 'pnpm.mjs'),
    ]
    for (const candidate of candidates) {
      if (present(candidate)) return candidate
    }
    return null
  })
}

/**
 * Resolve the profile directory of the running (or a named) DSH profile.
 *
 * Precedence: `DSH_PROFILE_DIR` (set by the Host for the live profile), then the DSH home's
 * `profiles/<name>` with `DSH_PROFILE` naming the profile.
 * @param {string} [name] - profile name; defaults to `DSH_PROFILE` or 'desktop'.
 * @returns {string|null} an absolute directory, or null when it does not exist.
 */
export function profileDir(name) {
  const fromEnv = process.env.DSH_PROFILE_DIR
  if (present(fromEnv) && present(join(fromEnv, 'package.json'))) return resolve(fromEnv)

  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const candidates = [
    name,
    process.env.DSH_PROFILE,
    'desktop',
    'web',
    'default',
  ].filter((value) => typeof value === 'string' && value !== '')

  for (const candidate of candidates) {
    const dir = join(home, 'profiles', candidate)
    if (present(join(dir, 'package.json'))) return dir
  }
  return null
}

/**
 * Read a JSON file, returning null instead of throwing.
 * @param {string} path - the file to read.
 * @returns {any|null} the parsed value, or null.
 */
export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Build a `profileContext` shaped like the one the desktop boot constructs.
 *
 * Mirrors the real object so scripts exercise the same `packageManager` path the Host uses:
 * pnpm is reached through Electron re-entered as Node, never as a bare `pnpm`.
 * @param {string} dir - the profile directory.
 * @returns {{dir: string, packageManager?: object}} the context stub.
 */
export function profileContextStub(dir) {
  const entry = pnpmEntry()
  if (entry === null) return { dir }
  return {
    dir,
    packageManager: {
      command: process.execPath,
      args: ['--expose-internals', entry],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    },
  }
}
