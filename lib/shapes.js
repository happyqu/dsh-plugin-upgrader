/**
 * Dependency-shape detection.
 *
 * This is the single most error-prone part of an upgrader, because the four shapes
 * in a real profile answer "is there a newer version?" in four different ways:
 *
 *   registry  `^0.1.3`                                   -> ask the registry
 *   git       `https://…/repo.git`                       -> compare commits
 *   link      `link:D:/path`                             -> no remote at all
 *   file      `file:../x.tgz`                            -> no remote at all
 *
 * Asking `pnpm view` about a `link:` dependency is meaningless, and asking it about
 * a git dependency returns an npm version that does not describe the checkout. Every
 * branch below therefore starts by classifying the specifier, and the caller is
 * expected to render a shape-specific verdict rather than a bare "failed".
 *
 * Nothing here imports a DSH package; the inputs are the profile directory's own
 * `package.json` and `pnpm-lock.yaml`, read as text.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** The kind of dependency specifier a profile declares. */
export const SHAPE = Object.freeze({
  REGISTRY: 'registry',
  GIT: 'git',
  LINK: 'link',
  FILE: 'file',
  TARBALL: 'tarball',
  UNKNOWN: 'unknown',
})

/**
 * Classify one dependency specifier.
 * @param {unknown} specifier - the raw value from the profile's `dependencies`.
 * @returns {string} one of {@link SHAPE}.
 */
