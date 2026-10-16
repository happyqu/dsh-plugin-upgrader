/**
 * Automatic third-party plugin discovery.
 *
 * The whole point of this plugin is that the user should NOT have to hand-maintain a
 * watchlist. So discovery derives the candidate set from live runtime facts instead of
 * configuration.
 *
 * The load-bearing distinction comes from `pluginManager.listBundles()`, which builds its
 * name set from three sources and then reports two flags we can filter on:
 *
 *   names = profile.bundles ∪ profile.dependencies ∪ installation.dependencies
 *   installed       = profile.dependencies.includes(name)   // I installed this
 *   readOnlyReason  = protectsManager(name) ? 'management-required' : undefined
 *
 * A DSH layer (`@deepseek-ai/dsh-base`, `dsh-web-app`, …) is supplied by the installation
 * itself, so it is NOT in the profile's own `dependencies` — meaning `installed === false`
 * for every official layer and `installed === true` for everything the user added.
 * That single flag, plus `readOnlyReason === undefined`, is the whole discovery rule; the
 * dependency specifier then decides which detection path applies.
 */
import { SHAPE, classifySpecifier } from './shapes.js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { trackedDeclaration } from './git-tracking.js'

/** Reconcile the host inventory with profile-owned packages, regardless of installer. */
export async function discoverCandidates({ profileDir, manifest, bundles, lockfile, selfName }) {
  const rows = new Map((Array.isArray(bundles) ? bundles : []).map((row) => [row.name, row]))
  const selected = new Set(manifest.bundles)
  await Promise.all(Object.keys(manifest.dependencies).map(async (name) => {
    if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(name)) return
    const row = rows.get(name)
    // A host protection verdict is authoritative, even when files say otherwise.
    if (row?.readOnlyReason || row?.installed === false) return
    let metadata
    try {
      metadata = JSON.parse(await readFile(join(profileDir, 'node_modules', name, 'package.json'), 'utf8'))
    } catch {
      // Keep known host rows diagnosable when their package files are missing.
      return
    }
    const isPlugin = (metadata.dsh !== null && typeof metadata.dsh === 'object')
      || selected.has(name) || (Array.isArray(row?.rows) && row.rows.length > 0)
    if (!isPlugin) {
      rows.delete(name)
      return
    }
    rows.set(name, {
      ...row, name, installed: true,
      version: typeof metadata.version === 'string' ? metadata.version : row?.version,
      description: typeof metadata.description === 'string' ? metadata.description : row?.description,
    })
  }))
  const candidates = buildCandidates({ bundles: [...rows.values()], dependencies: manifest.dependencies, lockfile, selfName })
  await Promise.all(candidates.filter((item) => item.shape === SHAPE.GIT).map(async (item) => {
    try {
      item.trackedSpecifier = await trackedDeclaration(profileDir, item.name, item.specifier)
    } catch (error) {
      item.trackingError = error.message
    }
  }))
  return candidates
}

/** Dependency shapes that have no remote to compare against. */
const LOCAL_SHAPES = new Set([SHAPE.LINK, SHAPE.FILE])

/**
 * Decide whether one `listBundles()` row is a third-party plugin the upgrader manages.
 * @param {any} row - one entry from `pluginManager.listBundles()`.
 * @param {Record<string,string>} dependencies - the profile's declared dependencies.
 * @returns {{managed: boolean, reason: string}} the verdict and why.
 */
export function classifyBundleRow(row, dependencies) {
  const name = row?.name
  if (typeof name !== 'string' || name === '') return { managed: false, reason: 'unnamed' }

  // `installed` is the "declared in MY profile package.json" flag. When the runtime
  // omits it we fall back to the dependency map we read ourselves, so we degrade to a
  // correct answer instead of silently dropping every plugin.
  const installed = typeof row?.installed === 'boolean'
    ? row.installed
    : Object.prototype.hasOwnProperty.call(dependencies, name)
  if (!installed) return { managed: false, reason: 'not-installed' }

  // Official / protected layers are never ours to touch. Treat a missing field as
  // "not protected" only because `installed` already excludes the official layers.
  if (typeof row?.readOnlyReason === 'string' && row.readOnlyReason !== '') {
    return { managed: false, reason: row.readOnlyReason }
  }

  return { managed: true, reason: 'third-party' }
}

/**
 * Build the upgrade candidate list from live bundle rows plus profile files.
 * @param {object} input - discovery inputs.
 * @param {any[]} input.bundles - `await pluginManager.listBundles()`.
 * @param {Record<string,string>} input.dependencies - profile `package.json` dependencies.
 * @param {Map<string, {specifier?: string, version?: string}>} input.lockfile - root importer entries.
 * @param {string} [input.selfName] - this plugin's own package name, excluded from the list.
 * @returns {Array<object>} one candidate per managed plugin, sorted by name.
 */
export function buildCandidates({ bundles, dependencies, lockfile, selfName }) {
  /** @type {Array<object>} */
  const candidates = []

  for (const row of Array.isArray(bundles) ? bundles : []) {
    const name = row?.name
    const verdict = classifyBundleRow(row, dependencies)
    if (!verdict.managed) continue
    // Upgrading ourselves mid-session is a footgun with no upside: the code that would
    // perform the swap is the code being replaced.
    if (typeof selfName === 'string' && name === selfName) continue

    const specifier = dependencies[name]
    const shape = classifySpecifier(specifier)
    const resolved = lockfile.get(name)
    // The lockfile's own `version` is the ground truth for what is actually on disk for
    // git dependencies (the manifest only carries the range or URL).
    const resolvedVersion = typeof resolved?.version === 'string' ? resolved.version : undefined
    const lockfileSpecifier = typeof resolved?.specifier === 'string' ? resolved.specifier : undefined

    candidates.push({
      name,
      installedVersion: typeof row?.version === 'string' ? row.version : null,
      description: typeof row?.description === 'string' ? row.description : undefined,
      enabled: row?.enabled === true,
      shape,
      specifier: typeof specifier === 'string' ? specifier : null,
      lockfileSpecifier: lockfileSpecifier ?? null,
      lockfileVersion: resolvedVersion ?? null,
      local: LOCAL_SHAPES.has(shape),
      // Present only for git dependencies: the exact commit the lockfile pinned.
      resolvedCommit: resolvedVersion ?? null,
      rows: Array.isArray(row?.rows) ? row.rows : [],
      readOnlyReason: undefined,
    })
  }

  candidates.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return candidates
}
