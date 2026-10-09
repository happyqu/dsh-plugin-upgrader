/**
 * Offline assertions for every piece of logic that does not need a browser or a live
 * profile. Run with `node scripts/verify-all.mjs`.
 *
 * The runtime facts these encode were read out of the shipped 0.2.0-rc.2 code; the tests
 * exist so a later refactor cannot silently undo them.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { CheckCache } from '../lib/cache.js'
import { buildCandidates, classifyBundleRow } from '../lib/discover.js'
import { checkCandidate, parseViewVersion } from '../lib/registry.js'
import {
  SHAPE,
  classifySpecifier,
  commitFromResolved,
  gitUrlOf,
  parseLockfileImporters,
} from '../lib/shapes.js'
import { bumpKind, compareVersions, isNewer, parseVersion, rangeOperator } from '../lib/semver.js'
import { interpretResult } from '../lib/upgrade.js'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let failures = 0
let checks = 0

/**
 * List every file under a directory, skipping named directories.
 *
 * Used by the leak scan so it covers the whole tree instead of a hand-maintained file list: a
 * new file must not be able to bypass the check by not being added to it.
 * @param {string} dir - the directory to walk.
 * @param {object} [options] - walk options.
 * @param {Set<string>} [options.skip] - directory names to skip.
 * @returns {Promise<string[]>} absolute file paths.
 */
async function walkFiles(dir, { skip = new Set() } = {}) {
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(dir, { withFileTypes: true })
  const out = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (skip.has(entry.name)) continue
      out.push(...await walkFiles(join(dir, entry.name), { skip }))
    } else if (entry.isFile()) {
      out.push(join(dir, entry.name))
    }
  }
  return out.sort()
}

/**
 * Assert one expectation.
 * @param {string} label - what is being asserted.
 * @param {unknown} actual - the observed value.
 * @param {unknown} expected - the required value.
 */
function is(label, actual, expected) {
  checks += 1
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}\n       expected ${e}\n       actual   ${a}`)
  }
}

/**
 * Assert a boolean condition.
 * @param {string} label - what is being asserted.
 * @param {unknown} condition - truthy when the assertion holds.
 * @param {string} [detail] - extra context on failure.
 */
function ok(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail === '' ? '' : `\n       ${detail}`}`)
  }
}

/** Compare a throwing function against a matcher. */
async function rejects(label, run, matcher) {
  try {
    await run()
    failures += 1
    checks += 1
    console.log(`  FAIL ${label} (did not throw)`)
  } catch (error) {
    const text = String(error?.message ?? error)
    checks += 1
    if (matcher.test(text)) console.log(`  ok   ${label}`)
    else {
      failures += 1
      console.log(`  FAIL ${label}\n       message ${text}`)
    }
  }
}

console.log('\n# semver (prerelease correctness is the point on this machine)')
is('0.2.0-rc.2 < 0.2.0-rc.10', compareVersions('0.2.0-rc.2', '0.2.0-rc.10') < 0, true)
is('0.2.0-rc.10 < 0.2.0', compareVersions('0.2.0-rc.10', '0.2.0') < 0, true)
is('0.1.3 === 0.1.3', compareVersions('0.1.3', '0.1.3'), 0)
is('1.0.0 > 0.9.9', compareVersions('1.0.0', '0.9.9') > 0, true)
is('v-prefix parses', parseVersion('v1.2.3')?.patch, 3)
is('build metadata ignored', compareVersions('1.2.3+build.9', '1.2.3'), 0)
is('numeric < alphanumeric prerelease', compareVersions('1.0.0-1', '1.0.0-alpha') < 0, true)
is('garbage returns null', compareVersions('not-a-version', '1.0.0'), null)
is('isNewer: rc.10 over rc.2', isNewer('0.2.0-rc.10', '0.2.0-rc.2'), true)
is('isNewer: same is false', isNewer('0.1.3', '0.1.3'), false)
is('isNewer: older is false', isNewer('0.1.2', '0.1.3'), false)
is('bumpKind major', bumpKind('2.0.0', '1.9.9'), 'major')
is('bumpKind prerelease', bumpKind('0.2.0-rc.3', '0.2.0-rc.2'), 'prerelease')
is('rangeOperator caret', rangeOperator('^0.1.3'), '^')
is('rangeOperator pinned', rangeOperator('0.1.3'), '')

