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
import { checkCandidate, isTransientGitFailure, parseViewVersion, runRemoteGit } from '../lib/registry.js'
import {
  SHAPE,
  classifySpecifier,
  commitFromResolved,
  gitRefOf,
  gitUpgradeSpec,
  gitUrlOf,
  parseLockfileImporters,
} from '../lib/shapes.js'
import { bumpKind, compareVersions, isNewer, parseVersion, rangeOperator } from '../lib/semver.js'
import { packageNameFromAllowBuildsKey } from '../lib/authorization.js'
import { UpgradeTracker, interpretResult } from '../lib/upgrade.js'

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

// ---------------------------------------------------------- the git upgrade spec contract
// Two independent requirements, each verified against a real profile with pnpm 11.7.0.
// Getting EITHER wrong turns a real upgrade into a failure that looks like success:
//
//   name-qualified — DSH's `installBundle` attributes a run by diffing the profile's
//     `dependencies` before and after pnpm. A git reinstall writes the same URL back, so the
//     diff is empty and the manager falls back to matching the spec against dependency NAMES.
//     A bare URL matches nothing, so it throws `ambiguous-install` and reports
//     `application: 'failed'` — AFTER pnpm already exited 0. This is the failure the user hit:
//     a green pnpm log followed by "升级失败".
//   commit-pinned  — pnpm treats an unpinned git specifier, a branch ref, and `HEAD` all as
//     already satisfied by the lockfile's commit: "Already up to date", exit 0, no
//     re-resolution. Re-installing the unpinned URL therefore cannot upgrade past the first
//     time; it is a silent no-op that repeats forever.
console.log('\n# the git upgrade spec must be name-qualified AND commit-pinned')
const GIT_URL = 'https://git.example.com/team/tool.git'
const GIT_SHA = '0123456789abcdef0123456789abcdef01234567'

const plainGitSpec = gitUpgradeSpec({ name: 'tool', url: GIT_URL, commit: GIT_SHA, declared: GIT_URL })
is('a bare-url dependency yields name@url#commit', plainGitSpec, `tool@${GIT_URL}#${GIT_SHA}`)
ok('the spec is name-qualified (DSH can attribute it)', plainGitSpec.startsWith('tool@'), plainGitSpec)
ok('the spec is commit-pinned (pnpm must re-resolve)', plainGitSpec.endsWith(`#${GIT_SHA}`), plainGitSpec)

// A `git+` declaration keeps its own style, so an upgrade does not rewrite the user's manifest.
const gitPlusSpec = gitUpgradeSpec({ name: 'tool', url: GIT_URL, commit: GIT_SHA, declared: `git+${GIT_URL}` })
is('a git+ dependency keeps its git+ style', gitPlusSpec, `tool@git+${GIT_URL}#${GIT_SHA}`)

// A scoped name must not confuse the name/specifier boundary.
const scopedGitSpec = gitUpgradeSpec({ name: '@scope/tool', url: GIT_URL, commit: GIT_SHA, declared: GIT_URL })
is('a scoped name stays intact', scopedGitSpec, `@scope/tool@${GIT_URL}#${GIT_SHA}`)

// A stale pin in the declaration must never survive into the new spec: two `#` fragments would
// be a malformed specifier, and keeping the old pin is the no-op we are fixing.
const staleDeclared = `${GIT_URL}#89abcdef0123456789abcdef0123456789abcdef`
const repinned = gitUpgradeSpec({ name: 'tool', url: GIT_URL, commit: GIT_SHA, declared: staleDeclared })
is('a stale pin is replaced, not appended to', repinned, `tool@${GIT_URL}#${GIT_SHA}`)
is('the new spec carries exactly one # fragment', repinned.split('#').length - 1, 1)

