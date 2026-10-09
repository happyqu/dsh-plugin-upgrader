/**
 * Measure which `allowBuilds` key form actually permits a git dependency's build scripts.
 *
 * Why this exists: pnpm's rule for git dependencies is not obvious, and a naive experiment gives
 * the WRONG answer. pnpm records a package's build side-effects in its store, so once a build has
 * run successfully, a later install of the same commit SKIPS the build — and therefore skips the
 * `allowBuilds` check entirely. Probing several key forms against one shared store makes a
 * blocked form look permitted. Every candidate here gets its own `--store-dir`, so each result
 * reflects policy alone.
 *
 * What pnpm actually does (dist/pnpm.mjs, `createAllowBuildFunction`): a git dep's `depPath`
 * carries the resolved commit and matching is exact set membership, while a git version is a
 * `nonSemverVersion` that makes `trustPackageIdentity` false — so the package-name branch is
 * never consulted and only the commit-pinned key can match.
 *
 * Requires a target, supplied by the caller, because the interesting case is a git repo whose
 * package runs build scripts — which is inherently environment-specific:
 *
 *   node scripts/probe-allowbuilds-isolated.mjs <git-url-or-package-name> [...more]
 *
 * Example:
 *   node scripts/probe-allowbuilds-isolated.mjs https://git.example.com/team/tool.git
 */
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { pnpmEntry } from './lib/env.mjs'

const PNPM_MJS = pnpmEntry()
if (PNPM_MJS === null) {
  console.log('SKIP: no local pnpm entry point found (set DSH_INSTALL_ROOT or DSH_PNPM_PATH)')
  process.exit(0)
}

/** One target: a git repository URL (the package name is read from it). */
const targets = process.argv.slice(2).filter((arg) => arg !== '')
if (targets.length === 0) {
  console.log('usage: node scripts/probe-allowbuilds-isolated.mjs <git-url> [<git-url> ...]')
  console.log('')
  console.log('Probes which allowBuilds key form permits a git dependency to run its build scripts.')
  console.log('Supply the repository URL of a git dependency whose package has build scripts.')
  process.exit(0)
}

/** Make a label safe for a directory name. */
function safe(label) {
  return label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
}

let mismatches = 0

for (const repo of targets) {
  // The package name is whatever `git ls-remote` plus the repo's own manifest says; ask npm for
  // the name by reading the manifest after a clone would be heavy, so derive it from the URL.
  const pkg = /([^/]+?)(?:\.git)?$/.exec(repo)?.[1]
  if (pkg === undefined) {
    console.log(`SKIP ${repo}: cannot derive a package name`)
    continue
  }

  const head = spawnSync('git', ['ls-remote', repo, 'HEAD'], {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  const commit = /\b([0-9a-f]{40})\b/.exec(head.stdout ?? '')?.[1]
  console.log(`\n${repo}`)
  console.log(`  package: ${pkg}`)
  console.log(`  HEAD   : ${commit ?? '(unreachable)'}`)
  if (commit === undefined) {
    console.log('  SKIP: remote unreachable')
    continue
  }

  const candidates = [
    { label: 'versionless git url', lines: ['allowBuilds:', `  ${JSON.stringify(`${pkg}@git+${repo}`)}: true`], expect: 'blocked' },
    { label: 'bare package name', lines: ['allowBuilds:', `  ${JSON.stringify(pkg)}: true`], expect: 'blocked' },
    { label: 'commit-pinned', lines: ['allowBuilds:', `  ${JSON.stringify(`${pkg}@git+${repo}#${commit}`)}: true`], expect: 'works' },
    { label: 'wildcard commit #*', lines: ['allowBuilds:', `  ${JSON.stringify(`${pkg}@git+${repo}#*`)}: true`], expect: 'blocked' },
    { label: 'blanket dangerouslyAllowAllBuilds', lines: ['dangerouslyAllowAllBuilds: true'], expect: 'works' },
  ]

  for (const candidate of candidates) {
    const dir = join(tmpdir(), `ab-${safe(pkg)}-${safe(candidate.label)}`)
    const store = join(tmpdir(), `ab-store-${safe(pkg)}-${safe(candidate.label)}`)
    rmSync(dir, { recursive: true, force: true })
    rmSync(store, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    mkdirSync(store, { recursive: true })

    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
      name: 'allowbuilds-probe',
      private: true,
      dependencies: { [pkg]: repo },
    }, null, 2)}\n`)
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), ['packages:', '  - .', '', 'nodeLinker: hoisted', ...candidate.lines, ''].join('\n'))

    const run = spawnSync(process.execPath, [
      '--expose-internals', PNPM_MJS, 'install', '--dir', dir, '--store-dir', store,
    ], {
      encoding: 'utf8',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', GIT_TERMINAL_PROMPT: '0' },
    })
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
    const blocked = /GIT_DEP_PREPARE_NOT_ALLOWED/.test(output)
    const installed = existsSync(join(dir, 'node_modules', pkg, 'package.json'))
    const verdict = blocked ? 'blocked' : installed ? 'works' : `failed (exit ${String(run.status)})`

    const mark = candidate.expect === '?' ? '   ' : candidate.expect === verdict ? ' ok' : 'BAD'
    console.log(`  ${mark} ${candidate.label} -> ${verdict}`)
    if (candidate.expect !== '?' && candidate.expect !== verdict) mismatches += 1

    rmSync(dir, { recursive: true, force: true })
    rmSync(store, { recursive: true, force: true })
  }
}

console.log('')
console.log(mismatches === 0
  ? 'CONFIRMED: only the commit-pinned and blanket forms permit a git dependency\'s build scripts'
  : `${mismatches} candidate(s) differed from what pnpm's source predicts`)
process.exit(mismatches === 0 ? 0 : 1)
