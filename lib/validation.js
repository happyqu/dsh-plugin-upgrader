import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { createRequire } from 'node:module'
import { runArgv, runRemoteGit } from './registry.js'

/** Inspect the exact Git target without checking out files or running build scripts. */
export async function checkGitPackageName({ ctx, profile, name, url, commit }) {
  let dir
  try {
    if (!/^[0-9a-f]{40,64}$/i.test(commit)) throw new Error('目标提交格式无效')
    dir = await mkdtemp(join(tmpdir(), 'dsh-upgrader-preflight-'))
    const signal = AbortSignal.timeout(30_000)
    // `git init` is purely local, so it needs neither the credential guard nor a retry.
    const init = await runArgv({ ctx, profile, argv: ['git', 'init', '--bare', dir], signal })
    if (init.exitCode !== 0) throw new Error(init.stderr || init.stdout || 'Git 初始化失败')
    // `git fetch` contacts the REMOTE, so it goes through `runRemoteGit`: that carries the
    // credential-helper override (without it a 401 opens Git Credential Manager's undismissable
    // GUI prompt) and retries the transient failures a gitee-hosted remote answers with —
    // including the intermittent 401 that git itself will not retry. See registry.js.
    const fetched = await runRemoteGit({
      ctx,
      profile,
      argv: ['git', '-c', 'credential.helper=', '-C', dir, 'fetch', '--depth=1', '--no-tags', '--', url, commit],
      commandLabel: `git fetch ${url} ${commit}`,
      signal,
    })
    if (fetched.exitCode !== 0) throw new Error(fetched.stderr || fetched.stdout || 'Git 读取失败')
    const result = await runArgv({
      ctx, profile, argv: ['git', '-C', dir, 'show', `${commit}:package.json`], signal,
    })
    if (result.exitCode !== 0) throw new Error('目标提交中无法读取 package.json')
    const manifest = JSON.parse(result.stdout)
    if (typeof manifest.name !== 'string' || manifest.name === '') throw new Error('目标提交未声明有效包名')
    if (manifest.name !== name) {
      return {
        ok: false,
        error: {
          code: 'plugin-upgrader/package-renamed',
          message: `已停止升级：当前依赖名为 ${name}，目标提交声明的包名为 ${manifest.name}。`
            + '升级器不自动迁移包名；请按上游迁移说明统一依赖、插件配置和前端注册名称后再安装。当前安装未修改。',
        },
      }
    }
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'plugin-upgrader/preflight-failed',
        message: `无法验证 ${name} 目标提交的包名，已停止升级，当前安装未修改。`
          + `原因：${error instanceof Error ? error.message : String(error)}`,
      },
    }
  } finally {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
}

/** Select the same standard conditions used by Node's ESM loader, preserving key order. */
function importTarget(value) {
  if (typeof value === 'string' || value === null) return value
  if (Array.isArray(value)) {
    for (const entry of value) {
      const target = importTarget(entry)
      if (target !== undefined && target !== null) return target
    }
  } else if (value !== undefined && typeof value === 'object') {
    for (const [condition, entry] of Object.entries(value)) {
      if (!['node', 'import', 'default', 'node-addons'].includes(condition)) continue
      const target = importTarget(entry)
      if (target !== undefined) return target
    }
  }
  return undefined
}

/** Resolve declared ESM exports without executing the package or requiring a CJS export. */
function entryPath(root, manifest, subpath) {
  const exports = manifest.exports
  const isMap = exports !== null && typeof exports === 'object'
    && !Array.isArray(exports) && Object.keys(exports).some((key) => key.startsWith('.'))
  const declaration = isMap ? exports[subpath] : subpath === '.' ? exports : undefined
  if (exports !== undefined && declaration !== undefined) {
    const target = importTarget(declaration)
    if (typeof target !== 'string' || !target.startsWith('./')) throw new Error(`入口 ${subpath} 没有可用的 ESM 导出`)
    const path = resolve(root, target)
    const rel = relative(root, path)
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`入口 ${subpath} 指向包目录之外`)
    return path
  }
  if (subpath === '.') {
    // A configuration-only bundle may have no host entry of its own.
    if (exports !== undefined || typeof manifest.main !== 'string') return null
    return createRequire(join(root, 'package.json')).resolve(resolve(root, manifest.main))
  }
  return createRequire(join(root, 'package.json')).resolve(`${manifest.name}/client`)
}

/** Read installed metadata and entry files; never import or execute the plugin. */
export async function checkInstalledPackage({ profileDir, name }) {
  try {
    const root = join(profileDir, 'node_modules', name)
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    if (manifest.name !== name) {
      throw new Error(`安装名称 ${name} 与包声明名称 ${String(manifest.name)} 不一致，需要按上游说明迁移`)
    }
    const host = entryPath(root, manifest, '.')
    if (host !== null) await readFile(host)
    // Native ESM clients need not use __ModuleLoader__. Only diagnose an explicit
    // registration in DSH's wrapper; other formats remain outside this static check.
    if (manifest.dsh?.client !== undefined) {
      const client = entryPath(root, manifest, './client')
      const source = await readFile(client, 'utf8')
      const registration = /(?:window\.)?__ModuleLoader__\.load\(\s*\{\s*id\s*:\s*(["'])([^"']+)\1/.exec(source)
      if (registration !== null && registration[2] !== name) {
        throw new Error(`前端注册名称 ${registration[2]} 与安装名称 ${name} 不一致`)
      }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}