// Which ref to read. A commit fragment is a pin, not a moving ref, so it must fall back to
// HEAD; a branch or tag must be queried by name. Reading HEAD for a `#develop` dependency
// would pin the upgrade to the wrong branch's code.
is('no fragment means HEAD', gitRefOf(GIT_URL), null)
is('a commit fragment is not a ref', gitRefOf(`${GIT_URL}#${GIT_SHA}`), null)
is('a short commit fragment is not a ref', gitRefOf(`${GIT_URL}#89abcdef`), null)
is('a branch is a ref', gitRefOf(`${GIT_URL}#develop`), 'develop')
is('a tag is a ref', gitRefOf(`${GIT_URL}#v1.2.3`), 'v1.2.3')
is('a slashed branch is a ref', gitRefOf(`${GIT_URL}#feature/x`), 'feature/x')
is('git+ does not confuse ref extraction', gitRefOf(`git+${GIT_URL}#develop`), 'develop')
is('an empty fragment means HEAD', gitRefOf(`${GIT_URL}#`), null)
is('a non-string yields no ref', gitRefOf(undefined), null)

// ------------------------------------------------- transient remote-git failures are retried
// MEASURED, and the reason this exists: gitee answers the very same `git ls-remote` for the very
// same public URL with `HTTP/1.1 401 Unauthorized` about 40% of the time (raw HTTP, no git
// involved: 10 probes -> 200 200 401 401 200 200 200 401 200 200). git treats a 401 as an
// authentication failure and does NOT retry it, so one unlucky attempt reached the user as
// "远端不可达" while the remote was reachable a moment later. Without retries, roughly one
// upgrade attempt in three failed for no real reason.
console.log('\n# a flaky remote is retried, but only for transient symptoms')
ok('the gitee 401 is recognised as transient', isTransientGitFailure(
  "fatal: could not read Username for 'https://gitee.com': terminal prompts disabled",
) === true)
ok('an HTTP 401 is transient', isTransientGitFailure('error: The requested URL returned error: 401') === true)
ok('an HTTP 429 is transient', isTransientGitFailure('error: The requested URL returned error: 429') === true)
ok('an HTTP 503 is transient', isTransientGitFailure('error: The requested URL returned error: 503') === true)
ok('a TLS/EOF cut is transient', isTransientGitFailure('error: RPC failed; curl 56 OpenSSL SSL_read: unexpected eof') === true)
ok('a connection reset is transient', isTransientGitFailure('fatal: unable to access … Connection reset by peer') === true)
ok('a DNS failure is transient', isTransientGitFailure('fatal: unable to access … Could not resolve host: gitee.com') === true)

// Negative controls. Retrying a genuinely broken spec wastes attempts and delays the real error,
// so the detector must NOT swallow these.
is('a missing git binary is NOT transient', isTransientGitFailure("'git' is not recognized as an internal or external command"), false)
is('a malformed spec is NOT transient', isTransientGitFailure('fatal: invalid refspec HEAD~'), false)
is('an empty output is NOT transient', isTransientGitFailure(''), false)
is('a non-string is NOT transient', isTransientGitFailure(undefined), false)

// The retry LOOP itself, not just the classifier: a stub that fails twice then succeeds must be
// asked three times and must come back successful. This is the behaviour that turns the measured
// gitee coin-flip into a dependable query.
console.log('\n# runRemoteGit retries until success and stops as soon as one succeeds')
/** Build a ctx whose git spawns follow a scripted sequence of exit codes. */
function scriptedCtx(exitCodes) {
  const spawns = []
  return {
    spawns,
    ctx: {
      subprocess: {
        spawn({ argv }) {
          spawns.push(argv)
          const code = exitCodes[Math.min(spawns.length - 1, exitCodes.length - 1)]
          const reader = (text) => ({ readFrom: () => ({ text }) })
          return {
            done: Promise.resolve({ exitCode: code }),
            collected: {
              stdout: reader(code === 0 ? '0123456789abcdef0123456789abcdef01234567\tHEAD\n' : ''),
              stderr: reader(code === 0 ? '' : "fatal: could not read Username for 'https://gitee.com': terminal prompts disabled"),
            },
          }
        },
      },
    },
  }
}
const retryProfile = { dir: root, packageManager: undefined }
const retryArgv = ['git', '-c', 'credential.helper=', 'ls-remote', 'https://git.example.com/a/b.git', 'HEAD']