console.log('\n# shapes: the four dependency forms')
is('caret is registry', classifySpecifier('^0.1.3'), SHAPE.REGISTRY)
is('exact is registry', classifySpecifier('0.1.3'), SHAPE.REGISTRY)
is('link: is local', classifySpecifier('link:./vendor/some-plugin'), SHAPE.LINK)
is('file: is local', classifySpecifier('file:../x.tgz'), SHAPE.FILE)
is('https .git is git', classifySpecifier('https://git.example.com/a/b.git'), SHAPE.GIT)
is('git+ is git', classifySpecifier('git+https://git.example.com/x/y.git'), SHAPE.GIT)
is('bare https tarball', classifySpecifier('https://example.com/x/y.tgz'), SHAPE.TARBALL)
const SAMPLE_COMMIT = '0123456789abcdef0123456789abcdef01234567'
is('commitFromResolved', commitFromResolved(`git+https://git.example.com/a/b.git#${SAMPLE_COMMIT}`), SAMPLE_COMMIT)
is('commitFromResolved: none', commitFromResolved('link:./vendor/x'), null)
is('gitUrlOf strips git+ and hash', gitUrlOf('git+https://git.example.com/a/b.git#0123456'), 'https://git.example.com/a/b.git')
is('gitUrlOf rejects link', gitUrlOf('link:./vendor/x'), null)

console.log('\n# lockfile parsing (synthetic fixture, all three shapes)')
const lockText = await readFile(join(root, 'scripts', 'fixtures', 'pnpm-lock.yaml'), 'utf8')
const parsedLock = parseLockfileImporters(lockText)
is('root importer entry count', parsedLock.size, 4)
is('registry specifier', parsedLock.get('@example/another-registry-plugin')?.specifier, '^0.1.3')
is('registry version', parsedLock.get('@example/another-registry-plugin')?.version, '0.1.3')
is(
  'git resolved commit survives',
  commitFromResolved(parsedLock.get('example-git-plugin')?.version),
  '0123456789abcdef0123456789abcdef01234567',
)
is('link specifier', parsedLock.get('example-local-plugin')?.specifier, 'link:./vendor/example-local-plugin')
ok(
  'non-importer sections ignored',
  parsedLock.has('@example/transitive-dep') === false,
  'packages: section leaked into the importer map',
)
is(
  'empty input yields empty map',
  parseLockfileImporters('lockfileVersion: 9.0\n').size,
  0,
)

console.log('\n# discovery: official layers excluded, locals kept but marked')
const profileDeps = {
  '@example/registry-plugin': '^0.1.0',
  '@example/another-registry-plugin': '^0.1.3',
  'example-git-plugin': 'https://git.example.com/team/example-git-plugin.git',
  'example-local-plugin': 'link:./vendor/example-local-plugin',
}
// Shaped after a real listBundles() result: official layers come from the installation,
// so they are `installed: false` against the profile's own dependencies.
const bundleRows = [
  { name: '@example/base-layer', installed: false, enabled: true, readOnlyReason: 'management-required', rows: [] },
  { name: '@example/web-layer', installed: false, enabled: true, rows: [] },
  { name: '@example/registry-plugin', installed: true, enabled: true, version: '0.1.0', description: 'one', rows: [] },
  { name: '@example/another-registry-plugin', installed: true, enabled: true, version: '0.1.3', description: 'two', rows: [] },
  { name: 'example-git-plugin', installed: true, enabled: true, version: '0.2.0', rows: [] },
  { name: 'example-local-plugin', installed: true, enabled: true, version: '0.1.0', rows: [] },
]
const candidates = buildCandidates({
  bundles: bundleRows,
  dependencies: profileDeps,
  lockfile: parsedLock,
  selfName: '@happyqu/dsh-plugin-upgrader',
})
is('exactly the four third-party plugins', candidates.length, 4)
ok(
  'both official layers were excluded',
  !candidates.some((c) => c.name === '@example/base-layer' || c.name === '@example/web-layer'),
  JSON.stringify(candidates.map((c) => c.name)),
)
is('registry row keeps version', candidates.find((c) => c.name === '@example/another-registry-plugin')?.installedVersion, '0.1.3')
is('git row classified', candidates.find((c) => c.name === 'example-git-plugin')?.shape, SHAPE.GIT)
is('link row flagged local', candidates.find((c) => c.name === 'example-local-plugin')?.local, true)
ok('candidates sorted by name', candidates.every((c, i) => i === 0 || candidates[i - 1].name <= c.name))

