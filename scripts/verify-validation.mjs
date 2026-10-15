/** Regression checks use a real local Git repository and never contact a remote server. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkGitPackageName, checkInstalledPackage } from '../lib/validation.js'
import { UpgradeTracker, interpretResult } from '../lib/upgrade.js'

const dir = await mkdtemp(join(tmpdir(), 'dsh-upgrader-validation-test-'))
const commands = []
const ctx = {
  subprocess: {
    spawn({ argv, cwd, env, signal }) {
      commands.push(argv)
      const child = spawn(argv[0], argv.slice(1), { cwd, env, signal, windowsHide: true })
      let stdout = '', stderr = ''
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      return {
        done: new Promise((resolve, reject) => {
          child.on('error', reject)
          child.on('close', (exitCode) => resolve({ exitCode }))
        }),
        collected: {
          stdout: { readFrom: () => ({ text: stdout }) },
          stderr: { readFrom: () => ({ text: stderr }) },
        },
      }
    },
  },
}
async function git(...args) {
  const handle = ctx.subprocess.spawn({ argv: ['git', ...args], cwd: dir })
  const result = await handle.done
  assert.equal(result.exitCode, 0, handle.collected.stderr.readFrom().text)
  return handle.collected.stdout.readFrom().text.trim()
}
try {
  await git('init', dir)
  await git('config', 'user.name', 'Validation Fixture')
  await git('config', 'user.email', 'fixture@example.com')
  await git('config', 'commit.gpgsign', 'false')
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'demo-plugin' }))
  await git('add', 'package.json')
  await git('commit', '-m', 'Original package')
  const before = await git('rev-parse', 'HEAD')
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'renamed-plugin' }))
  await git('commit', '-am', 'Rename package')
  const renamed = await git('rev-parse', 'HEAD')
  const input = { ctx, profile: { dir }, name: 'demo-plugin', url: dir }
  assert.equal((await checkGitPackageName({ ...input, commit: before })).ok, true,
    'must inspect the requested old commit even when HEAD has a new name')
  const refusal = await checkGitPackageName({ ...input, commit: renamed })
  assert.equal(refusal.error.code, 'plugin-upgrader/package-renamed')
  assert.match(refusal.error.message, /renamed-plugin/)
  assert.equal((await checkGitPackageName({ ...input, commit: 'a'.repeat(40) })).error.code,
    'plugin-upgrader/preflight-failed', 'unreadable targets must fail closed')
  const temporaryRepos = commands.filter((argv) => argv[1] === 'init' && argv[2] === '--bare').map((argv) => argv[3])
  for (const path of temporaryRepos) {
    await assert.rejects(readdir(path), { code: 'ENOENT' }, 'preflight must clean up after success and failure')
  }
  assert.equal(await readFile(join(dir, 'package.json'), 'utf8'), JSON.stringify({ name: 'renamed-plugin' }),
    'preflight must leave the original checkout unchanged')

  const installed = join(dir, 'node_modules', 'demo-plugin')
  await mkdir(installed, { recursive: true })
  const manifest = { name: 'demo-plugin', main: 'index.js', exports: { '.': './index.js', './client': './client.js' }, dsh: { client: { platform: 'web' } } }
  await writeFile(join(installed, 'package.json'), JSON.stringify(manifest))
  await writeFile(join(installed, 'index.js'), 'throw new Error("validation must not execute this file")')
  await writeFile(join(installed, 'client.js'), 'window.__ModuleLoader__.load({ id: "demo-plugin", factory() { throw Error("do not execute") } })')
  const installedInput = { profileDir: dir, name: 'demo-plugin' }
  assert.equal((await checkInstalledPackage(installedInput)).ok, true)
  await writeFile(join(installed, 'package.json'), JSON.stringify({ ...manifest,
    exports: { '.': { import: './index.js' }, './client': { import: './client.js' } },
  }))
  assert.equal((await checkInstalledPackage(installedInput)).ok, true, 'import-only ESM exports are valid')
  await writeFile(join(installed, 'package.json'), JSON.stringify({ name: 'demo-plugin', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  assert.equal((await checkInstalledPackage(installedInput)).ok, true, 'configuration-only bundles need no host entry')
  await writeFile(join(installed, 'package.json'), JSON.stringify(manifest))
  await writeFile(join(installed, 'client.js'), 'window.__ModuleLoader__.load({ id: "old-plugin", factory() {} })')
  const invalid = await checkInstalledPackage(installedInput)
  assert.equal(invalid.ok, false)
  assert.match(invalid.detail, /old-plugin/)
  const tracker = new UpgradeTracker({ ctx: {}, pluginManager: {} })
  const verification = await tracker.verifyOutcome('demo-plugin', '1.0.0', async () => ({ validation: invalid }))
  const verdict = interpretResult({ application: 'restart-required', target: 'demo-plugin' }, { verification })
  assert.equal(verdict.state, 'validation-failed')
  assert.equal(verdict.needsRestart, false)
  assert.match(verdict.detail, /未自动回滚/)
  assert.equal(interpretResult({ application: 'cancelled' }, { verification }).state, 'cancelled')
  await writeFile(join(installed, 'package.json'), JSON.stringify({ ...manifest, name: 'renamed-plugin' }))
  assert.match((await checkInstalledPackage(installedInput)).detail, /renamed-plugin/)
  await writeFile(join(installed, 'package.json'), JSON.stringify(manifest))
  await rm(join(installed, 'client.js'))
  assert.equal((await checkInstalledPackage(installedInput)).ok, false, 'missing declared client must fail validation')
  await writeFile(join(installed, 'client.js'), 'export function apply() {}')
  await rm(join(installed, 'index.js'))
  assert.equal((await checkInstalledPackage(installedInput)).ok, false, 'missing host entry must fail validation')
  console.log('PASS: exact-commit preflight, rename refusal, cleanup, installed entry and browser identity validation, failure verdict')
} finally {
  await rm(dir, { recursive: true, force: true })
}