const twoThenOk = scriptedCtx([128, 128, 0])
const retried = await runRemoteGit({ ctx: twoThenOk.ctx, profile: retryProfile, argv: retryArgv })
is('a query that fails twice then succeeds ends as success', retried.exitCode, 0)
is('it took exactly three attempts', retried.attempts, 3)
is('the stub was invoked three times', twoThenOk.spawns.length, 3)
ok('every attempt disables the credential helper',
  twoThenOk.spawns.every((argv) => argv.includes('credential.helper=')), JSON.stringify(twoThenOk.spawns[0]))

const okFirst = scriptedCtx([0])
const firstTry = await runRemoteGit({ ctx: okFirst.ctx, profile: retryProfile, argv: retryArgv })
is('a query that succeeds immediately is not retried', okFirst.spawns.length, 1)
is('and reports one attempt', firstTry.attempts, 1)

// A NON-transient failure must stop at once: retrying a broken spec three times would only delay
// the real error the user needs to read.
const fatalOnly = scriptedCtx([128])
fatalOnly.ctx.subprocess.spawn = ((original) => ({ argv }) => {
  const handle = original({ argv })
  handle.collected.stderr = { readFrom: () => ({ text: "'git' is not recognized as an internal or external command" }) }
  return handle
})(fatalOnly.ctx.subprocess.spawn)
const notRetried = await runRemoteGit({ ctx: fatalOnly.ctx, profile: retryProfile, argv: retryArgv })
is('a non-transient failure is attempted only once', fatalOnly.spawns.length, 1)
is('and still reports the failure', notRetried.exitCode, 128)

// A pre-aborted signal must return a well-formed result, not `undefined` — callers read
// `exitCode`/`stderr` unconditionally, and "exit code undefined" is a useless message.
const aborted = scriptedCtx([0])
const controller = new AbortController()
controller.abort()
const cancelled = await runRemoteGit({ ctx: aborted.ctx, profile: retryProfile, argv: retryArgv, signal: controller.signal })
ok('an aborted run yields a well-formed result', typeof cancelled.exitCode === 'number' || cancelled.exitCode === null, JSON.stringify(cancelled))
ok('and does not spawn git', aborted.spawns.length === 0, JSON.stringify(aborted.spawns.length))

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

// A pnpm run can exit 0 having changed NOTHING. Observed live: `pnpm add <bare-git-url>` printed
// "Already up to date" and left the lockfile on the old commit, while installBundle returned
// `restart-required`. Reporting that as an update would be a lie, so a failed verification must
// override the success branches.
console.log('\n# a verified no-op must not be reported as an update')
const noop = interpretResult(
  { application: 'restart-required', target: 'pkg' },
  { verification: { changed: false, installedVersion: '1.0.0', expected: '1.0.0', note: '没有变化' } },
)
is('a no-op gets its own state', noop.state, 'no-op')
is('a no-op must not claim a restart is needed', noop.needsRestart, false)
ok('a no-op headline says no change', /没有变化/.test(noop.headline), noop.headline)
ok('a no-op carries the verifier note', /没有变化/.test(noop.detail), noop.detail)

const confirmed = interpretResult(
  { application: 'restart-required', target: 'pkg' },
  { verification: { changed: true, installedVersion: '1.1.0', expected: '1.1.0', note: null } },
)
is('a confirmed change still reports restart-required', confirmed.state, 'restart-required')

// An INCONCLUSIVE verification (changed === null, e.g. the re-read itself failed) must NOT
// downgrade a real success: the plugin simply cannot confirm it, which is not the same as a no-op.
const inconclusive = interpretResult(
  { application: 'restart-required', target: 'pkg' },
  { verification: { changed: null, installedVersion: null, expected: '1.1.0', note: '无法复核' } },
)
is('an inconclusive verification keeps the success state', inconclusive.state, 'restart-required')
is('an inconclusive verification still claims restart', inconclusive.needsRestart, true)

