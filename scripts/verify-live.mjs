/**
 * Live check against whatever DSH profile this machine actually has.
 *
 * The offline suite proves the logic; this proves the two claims that only a real machine can:
 *   1. discovery selects exactly the profile's own plugins and skips every official layer;
 *   2. a version query runs through the profile's OWN package manager, not a bare `pnpm` on PATH
 *      (the desktop app has no global pnpm).
 *
 * Everything machine-specific is discovered via `scripts/lib/env.mjs`, and the roster is derived
 * from the profile's real `package.json`, so this script names no user, repository, or plugin.
 * With no DSH present it SKIPs instead of failing, so `npm test` stays usable anywhere.
 *
 * Run: node scripts/verify-live.mjs
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildCandidates, classifyBundleRow } from '../lib/discover.js'
import { parseViewVersion } from '../lib/registry.js'
import { isNewer } from '../lib/semver.js'
import { SHAPE, readLockfile, readProfileManifest } from '../lib/shapes.js'
import { pnpmEntry, profileDir, profileContextStub } from './lib/env.mjs'

// Read this plugin's own name rather than repeating it, so a rename cannot desynchronise the test.
const SELF = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')).name

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

const PROFILE = profileDir()
if (PROFILE === null) {
  console.log('SKIP: no DSH profile found (set DSH_PROFILE_DIR to point at one)')
  process.exit(0)
}

const PNPM = pnpmEntry()
console.log(`\nprofile : ${PROFILE}`)
console.log(`pnpm    : ${PNPM ?? '(not found; version queries will be skipped)'}`)

const manifest = await readProfileManifest(PROFILE)
const lock = await readLockfile(PROFILE)
const declared = Object.keys(manifest.dependencies)
console.log(`  declared dependencies : ${declared.join(', ') || '(none)'}`)
console.log(`  lockfile entries      : ${lock.size}`)

// Build the bundle rows the way the runtime reports them: the profile's own dependencies are
// `installed: true`, and the installation's own layers are `installed: false`. The latter are
// represented by a single synthetic official layer, because their exact set is not the point —
// that discovery must EXCLUDE them is.
const rows = [
  { name: '@example/official-layer', installed: false, enabled: true, readOnlyReason: 'management-required', rows: [] },
  ...declared.map((name) => ({
    name,
    installed: true,
    enabled: true,
    version: lock.get(name)?.version ?? undefined,
    rows: [],
  })),
]

const candidates = buildCandidates({
  bundles: rows,
  dependencies: manifest.dependencies,
  lockfile: lock,
  selfName: SELF,
})

console.log('\n# discovery against the live profile')
console.log(`  managed: ${candidates.map((c) => `${c.name}[${c.shape}]`).join(', ') || '(none)'}`)

// The plugin excludes ITSELF from its own roster, and this profile depends on it, so the
// expected count is the declared set minus that one entry.
const expectedCount = declared.length - (declared.includes(SELF) ? 1 : 0)
ok('every declared dependency except itself is discovered', candidates.length === expectedCount, `expected ${expectedCount}, found ${candidates.length}`)
ok('the plugin never offers itself as an upgrade target', !candidates.some((c) => c.name === SELF), candidates.map((c) => c.name).join(', '))
ok(
  'each discovered plugin is classified as manageable',
  candidates.every((c) => classifyBundleRow({ name: c.name, installed: true }, manifest.dependencies).managed),
  candidates.map((c) => c.name).join(', '),
)
ok(
  'the synthetic official layer was excluded',
  !candidates.some((c) => c.name === '@example/official-layer'),
  candidates.map((c) => c.name).join(', '),
)
ok(
  'every candidate maps to a real dependency specifier',
  candidates.every((c) => typeof c.specifier === 'string' && c.specifier !== ''),
  JSON.stringify(candidates.map((c) => [c.name, c.specifier])),
)

// Each shape must be classified by its specifier, not guessed from the name.
for (const candidate of candidates) {
  const spec = typeof candidate.specifier === 'string' ? candidate.specifier : ''
  const expected = spec.startsWith('link:') || spec.startsWith('file:')
    ? 'local'
    : spec.includes('.git') || spec.startsWith('git+')
      ? SHAPE.GIT
      : SHAPE.REGISTRY
  const actual = candidate.local ? 'local' : candidate.shape
  ok(`  ${candidate.name}: classified as ${expected}`, actual === expected, `got ${actual}`)
}

// ---------------------------------------------------------------- the real package manager

console.log('\n# the profile\'s own package manager')
const profile = profileContextStub(PROFILE)
if (profile.packageManager === undefined) {
  console.log('  (no pnpm entry point found; skipping the live query)')
} else {
  const pm = profile.packageManager
  ok('the package manager is not a bare `pnpm`', pm.command !== 'pnpm', pm.command)
  ok('it runs pnpm.mjs', pm.args.some((a) => a.endsWith('pnpm.mjs')), JSON.stringify(pm.args))

  console.log('\n# live version query through that package manager')
  const registryCandidates = candidates.filter((c) => c.shape === SHAPE.REGISTRY)
  if (registryCandidates.length === 0) {
    // A profile made only of git/link dependencies is legitimate, so this is not a failure.
    console.log('  (this profile declares no registry dependency; skipping the live query)')
  }

  for (const candidate of registryCandidates) {
    const run = spawnSync(pm.command, [
      ...pm.args,
      'view', candidate.name, 'version', '--json', '--config.fetch-retries=0',
    ], {
      cwd: PROFILE,
      encoding: 'utf8',
      env: { ...process.env, ...pm.env },
    })
    const raw = (run.stdout ?? '').trim()
    console.log(`\n  ${candidate.name}`)
    console.log(`    installed ${String(candidate.installedVersion)}, registry says ${raw === '' ? '(no output)' : raw}`)

    if (run.status !== 0) {
      // A private or unreachable registry is reported, not failed: the query path itself is what
      // this check exercises, and the plugin renders that same condition as "registry unreachable".
      console.log(`    (query did not succeed; exit ${String(run.status)})`)
      continue
    }
    const latest = parseViewVersion(raw)
    ok(`    ${candidate.name}: version parsed`, typeof latest === 'string', raw)
    if (latest !== null && candidate.installedVersion !== null) {
      const expected = isNewer(latest, candidate.installedVersion) ? 'outdated' : 'current'
      console.log(`    expected verdict: ${expected}`)
    }
  }
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — live checks`)
process.exit(failures === 0 ? 0 : 1)