is(
  'self is never offered',
  buildCandidates({
    bundles: [{ name: '@happyqu/dsh-plugin-upgrader', installed: true, enabled: true, rows: [] }],
    dependencies: { '@happyqu/dsh-plugin-upgrader': '^0.1.0' },
    lockfile: new Map(),
    selfName: '@happyqu/dsh-plugin-upgrader',
  }).length,
  0,
)
is(
  'readOnlyReason excludes a layer',
  classifyBundleRow({ name: 'x', installed: true, readOnlyReason: 'unaddressable' }, { x: '^1.0.0' }).managed,
  false,
)
is(
  'missing installed flag falls back to dependencies',
  classifyBundleRow({ name: 'x' }, { x: '^1.0.0' }).managed,
  true,
)

console.log('\n# registry parsing')
is('plain json string', parseViewVersion('"0.1.4"'), '0.1.4')
is('array takes last', parseViewVersion('["0.1.3","0.1.4"]'), '0.1.4')
is('bare text', parseViewVersion('0.1.5\n'), '0.1.5')
is('empty yields null', parseViewVersion(''), null)
is('prerelease text', parseViewVersion('0.2.0-rc.3'), '0.2.0-rc.3')

console.log('\n# checkCandidate: classification without touching the network')
const profileStub = { dir: '.', packageManager: { command: 'pnpm', args: [] } }
const localVerdict = await checkCandidate({
  ctx: { subprocess: undefined },
  profile: profileStub,
  candidate: { name: 'example-local-plugin', shape: SHAPE.LINK, installedVersion: '0.1.0', enabled: true },
})
is('link never queries', localVerdict.status, 'local')
ok('link explains itself', /本地/.test(localVerdict.message), localVerdict.message)

const unknownShape = await checkCandidate({
  ctx: {},
  profile: profileStub,
  candidate: { name: 'x', shape: SHAPE.TARBALL, installedVersion: '1.0.0', enabled: true },
})
is('tarball is not queried', unknownShape.status, 'unknown')

const noSubprocess = await checkCandidate({
  ctx: { get: () => undefined },
  profile: profileStub,
  candidate: { name: 'x', shape: SHAPE.REGISTRY, installedVersion: '1.0.0', enabled: true },
})
is('missing subprocess is an error, not a crash', noSubprocess.status, 'error')
ok('missing subprocess is explained', /pnpm/.test(noSubprocess.message), noSubprocess.message)

console.log('\n# cache: TTL, de-duplication, and failure non-pollution')
let produced = 0
const cache = new CheckCache({ ttlMs: 60_000, concurrency: 2 })
const first = await cache.get('k', async () => {
  produced += 1
  return { status: 'current' }
})
is('first call computes', first.cached, false)
const second = await cache.get('k', async () => {
  produced += 1
  return { status: 'current' }
})
is('second call is cached', second.cached, true)
is('producer ran once', produced, 1)

let concurrentRuns = 0
const dedupeCache = new CheckCache({ ttlMs: 60_000, concurrency: 4 })
const slow = () => new Promise((resolve) => {
  concurrentRuns += 1
  setTimeout(() => resolve({ status: 'current' }), 30)
})
await Promise.all([dedupeCache.get('d', slow), dedupeCache.get('d', slow), dedupeCache.get('d', slow)])
is('concurrent identical calls share one run', concurrentRuns, 1)

const failCache = new CheckCache({ ttlMs: 60_000 })
await failCache.get('f', async () => ({ status: 'current', latestVersion: '2.0.0' }))
const afterFail = await failCache.get('f', async () => ({ status: 'error', message: 'registry down' }), { force: true })
is('failure keeps last good value', afterFail.value.status, 'current')
is('failure is marked stale', afterFail.stale, true)

let peak = 0
let active = 0
const limitCache = new CheckCache({ ttlMs: 0, concurrency: 2 })
await Promise.all(
  ['a', 'b', 'c', 'd', 'e', 'f'].map((key) => limitCache.get(key, async () => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise((resolve) => setTimeout(resolve, 15))
    active -= 1
    return { status: 'current', key }
  })),
)
ok('concurrency ceiling honoured', peak <= 2, `peak was ${peak}`)