export function classifySpecifier(specifier) {
  if (typeof specifier !== 'string') return SHAPE.UNKNOWN
  const value = specifier.trim()
  if (value === '') return SHAPE.UNKNOWN
  if (value.startsWith('link:')) return SHAPE.LINK
  if (value.startsWith('file:')) return SHAPE.FILE
  if (value.startsWith('workspace:')) return SHAPE.LINK
  if (/^(github|gitlab|bitbucket):/i.test(value) || /^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(value)) return SHAPE.GIT
  if (value.startsWith('git+') || value.startsWith('git://')) return SHAPE.GIT
  // A bare host URL is a git dependency in pnpm's own reading only when it looks
  // like one; `.git` anywhere is the reliable tell.
  if (/^(https?|ssh):\/\//.test(value)) {
    if (value.startsWith('ssh://') || /\.git(?:#|$)/.test(value)
      || /^https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?(?:#.*)?$/.test(value)) return SHAPE.GIT
    return SHAPE.TARBALL
  }
  if (/\.(tgz|tar\.gz|tar)$/i.test(value)) return SHAPE.TARBALL
  // Unknown protocols (including npm aliases) must never fall back to name@latest.
  if (/[:/\\]/.test(value)) return SHAPE.UNKNOWN
  return SHAPE.REGISTRY
}

/**
 * Read and parse the profile's `package.json`.
 * @param {string} dir - the profile directory.
 * @returns {Promise<{dependencies: Record<string,string>, bundles: string[]}>}
 *   declared dependencies and the selected bundle layer names.
 */
export async function readProfileManifest(dir) {
  const text = await readFile(join(dir, 'package.json'), 'utf8')
  const parsed = JSON.parse(text)
  const dependencies = parsed?.dependencies ?? {}
  const bundles = parsed?.dsh?.profile?.bundles ?? []
  return {
    dependencies: typeof dependencies === 'object' && dependencies !== null ? dependencies : {},
    bundles: Array.isArray(bundles) ? bundles.filter((name) => typeof name === 'string') : [],
  }
}

/**
 * Parse the `importers` → `.` → `dependencies` block of a pnpm v9 lockfile.
 *
 * Deliberately a narrow line scanner rather than a YAML parser: this plugin ships
 * with no dependencies, and the block it needs is fixed-shape and machine-written.
 * It reads only the root importer and ignores every other section.
 * @param {string} text - the lockfile contents.
 * @returns {Map<string, {specifier: string|undefined, version: string|undefined}>}
 *   resolved entry per dependency name.
 */
export function parseLockfileImporters(text) {
  /** @type {Map<string, {specifier: string|undefined, version: string|undefined}>} */
  const out = new Map()
  const lines = text.split(/\r?\n/)

  let inImporters = false
  let inRoot = false
  let inDependencies = false
  /** @type {string|null} */
  let current = null

  for (const line of lines) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    const body = line.trim()

    // Top-level key: ends any nested section we were tracking.
    if (indent === 0) {
      inImporters = body === 'importers:'
      inRoot = false
      inDependencies = false
      current = null
      continue
    }
    if (!inImporters) continue

    // `  .:` opens the root importer.
    if (!inRoot) {
      if (indent === 2 && body === '.:') inRoot = true
      continue
    }
    // Any other importer key at indent 2 closes the root importer again.
    if (indent === 2) {
      inRoot = body === '.:'
      inDependencies = false
      current = null
      continue
    }
    if (indent === 4) {
      inDependencies = body === 'dependencies:'
      current = null
      continue
    }
    if (!inDependencies) continue

    if (indent === 6 && body.endsWith(':')) {
      // A dependency name, possibly single-quoted because of `/` or `@`.
      const raw = body.slice(0, -1).trim()
      current = raw.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1')
      if (!out.has(current)) out.set(current, { specifier: undefined, version: undefined })
      continue
    }
    if (current === null) continue

    const field = /^(specifier|version):\s*(.*)$/.exec(body)
    if (field === null) continue
    const value = field[2].trim().replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1')
    const entry = out.get(current)
    if (entry === undefined) continue
    if (field[1] === 'specifier') entry.specifier = value
    else entry.version = value
  }

  return out
}

/**
 * Read the profile's lockfile and return its root-importer entries.
 * @param {string} dir - the profile directory.
 * @returns {Promise<Map<string, {specifier: string|undefined, version: string|undefined}>>}
 *   an empty map when no lockfile exists yet.
 */
export async function readLockfile(dir) {
  try {
    const text = await readFile(join(dir, 'pnpm-lock.yaml'), 'utf8')
    return parseLockfileImporters(text)
  } catch {
    return new Map()
  }
}

/**
 * Extract the commit a lockfile resolved a git dependency to.
 * @param {unknown} resolved - the lockfile `version` value for the dependency.
 * @returns {string|null} the 7..40 char hex commit, or null when absent.
 */
export function commitFromResolved(resolved) {
  if (typeof resolved !== 'string') return null
  const match = /(?:#|\/)([0-9a-f]{7,40})(?=$|[(&/])/i.exec(resolved)
  return match === null ? null : match[1]
}

/**
 * Extract the repository URL from a git dependency specifier or lockfile value.
 * @param {unknown} value - specifier or resolved version text.
 * @returns {string|null} a URL usable with `git ls-remote`, or null.
 */
export function gitUrlOf(value) {
  if (typeof value !== 'string') return null
  const text = value.trim().replace(/^git\+/, '')
  const hashIndex = text.indexOf('#')
  const withoutHash = hashIndex === -1 ? text : text.slice(0, hashIndex)
  const githubUrl = /^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/?$/.exec(withoutHash)
  if (githubUrl !== null) return `https://github.com/${githubUrl[1].replace(/\.git$/, '')}.git`
  const shorthand = /^(?:(github|gitlab|bitbucket):)?([\w.-]+\/[\w.-]+)$/.exec(withoutHash)
  if (shorthand !== null) {
    const host = { github: 'github.com', gitlab: 'gitlab.com', bitbucket: 'bitbucket.org' }[shorthand[1] ?? 'github']
    return `https://${host}/${shorthand[2].replace(/\.git$/, '')}.git`
  }
  if (/^(https?|ssh|git):\/\//.test(withoutHash)) return withoutHash
  return null
}

/**
 * Extract the moving ref a git dependency tracks, if it tracks one.
 *
 * A specifier can carry a `#ref` fragment. Only a BRANCH or TAG name is a moving ref worth
 * querying; a `#<hex>` fragment is a commit pin, and the pin in the lockfile is a separate
 * concern, so both are reported as "no ref" and the caller falls back to the remote's HEAD.
 *
 * This exists because querying `HEAD` for a dependency that tracks `#develop` would read the
 * wrong commit — and, since an upgrade now PINS to whatever commit it reads, would install and
 * freeze code from the wrong branch.
 * @param {unknown} value - specifier or resolved version text.
 * @returns {string|null} the ref to query, or null to use HEAD.
 */
export function gitRefOf(value) {
  if (typeof value !== 'string') return null
  const text = value.trim()
  const hashIndex = text.indexOf('#')
  if (hashIndex === -1) return null
  const ref = text.slice(hashIndex + 1).trim()
  if (ref === '') return null
  // A commit pin is not a moving ref; `git ls-remote <url> <sha>` does not answer it.
  if (/^[0-9a-f]{7,40}$/i.test(ref)) return null
  return ref
}

/**
 * Build the install spec that upgrades a git dependency.
 *
 * Both halves of this string are load-bearing, and each was measured against a real profile
 * (pnpm 11.7.0) after being got wrong:
 *
 *  - `<name>@` is required because DSH's `installBundle` attributes the run by diffing the
 *    profile's `dependencies` before and after pnpm. Reinstalling a git dependency writes the
 *    same URL back for the unpinned case, so that diff can be empty; the manager then matches
 *    the spec against the dependency NAMES, and a bare URL matches nothing. Zero matches is
 *    reported as `ambiguous-install`, i.e. a failed upgrade AFTER pnpm already exited 0.
 *  - `#<commit>` is required because pnpm treats an unpinned specifier — and equally a branch
 *    or `HEAD` ref — as already satisfied by the commit in the lockfile: it prints
 *    "Already up to date", exits 0, and never re-resolves the branch. A silent no-op.
 *
 * Pinning is not a permanent freeze: the caller re-reads the ref's current commit on every
 * upgrade and rewrites this pin, so the next upgrade still moves.
 * @param {object} input - spec inputs.
 * @param {string} input.name - the package name.
 * @param {string} input.url - the repository URL, without a `git+` prefix or ref.
 * @param {string} input.commit - the resolved commit to pin.
 * @param {unknown} [input.declared] - the dependency's own declaration, used only to preserve
 *   its `git+` style so an upgrade does not rewrite the user's manifest convention.
 * @returns {string} the `name@url#commit` install spec.
 */
export function gitUpgradeSpec({ name, url, commit, declared }) {
  const shorthand = typeof declared === 'string' && /^(github|gitlab|bitbucket):([^#]+)/.exec(declared.trim())
  if (shorthand) return `${name}@${shorthand[1]}:${shorthand[2]}#${commit}`
  const prefix = typeof declared === 'string' && declared.trim().startsWith('git+') ? 'git+' : ''
  return `${name}@${prefix}${url}#${commit}`
}