// No verifier at all (the caller supplied none) must behave exactly as before.
is(
  'no verification leaves the verdict untouched',
  interpretResult({ application: 'restart-required', target: 'pkg' }, {}).state,
  'restart-required',
)
is(
  'a no-op check applies only to success states',
  interpretResult(
    { application: 'cancelled', target: 'pkg' },
    { verification: { changed: false } },
  ).state,
  'cancelled',
)

// verifyOutcome compares the RIGHT thing per dependency shape. For a git dependency
// `installedVersion` is not a version at all — the runtime reports the git depPath there — so a
// version comparison would always be false and every git upgrade would look like a no-op.
console.log('\n# verifyOutcome compares the right thing per shape')
const tracker = new UpgradeTracker({ ctx: { on: () => () => {} }, pluginManager: {} })

const registryVerified = await tracker.verifyOutcome('pkg', '1.1.0', async () => ({
  installedVersion: '1.1.0', status: 'current',
}))
is('a registry target compares the version', registryVerified.changed, true)

const registryUnchanged = await tracker.verifyOutcome('pkg', '1.1.0', async () => ({
  installedVersion: '1.0.0', status: 'outdated',
}))
is('a registry target that did not move is a no-op', registryUnchanged.changed, false)
ok('the no-op note explains itself', /空操作/.test(registryUnchanged.note ?? ''), String(registryUnchanged.note))

// The git case: label is a display string and installedVersion is a depPath, so only the STATUS
// may be trusted. A status of `current` means the pin moved.
const gitVerified = await tracker.verifyOutcome('pkg', '远端最新提交', async () => ({
  installedVersion: 'git+https://git.example.com/a/b.git#0123456789abcdef',
  status: 'current',
}))
is('a git target trusts the status, not the version', gitVerified.changed, true)

const gitUnchanged = await tracker.verifyOutcome('pkg', '远端最新提交', async () => ({
  installedVersion: 'git+https://git.example.com/a/b.git#0123456789abcdef',
  status: 'outdated',
}))
is('a git target still outdated is a no-op', gitUnchanged.changed, false)

// A git upgrade now names the exact commit it installed, so the re-read can be exact rather
// than inferring from a status: the pin must BE the requested commit. This is also what catches
// "the commit I asked for was already installed", where the status alone would look fine.
const COMMIT_TARGET = '0123456789abcdef0123456789abcdef01234567'
const commitMatched = await tracker.verifyOutcome('pkg', COMMIT_TARGET, async () => ({
  installedVersion: `git+https://git.example.com/a/b.git#${COMMIT_TARGET}`,
  status: 'current',
  pinnedCommit: COMMIT_TARGET,
}))
is('a commit target is confirmed against the pinned commit', commitMatched.changed, true)

const commitNotMoved = await tracker.verifyOutcome('pkg', COMMIT_TARGET, async () => ({
  installedVersion: 'git+https://git.example.com/a/b.git#89abcdef0123456789abcdef0123456789abcdef',
  status: 'current',
  pinnedCommit: '89abcdef0123456789abcdef0123456789abcdef',
}))
is('a commit target that did not move is a no-op', commitNotMoved.changed, false)

// A short label (what the UI shows) must still match the full commit the lockfile records.
const shortLabel = COMMIT_TARGET.slice(0, 7)
const shortMatched = await tracker.verifyOutcome('pkg', shortLabel, async () => ({
  installedVersion: `git+https://git.example.com/a/b.git#${COMMIT_TARGET}`,
  status: 'current',
  pinnedCommit: COMMIT_TARGET,
}))
is('a short commit label matches the full pin', shortMatched.changed, true)