console.log('\n# interpretResult: restart is its own state')
const restart = interpretResult({ application: 'restart-required', target: 'pkg' })
is('restart-required is flagged', restart.needsRestart, true)
ok('restart headline says restart', /重启/.test(restart.headline), restart.headline)
is('applied needs no restart', interpretResult({ application: 'applied', target: 'pkg' }).needsRestart, false)
is('cancelled is distinct', interpretResult({ application: 'cancelled', target: 'pkg' }).state, 'cancelled')
is('null result is unknown', interpretResult(null).state, 'unknown')
const incompatible = interpretResult({
  application: 'failed',
  target: 'pkg',
  error: { incompatible: [{ name: 'pkg', version: '9.9.9', runtimeVersion: '0.2.0-rc.2', peers: {} }] },
})
ok('incompatible carries the allow-version hint', /allow-version/.test(incompatible.detail), incompatible.detail)
// The hint must NOT hard-code a profile name: profiles can be called anything, and a wrong
// `--profile` is worse than none. It appears only when the caller supplies the real name.
ok('the hint omits --profile when the name is unknown', !/--profile/.test(incompatible.detail), incompatible.detail)
const incompatibleNamed = interpretResult({
  application: 'failed',
  target: 'pkg',
  error: { incompatible: [{ name: 'pkg', version: '9.9.9', runtimeVersion: '0.2.0-rc.2', peers: {} }] },
}, { profileName: 'my-profile' })
ok('the hint names the profile when the caller knows it', /--profile my-profile/.test(incompatibleNamed.detail), incompatibleNamed.detail)
const pending = interpretResult({ application: 'failed', target: 'pkg', pendingBuilds: ['a', 'b'] })
ok('pendingBuilds are surfaced', /a, b/.test(pending.detail), pending.detail)
const raw = interpretResult({
  application: 'failed',
  target: 'pkg',
  packageResult: { output: 'ERR_PNPM_MINIMUM_RELEASE_AGE something' },
})
ok('pnpm output is passed through verbatim', /minimum|ERR_PNPM_MINIMUM_RELEASE_AGE/.test(raw.detail), raw.detail)

console.log('\n# plugin wiring')
const hostSource = await readFile(join(root, 'lib', 'index.js'), 'utf8')
const clientSource = await readFile(join(root, 'lib', 'client.js'), 'utf8')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

