import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverCandidates } from '../lib/discover.js'
import { SHAPE, classifySpecifier, gitUrlOf, gitUpgradeSpec, commitFromResolved } from '../lib/shapes.js'
import { trackedDeclaration, rememberGitRef } from '../lib/git-tracking.js'
import { checkCandidate } from '../lib/registry.js'
import { apply } from '../lib/index.js'
import { UpgradeTracker } from '../lib/upgrade.js'

const dir = await mkdtemp(join(tmpdir(), 'dsh-upgrader-sources-'))
const oldCommit = 'a'.repeat(40)
const newCommit = 'b'.repeat(40)
try {
  for (const source of ['github:team/tool', 'gitlab:team/tool', 'bitbucket:team/tool', 'team/tool', 'https://github.com/team/tool']) {
    assert.equal(classifySpecifier(source), SHAPE.GIT, source)
    assert.match(gitUrlOf(source), /^https:\/\//)
  }
  assert.equal(classifySpecifier('https://example.com/tool.git/releases/file.tgz'), SHAPE.TARBALL)
  assert.equal(classifySpecifier('npm:other-package@latest'), SHAPE.UNKNOWN)
  assert.equal(commitFromResolved(`https://codeload.github.com/team/tool/tar.gz/${oldCommit}`), oldCommit)
  assert.equal(gitUpgradeSpec({ name: 'tool', url: gitUrlOf('github:team/tool'),
    declared: 'github:team/tool#develop', commit: newCommit }), `tool@github:team/tool#${newCommit}`)

  const dependencies = { external: '^2.0.0', ordinary: '^1.0.0', protected: '^1.0.0', shell: '^1.0.0' }
  for (const name of Object.keys(dependencies)) {
    await mkdir(join(dir, 'node_modules', name), { recursive: true })
    await writeFile(join(dir, 'node_modules', name, 'package.json'), JSON.stringify({
      name, version: '2.0.0', ...(name === 'ordinary' ? {} : { dsh: { manifestVersion: 1 } }),
    }))
  }
  const manifest = { dependencies, bundles: [] }
  await writeFile(join(dir, 'package.json'), JSON.stringify({ dependencies }))
  const bundles = [
    { name: 'ordinary', installed: true, version: '1.0.0' },
    { name: 'protected', installed: true, readOnlyReason: 'management-required' },
    { name: 'shell', installed: false },
  ]
  const candidates = await discoverCandidates({ profileDir: dir, manifest, bundles, lockfile: new Map() })
  assert.deepEqual(candidates.map((item) => item.name), ['external'], 'find externally installed plugins, exclude ordinary and protected dependencies')
  assert.equal(candidates[0].installedVersion, '2.0.0')
  const staleHost = await discoverCandidates({ profileDir: dir, manifest,
    bundles: [{ name: 'external', installed: true, version: '0.1.0' }, ...bundles], lockfile: new Map() })
  assert.equal(staleHost[0].installedVersion, '2.0.0', 'disk version overrides a stale host row')

  const branch = 'github:team/tool#develop'
  await rememberGitRef(dir, 'tool', branch, oldCommit)
  assert.equal(await trackedDeclaration(dir, 'tool', `github:team/tool#${oldCommit}`), branch)
  await rememberGitRef(dir, 'tool', branch, newCommit)
  assert.equal(await trackedDeclaration(dir, 'tool', `github:team/tool#${newCommit}`), branch, 'second update still follows develop')
  assert.equal(await trackedDeclaration(dir, 'tool', `github:team/tool#${oldCommit}`), branch, 'failed update retains previous tracking')
  assert.equal(await trackedDeclaration(dir, 'tool', `github:other/tool#${newCommit}`), `github:other/tool#${newCommit}`)

  const commands = []
  let registryVersion = '1.0.0'
  const ctx = {
    subprocess: { spawn({ argv }) {
      commands.push(argv)
      const stdout = argv.includes('ls-remote') ? `${newCommit}\tHEAD\n` : JSON.stringify(registryVersion)
      return { done: Promise.resolve({ exitCode: 0 }), collected: {
        stdout: { readFrom: () => ({ text: stdout }) }, stderr: { readFrom: () => ({ text: '' }) },
      } }
    } },
  }
  const result = await checkCandidate({ ctx, profile: { dir }, candidate: {
    name: 'tool', shape: SHAPE.GIT, specifier: 'github:team/tool', installedVersion: '1.0.0',
  } })
  assert.equal(result.status, 'unknown', 'missing installed commit must never mean current')
  const samePrefix = await checkCandidate({ ctx, profile: { dir }, candidate: {
    name: 'tool', shape: SHAPE.GIT, specifier: 'github:team/tool',
    installedVersion: '1.0.0', lockfileVersion: `github:team/tool#${newCommit.slice(0, 7)}${'c'.repeat(33)}`,
  } })
  assert.equal(samePrefix.status, 'outdated', 'full commits sharing seven characters are distinct')
  const beforeSelector = commands.length
  assert.equal((await checkCandidate({ ctx, profile: { dir }, candidate: {
    name: 'tool', shape: SHAPE.GIT, specifier: 'github:team/tool#path:/packages/tool',
  } })).status, 'unknown')
  assert.equal(commands.length, beforeSelector, 'unsupported selectors must not query the wrong root')

  const tracker = new UpgradeTracker({ ctx: { on() {} }, pluginManager: {
    installBundle: async () => ({ application: 'restart-required' }),
  } })
  tracker.start({ requestId: 'full-commit', name: 'tool', spec: `tool@github:team/tool#${newCommit}`,
    label: newCommit.slice(0, 7), expected: newCommit,
    verify: async () => ({ pinnedCommit: `${newCommit.slice(0, 7)}${'c'.repeat(33)}` }),
  })
  while (tracker.status('full-commit').running) await new Promise((resolve) => setTimeout(resolve, 1))
  assert.equal(tracker.status('full-commit').verification.changed, false, 'installation must verify all commit characters')

  let route
  let installs = 0
  Object.assign(ctx, {
    profileContext: { dir },
    pluginManager: { listBundles: async () => [], installBundle: async () => { installs++ } },
    emit() {}, on() {},
    inject(names, callback) { callback({ connection: { fetch: { register(value) { route = value } } } }) },
  })
  apply(ctx)
  const request = new Request('http://localhost/api/plugin-upgrader', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'sources', method: 'plugin-upgrader',
      payload: { method: 'upgrade.start', payload: { name: 'external' } } }),
  })
  const response = await (await route.fetch(request)).json()
  assert.equal(response.result.error.code, 'plugin-upgrader/not-newer')
  assert.equal(installs, 0, 'crafted update must not downgrade a disk-installed plugin')
  assert.equal(commands.filter((argv) => argv.includes('view')).length, 1, 'Git checks never query npm')
  registryVersion = '2.1.0'
  ctx.pluginManager.installBundle = async (spec) => {
    installs++
    assert.equal(spec, 'external@2.1.0')
    await writeFile(join(dir, 'node_modules', 'external', 'package.json'), JSON.stringify({
      name: 'external', version: '2.1.0', dsh: { manifestVersion: 1 },
    }))
    return { application: 'restart-required', target: 'external' }
  }
  const rpc = async (method, payload) => (await (await route.fetch(new Request('http://localhost/api/plugin-upgrader', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'external', method: 'plugin-upgrader', payload: { method, payload } }),
  }))).json()).result
  assert.equal((await rpc('upgrade.start', { name: 'external', requestId: 'external-update' })).ok, true)
  let settled
  for (let attempt = 0; attempt < 100; attempt++) {
    settled = await rpc('upgrade.status', { requestId: 'external-update' })
    if (settled.value.run.running === false) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(settled.value.run.running, false)
  assert.equal(settled.value.run.verification.changed, true, 'externally installed plugin can be upgraded and verified')
  assert.equal(installs, 1)
  assert.equal(commands.filter((argv) => argv.includes('view')).length, 2, 'post-install verification must not access the network')
  console.log('PASS: independent discovery, source preservation, repeated branch tracking, unknown commits and downgrade refusal')
} finally {
  await rm(dir, { recursive: true, force: true })
}