// With no `pinnedCommit` readable, the answer must be "cannot confirm" (null), NOT "did
// nothing": for a git dependency the status is derived FROM the pin, so a missing pin leaves
// the status saying `current` no matter what happened. Reporting `changed: false` there would
// turn a successful install into a claimed no-op.
const noPinCommit = await tracker.verifyOutcome('pkg', COMMIT_TARGET, async () => ({
  installedVersion: 'git+https://git.example.com/a/b.git#0123456789abcdef',
  status: 'current',
}))
is('a commit target with no readable pin is inconclusive, not a no-op', noPinCommit.changed, null)
ok('the inconclusive note says it could not confirm', /无法确认/.test(noPinCommit.note ?? ''), String(noPinCommit.note))

// It must NOT be the generic no-op wording, which would claim nothing changed.
ok('the inconclusive note does not claim a no-op', !/空操作/.test(noPinCommit.note ?? ''), String(noPinCommit.note))

// A verifier that throws must NOT be reported as a no-op: "could not confirm" is not "did nothing".
const threw = await tracker.verifyOutcome('pkg', '1.1.0', async () => {
  throw new Error('profile unreadable')
})
is('a failing verifier reports inconclusive', threw.changed, null)
ok('a failing verifier explains itself', /无法复核/.test(threw.note ?? ''), String(threw.note))

// No verifier means no opinion, which must not be mistaken for "changed".
is('no verifier yields no verification', await tracker.verifyOutcome('pkg', '1.1.0', undefined), null)
is('a verifier returning nothing yields no verification', await tracker.verifyOutcome('pkg', '1.1.0', async () => null), null)

const incompatible = interpretResult({
  application: 'failed',
  target: 'pkg',
  error: { incompatible: [{ name: 'pkg', version: '9.9.9', runtimeVersion: '0.2.0-rc.2', peers: {} }] },
})
ok('incompatible carries the allow-version hint', /allow-version/.test(incompatible.detail), incompatible.detail)// The hint must NOT hard-code a profile name: profiles can be called anything, and a wrong
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

// ------------------------------------------------- git build authorization (its own state)
// This failure needs a hand-made config edit: pnpm's normal "approve builds" flow does NOT cover
// git dependencies, so `pendingBuilds` stays empty and DSH's approval button cannot help. It must
// therefore be reported with the exact YAML pnpm itself printed, or the user is stranded.
console.log('\n# git build authorization is an actionable state, not a generic failure')

/** pnpm's refusal text, shaped exactly as pnpm 11 prints it (verified against a real capture). */
const GIT_REFUSAL = [
  '✓ Lockfile passes supply-chain policies (verified 16h ago)',
  'Progress: resolved 4, reused 1, downloaded 1, added 0',
  '[ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED] Failed to prepare git-hosted package fetched from',
  '"https://git.example.com/team/tool.git": The git-hosted package "tool@0.2.0" needs to execute',
  'build scripts but is not in the "allowBuilds" allowlist.',
  '',
  'Add the package to "allowBuilds" in your project\'s pnpm-workspace.yaml to allow it to run scripts. For example:',
  'allowBuilds:',
  '  tool@git+https://git.example.com/team/tool.git#0123456789abcdef0123456789abcdef01234567: true',
].join('\n')

const gitVerdict = interpretResult({
  application: 'failed',
  target: 'tool',
  packageResult: { exitCode: 1, output: GIT_REFUSAL },
})
is('the git refusal gets its own state', gitVerdict.state, 'needs-authorization')
ok('the headline names the package', /tool/.test(gitVerdict.headline), gitVerdict.headline)
ok('the detail explains WHY a git package differs', /git/i.test(gitVerdict.detail), gitVerdict.detail)
ok('the detail warns about the commit requirement', /commit/i.test(gitVerdict.detail), gitVerdict.detail)
ok('the detail warns this repeats per commit', /每升一次|每一次/.test(gitVerdict.detail) || /重新授权/.test(gitVerdict.detail), gitVerdict.detail)
is(
  'the action carries the exact allowBuilds key from pnpm',
  gitVerdict.action?.key,
  'tool@git+https://git.example.com/team/tool.git#0123456789abcdef0123456789abcdef01234567',
)
ok('the copyable YAML is a well-formed allowBuilds block', /^allowBuilds:\n {2}\S+: true\n$/.test(gitVerdict.action?.yaml ?? ''), JSON.stringify(gitVerdict.action?.yaml))
ok('the copyable YAML pins the commit', (gitVerdict.action?.yaml ?? '').includes('#0123456789abcdef'), gitVerdict.action?.yaml)