ok(
  'host declares no @deepseek-ai/dsh-* peer dependency',
  !Object.keys(pkg.peerDependencies ?? {}).some((dep) => dep === '@deepseek-ai/dsh' || dep.startsWith('@deepseek-ai/dsh-')),
  JSON.stringify(pkg.peerDependencies ?? {}),
)
ok(
  'host source imports no @deepseek-ai package',
  !/from\s+['"]@deepseek-ai\//.test(hostSource),
  'a DSH import would re-introduce the version gate this plugin must survive',
)
ok('connection is not a static inject', !/inject\s*=\s*\[[^\]]*'connection'/.test(hostSource))
ok('connection is injected optionally', /ctx\.inject\(\['connection'\]/.test(hostSource))
ok('client uses the static ModuleLoader contract', /window\.__ModuleLoader__\.load\(\{/.test(clientSource))
ok('client requires only react', !/require\(\s*["'](?!react["'])/.test(clientSource), 'client must not require non-react modules')
ok(
  'client never requires a DSH UI package',
  !/require\(\s*["'][^"']*@deepseek-ai\//.test(clientSource),
  'the shell seeds those modules, but depending on them would couple us to the DSH version',
)
ok('client registers the settings tab', /settings\.plugins\.tab/.test(clientSource))
ok('client registers the detail badge', /plugins\.detail\.badge/.test(clientSource))
ok('client registers the detail section', /plugins\.detail\.section/.test(clientSource))
ok('client injects nothing from @deepseek-ai', !/dsh\.client[\s\S]{0,80}@deepseek-ai/.test(pkg.dsh?.client ? JSON.stringify(pkg.dsh.client) : ''))
ok('bundle patch is declared', typeof pkg.dsh?.bundle?.patch === 'string', JSON.stringify(pkg.dsh))
ok('client platform is web', pkg.dsh?.client?.platform === 'web', JSON.stringify(pkg.dsh?.client))

const patchText = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
// Strip comment lines first: the file documents the id by name, and a naive match would
// pass on the documentation alone.
const patchBody = patchText.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('#')).join('\n')
ok(
  'patch inserts this plugin',
  /- insert:[\s\S]*?-\s+id:\s+plugin-upgrader[\s\S]*?name:\s*'@happyqu\/dsh-plugin-upgrader'/.test(patchBody),
  patchBody,
)

// ---------------------------------------------------------------- name consistency
// A rename touches FOUR places that must agree, and three of them fail SILENTLY when they
// drift: the client bundle simply never attaches, or the plugin offers itself as an upgrade
// target. These assertions make drift a test failure instead.
console.log('\n# package-name consistency across the four load-bearing places')
const pkgName = pkg.name
ok('the package is scoped under @happyqu', pkgName === '@happyqu/dsh-plugin-upgrader', pkgName)
ok(
  'the client bundle id equals the package name',
  new RegExp(`id:\\s*["']${pkgName.replace(/[/@]/g, (ch) => `\\${ch}`)}["']`).test(clientSource),
  'dsh-client-modules derives the id from the specifier, so a mismatch silently detaches the bundle',
)
ok(
  'the Host SELF_NAME equals the package name',
  new RegExp(`SELF_NAME\\s*=\\s*'${pkgName.replace(/[/@]/g, (ch) => `\\${ch}`)}'`).test(hostSource),
  'a stale SELF_NAME would let the plugin offer itself as an upgrade target',
)
ok(
  'the patch inserts the package name',
  patchBody.includes(`'${pkgName}'`),
  'a stale patch name would fail to resolve at load time',
)
// Strip the scoped name first, then look for any leftover bare `dsh-plugin-upgrader` in the
// LOAD-BEARING places only. The repository URLs legitimately use the bare name, because that is
// the GitHub repo name (`github.com/happyqu/dsh-plugin-upgrader`), matching the sibling packages.
const stripped = [hostSource, clientSource, patchBody].map((text) => text.split(pkgName).join(''))
ok(
  'no load-bearing file still names the unscoped package',
  stripped.every((text) => !text.includes('dsh-plugin-upgrader')),
  'a leftover unscoped name would never resolve at load time',
)
ok(
  'the manifest name is the scoped package name',
  JSON.parse(JSON.stringify(pkg.name)) === '@happyqu/dsh-plugin-upgrader',
  pkg.name,
)
ok(
  'the package publishes publicly to npmjs',
  pkg.publishConfig?.access === 'public' && pkg.publishConfig?.registry === 'https://registry.npmjs.org/',
  JSON.stringify(pkg.publishConfig),
)
ok(
  'the package declares a repository',
  typeof pkg.repository?.url === 'string' && pkg.repository.url.includes('happyqu'),
  JSON.stringify(pkg.repository),
)
ok(
  'the cordis peer range is declared alone',
  JSON.stringify(Object.keys(pkg.peerDependencies ?? {})) === '["@deepseek-ai/cordis"]',
  JSON.stringify(pkg.peerDependencies),
)
ok(
  'the published file list excludes scripts and tests',
  Array.isArray(pkg.files) && pkg.files.includes('lib') && !pkg.files.includes('scripts'),
  JSON.stringify(pkg.files),
)

// ---------------------------------------------------------------- no machine-specific leaks
// This package is public. A hard-coded install path, a private repository URL, or one user's
// dependency list is both a privacy leak and a portability bug (it breaks on every other
// machine). These patterns must never appear; anything genuinely machine-specific is discovered
// at runtime by `scripts/lib/env.mjs` instead.
//
// The scan covers EVERY source, fixture, and doc file rather than a hand-maintained list, so a
// new file cannot quietly bypass it.
console.log('\n# the package carries no machine-specific or private values')
const SCANNABLE = /\.(?:js|mjs|cjs|json|ya?ml|md)$/i
// This guard necessarily SPELLS OUT the patterns it forbids, so it must exclude itself;
// every other file is scanned.
const SELF = fileURLToPath(import.meta.url)
const scanned = await walkFiles(root, { skip: new Set(['node_modules', '.git', 'scratch']) })
const sourceFiles = scanned.filter((path) => SCANNABLE.test(path) && path !== SELF)
const PUBLISHED_AND_FIXTURES = await Promise.all(sourceFiles.map((path) => readFile(path, 'utf8')))
console.log(`  scanned ${sourceFiles.length} files`)
ok('the scan actually covered the tree', sourceFiles.length > 10, `only ${sourceFiles.length} files matched`)

const FORBIDDEN = [
  { what: 'Windows user-profile paths', pattern: /[A-Z]:\\+Users\\+/i },
  { what: 'nvm install paths', pattern: /nvm4w/i },
  { what: 'private gitee repositories', pattern: /gitee\.com/i },
  { what: 'another plugin\'s package name', pattern: /@happyqu\/dsh-plugin-(?!upgrader)/ },
  { what: 'personal directories', pattern: /(?:D|C):\\+happy/i },
  { what: 'real commit hashes', pattern: /\b(?:af20398|1d8210c|ecbb268)[0-9a-f]{0,33}\b/i },
]
for (const { what, pattern } of FORBIDDEN) {
  const offenders = PUBLISHED_AND_FIXTURES
    .map((text, i) => (pattern.test(text) ? sourceFiles[i].slice(root.length + 1) : null))
    .filter((name) => name !== null)
  ok(`no ${what}`, offenders.length === 0, offenders.join(', '))
}
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} assertions passed`)
process.exit(failures === 0 ? 0 : 1)