// A NON-git build refusal must NOT be mistaken for this one: registry packages have a real
// approval path (`pendingBuilds` + DSH's button), so saying "edit YAML by hand" would be wrong.
const registryRefusal = interpretResult({
  application: 'failed',
  target: 'pkg',
  pendingBuilds: ['some-registry-pkg'],
  packageResult: { exitCode: 1, output: 'ERR_PNPM_IGNORED_BUILDS some-registry-pkg' },
})
ok('a registry build refusal stays a plain failure', registryRefusal.state === 'failed', registryRefusal.state)
ok('a registry build refusal keeps the approval path', /批准|官方插件页/.test(registryRefusal.detail), registryRefusal.detail)

// The detector must key off pnpm's stable error CODE, so it still works when the surrounding
// prose is localized or reworded by a future pnpm.
const codeOnly = interpretResult({
  application: 'failed',
  target: 'tool',
  packageResult: {
    exitCode: 1,
    kind: 'git-dep-prepare-not-allowed',
    output: 'allowBuilds:\n  tool@git+https://git.example.com/team/tool.git#0123456789abcdef0123456789abcdef01234567: true',
  },
})
is('the error code alone is enough', codeOnly.state, 'needs-authorization')
is('extraction still yields the key from a code-only match', codeOnly.action?.key,
  'tool@git+https://git.example.com/team/tool.git#0123456789abcdef0123456789abcdef01234567')

// A SCOPED package name starts with `@`, so the name/specifier boundary is the LAST `@` before
// `@git+`, not the first. Splitting on the first `@` produced a bogus leading `@` in the message.
const scopedRefusal = interpretResult({
  application: 'failed',
  target: '@scope/tool',
  packageResult: {
    exitCode: 1,
    output: [
      'ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED nope',
      'allowBuilds:',
      '  @scope/tool@git+https://git.example.com/team/tool.git#0123456789abcdef0123456789abcdef01234567: true',
    ].join('\n'),
  },
})
is('a scoped name resolves correctly', packageNameFromAllowBuildsKey(scopedRefusal.action?.key), '@scope/tool')
ok('the scoped name is not mangled in the message', scopedRefusal.detail.includes('@scope/tool'), scopedRefusal.detail.split('\n')[0])
ok('no spurious double-@ appears', !scopedRefusal.detail.includes('@@'), scopedRefusal.detail.split('\n')[0])

// Name extraction must be independent of the refusal shape, since it is also used on its own.
is('an unscoped key yields its name', packageNameFromAllowBuildsKey('tool@git+https://x/y.git#abc1234'), 'tool')
is('a key with no git marker yields null', packageNameFromAllowBuildsKey('tool@1.2.3'), null)
is('a non-string key yields null', packageNameFromAllowBuildsKey(undefined), null)

// A refusal text with no parseable example must degrade to the raw output, never to a bogus action.
const unparseable = interpretResult({
  application: 'failed',
  target: 'tool',
  packageResult: { exitCode: 1, output: 'ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED something went wrong' },
})
is('an unparseable refusal stays a plain failure', unparseable.state, 'failed')
ok('an unparseable refusal still shows pnpm output', /ERR_PNPM/.test(unparseable.detail), unparseable.detail)
ok('an unparseable refusal offers no bogus action', unparseable.action === undefined, JSON.stringify(unparseable.action))

const raw = interpretResult({
  application: 'failed',
  target: 'pkg',  packageResult: { output: 'ERR_PNPM_MINIMUM_RELEASE_AGE something' },
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
