/**
 * "Is there a newer version?" — the question DSH itself refuses to answer.
 *
 * `pluginManager.inspect(spec)` rejects anything already installed with
 * `problem: 'already-installed'`, and there is no "check for updates" service at all, so
 * this module asks the registry directly.
 *
 * Two rules learned from the shipped implementation:
 *
 *  1. Never invoke a bare `pnpm`. Under Desktop, pnpm is Electron re-entered as Node:
 *     `{ command: <electron>, args: ['--expose-internals', <pnpm.mjs>], env: {ELECTRON_RUN_AS_NODE:'1'} }`.
 *     `pluginManager` itself always spreads `profileContext.packageManager ?? {command: 'pnpm'}`,
 *     and we do the same, falling back only when a headless profile supplies none.
 *  2. Never invent a registry order. `pluginManager.registries()` returns exactly the
 *     sequence official installs use, including its "do not fall back from a private
 *     registry to a public one" semantics.
 */
import { SHAPE, commitFromResolved, gitRefOf, gitUrlOf } from './shapes.js'
import { bumpKind, isNewer, compareVersions } from './semver.js'

/** Registry query timeout, in milliseconds. */
const VIEW_TIMEOUT_MS = 30_000

/**
 * Read a subprocess's collected stdout after its exit.
 * @param {any} handle - a `SubprocessHandle`.
 * @returns {Promise<string>} the collected text, or `''`.
 */
async function collectedStdout(handle) {
  try {
    const reader = handle?.collected?.stdout
    if (reader === undefined || typeof reader.readFrom !== 'function') return ''
    const read = reader.readFrom(0)
    return typeof read?.text === 'string' ? read.text : ''
  } catch {
    return ''
  }
}

/**
 * Read a subprocess's collected stderr after its exit.
 * @param {any} handle - a `SubprocessHandle`.
 * @returns {Promise<string>} the collected text, or `''`.
 */
async function collectedStderr(handle) {
  try {
    const reader = handle?.collected?.stderr
    if (reader === undefined || typeof reader.readFrom !== 'function') return ''
    const read = reader.readFrom(0)
    return typeof read?.text === 'string' ? read.text : ''
  } catch {
    return ''
  }
}

/**
 * Run one argv in the profile directory through the profile's own package manager.
 * @param {object} input - execution inputs.
 * @param {any} input.ctx - the plugin context (for `ctx.subprocess`).
 * @param {any} input.profile - `profileContext`.
 * @param {string[]} input.argv - arguments appended after the package manager's own args.
 * @param {AbortSignal} [input.signal] - cancellation.
 * @returns {Promise<{exitCode: number|null, stdout: string, stderr: string, command: string}>}
 *   the run's outcome; never rejects for a non-zero exit.
 */
export async function runPackageManager({ ctx, profile, argv, signal }) {
  const pm = profile?.packageManager
  const command = typeof pm?.command === 'string' && pm.command !== '' ? pm.command : 'pnpm'
  const baseArgs = Array.isArray(pm?.args) ? pm.args : []
  return runArgv({ ctx, profile, argv: [command, ...baseArgs, ...argv], commandLabel: [command, ...baseArgs].join(' '), signal })
}

/**
 * Run one argv directly, with no package manager in front of it.
 *
 * This exists because `pnpm exec git …` is NOT a transparent way to run git: `pnpm exec`
 * performs a dependency pre-flight (`runDepsStatusCheck`), so in a profile whose tree is not
 * perfectly reconciled it fails with an unrelated install error before git ever runs — and in
 * a no-TTY context it can fail on the modules-directory purge prompt instead. A git query is
 * a git query; wrapping it in the package manager imported the package manager's failure modes
 * for no benefit. (Reported live: this made a perfectly reachable remote read as unreachable.)
 * @param {object} input - execution inputs.
 * @param {any} input.ctx - the plugin context (for `ctx.subprocess`).
 * @param {any} input.profile - `profileContext`, used for cwd and environment only.
 * @param {string[]} input.argv - the full command line.
 * @param {string} [input.commandLabel] - a display form of the command.
 * @param {Record<string, string>} [input.env] - extra environment entries for this call only.
 * @param {AbortSignal} [input.signal] - cancellation.
 * @returns {Promise<{exitCode: number|null, stdout: string, stderr: string, command: string}>}
 *   the run's outcome; never rejects for a non-zero exit.
 */
export async function runArgv({ ctx, profile, argv, commandLabel, env, signal }) {
  const subprocess = ctx.get?.('subprocess') ?? ctx.subprocess
  if (subprocess === undefined || typeof subprocess.spawn !== 'function') {
    throw new Error('subprocess service unavailable; cannot query versions in this profile')
  }

  const pm = profile?.packageManager
  // The package manager's env matters here (it carries ELECTRON_RUN_AS_NODE and PATH), so it is
  // applied even for a plain git call; `env` then layers this call's own entries on top.
  const mergedEnv = pm?.env === undefined && env === undefined
    ? undefined
    : { ...process.env, ...pm?.env, ...env }
  const handle = subprocess.spawn({
    argv,
    cwd: profile.dir,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 262_144 },
      stderr: { maxBytes: 262_144 },
    },
    graceMs: 2000,
    ...(mergedEnv === undefined ? {} : { env: mergedEnv }),
    ...(signal === undefined ? {} : { signal }),
  })

  const outcome = await handle.done
  return {
    exitCode: typeof outcome?.exitCode === 'number' ? outcome.exitCode : null,
    stdout: await collectedStdout(handle),
    stderr: await collectedStderr(handle),
    command: commandLabel ?? argv.join(' '),
  }
}

/**
 * Parse the JSON or bare text a `pnpm view <name> version` prints.
 * @param {string} stdout - the command's stdout.
 * @returns {string|null} the version string, or null when unreadable.
 */
export function parseViewVersion(stdout) {
  const text = String(stdout ?? '').trim()
  if (text === '') return null
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed === 'string') return parsed
    // `pnpm view <name> version` with multiple versions prints an array.
    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[parsed.length - 1] === 'string') {
      return parsed[parsed.length - 1]
    }
  } catch {
    // Fall through to the bare-text reading below.
  }
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(text)
  return match === null ? null : match[1]
}

/**
 * Ask the registry for a package's newest version.
 * @param {object} input - query inputs.
 * @param {any} input.ctx - the plugin context.
 * @param {any} input.profile - `profileContext`.
 * @param {string} input.name - the package name.
 * @param {string|null} [input.registry] - the registry to ask first, or null for pnpm's own.
 * @param {AbortSignal} [input.signal] - cancellation.
 * @returns {Promise<{ok: true, version: string}|{ok: false, reason: string, detail: string}>}
 *   the newest version, or a classified failure the UI can explain.
 */
export async function queryLatestVersion({ ctx, profile, name, registry, signal }) {
  const args = ['view', name, 'version', '--json', '--config.fetch-retries=0']
  if (typeof registry === 'string' && registry !== '') args.push(`--registry=${registry}`)

  let run
  try {
    run = await withTimeout(
      runPackageManager({ ctx, profile, argv: args, signal }),
      VIEW_TIMEOUT_MS,
      signal,
    )
  } catch (error) {
    return {
      ok: false,
      reason: 'spawn-failed',
      detail: error instanceof Error ? error.message : String(error),
    }
  }

  if (run.exitCode !== 0) {
    const detail = (run.stderr || run.stdout || '').trim()
    // Distinguish "no such package" from "network down": the user's remedy differs.
    const notFound = /E404|not found|No matching version/i.test(detail)
    return {
      ok: false,
      reason: notFound ? 'not-found' : 'registry-unreachable',
      detail: detail.slice(-2000) || `exit code ${String(run.exitCode)}`,
    }
  }

  const version = parseViewVersion(run.stdout)
  if (version === null) {
    return { ok: false, reason: 'unparsable', detail: String(run.stdout ?? '').trim().slice(-2000) }
  }
  return { ok: true, version }
}

/**
 * Ask a git remote for its current HEAD commit.
 *
 * Runs `git` DIRECTLY. Going through `pnpm exec git` would drag in pnpm's dependency
 * pre-flight, which fails for reasons entirely unrelated to the remote — see {@link runArgv}.
 * @param {object} input - query inputs.
 * @param {any} input.ctx - the plugin context.
 * @param {any} input.profile - `profileContext`.
 * @param {string} input.url - the repository URL.
 * @param {string} [input.ref] - the branch/tag to query; defaults to `HEAD`.
 * @param {AbortSignal} [input.signal] - cancellation.
 * @returns {Promise<{ok: true, commit: string}|{ok: false, reason: string, detail: string}>}
 *   HEAD's commit, or a classified failure.
 */
export async function queryRemoteHead({ ctx, profile, url, ref, signal }) {
  // A dependency that tracks a named branch must be read at THAT branch: an upgrade pins to
  // whatever commit is returned here, so querying HEAD for a `#develop` dependency would
  // install — and freeze — code from the wrong branch.
  const target = typeof ref === 'string' && ref.trim() !== '' ? ref.trim() : 'HEAD'
  let run
  try {
    run = await withTimeout(
      runArgv({
        ctx,
        profile,
        // `-c credential.helper=` DISABLES the credential helper for this one invocation.
        //
        // `GIT_TERMINAL_PROMPT=0` alone is NOT enough on Windows: it only stops git asking on the
        // terminal. Git Credential Manager is a separate GUI program, so a private (or even a
        // GitHub-authenticated) remote pops a "Enter your credentials for https://…" window that
        // nothing can dismiss and that silently stalls the query. Official DSH's own
        // `checkGithubConnection` passes this same flag, plus the ASKPASS variables below, for
        // exactly this reason.
        argv: ['git', '-c', 'credential.helper=', 'ls-remote', url, target],
        commandLabel: `git ls-remote ${url} ${target}`,
        // Belt and braces: block every other way git can reach a human.
        env: {
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: '',
          SSH_ASKPASS: '',
          SSH_ASKPASS_REQUIRE: 'never',
        },
        signal,
      }),
      VIEW_TIMEOUT_MS,
      signal,
    )
  } catch (error) {
    return {
      ok: false,
      reason: 'spawn-failed',
      detail: error instanceof Error ? error.message : String(error),
    }
  }

  if (run.exitCode !== 0) {
    const detail = (run.stderr || run.stdout || '').trim()
    // A missing `git` binary is a different remedy from an unreachable remote, so keep them apart.
    const missing = /ENOENT|not recognized|not found/i.test(detail)
    return {
      ok: false,
      reason: missing ? 'git-missing' : 'git-unreachable',
      detail: detail.slice(-2000) || `exit code ${String(run.exitCode)}`,
    }
  }

  const match = /\b([0-9a-f]{7,40})\b/i.exec(run.stdout)
  if (match === null) return { ok: false, reason: 'unparsable', detail: run.stdout.slice(-2000) }
  return { ok: true, commit: match[1] }
}

/**
 * Race a promise against a timeout.
 * @template T
 * @param {Promise<T>} promise - the work.
 * @param {number} ms - the budget.
 * @param {AbortSignal} [outer] - an external cancellation signal.
 * @returns {Promise<T>} the result, or a rejection when the budget elapses.
 */
function withTimeout(promise, ms, outer) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`timed out after ${String(ms)}ms`))
    }, ms)
    const onAbort = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    if (outer !== undefined) {
      if (outer.aborted) onAbort()
      else outer.addEventListener('abort', onAbort, { once: true })
    }
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        outer?.removeEventListener?.('abort', onAbort)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        outer?.removeEventListener?.('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * Check one candidate for an available update.
 * @param {object} input - check inputs.
 * @param {any} input.ctx - the plugin context.
 * @param {any} input.profile - `profileContext`.
 * @param {object} input.candidate - one entry from `buildCandidates`.
 * @param {string|null} [input.registry] - the registry to ask first.
 * @param {AbortSignal} [input.signal] - cancellation.
 * @returns {Promise<object>} a status record the UI renders verbatim.
 */
export async function checkCandidate({ ctx, profile, candidate, registry, signal }) {
  const base = {
    name: candidate.name,
    installedVersion: candidate.installedVersion,
    shape: candidate.shape,
    enabled: candidate.enabled,
    description: candidate.description,
  }

  if (candidate.shape === SHAPE.LINK || candidate.shape === SHAPE.FILE) {
    return {
      ...base,
      status: 'local',
      latestVersion: null,
      message: candidate.shape === SHAPE.LINK
        ? '本地链接（link:），没有远端可比对，需自行管理'
        : '本地文件（file:），没有远端可比对，需自行管理',
    }
  }

  if (candidate.shape === SHAPE.GIT) {
    if (candidate.trackingError) return { ...base, status: 'error', latestVersion: null,
      message: '无法读取 Git 分支跟踪记录，请修复记录后重试', detail: candidate.trackingError }
    const url = candidate.trackedSpecifier ?? candidate.specifier ?? candidate.lockfileSpecifier
    if (/#(?:.*&)?(?:path:|semver:)/.test(url ?? '')) {
      return { ...base, status: 'unknown', latestVersion: null, message: 'Git 子目录或版本范围安装暂不支持自动检查，请按原来源手动更新' }
    }
    const repoUrl = gitUrlOf(url ?? candidate.lockfileVersion)
    if (repoUrl === null) {
      return { ...base, status: 'unknown', latestVersion: null, message: '无法从依赖声明中解析出 git 地址' }
    }
    // Read the ref the dependency actually tracks: querying HEAD for a `#develop` dependency
    // would compare against the wrong branch and report a bogus "new commits" verdict.
    const result = await queryRemoteHead({ ctx, profile, url: repoUrl, ref: gitRefOf(url), signal })
    if (!result.ok) {
      const gitMessages = {
        'git-missing': '系统里找不到 git，无法比对远端提交',
        'git-unreachable': '远端不可达（git ls-remote 失败）',
        unparsable: 'git 返回了无法解析的结果',
        'spawn-failed': '无法启动 git',
      }
      return {
        ...base,
        status: 'error',
        latestVersion: null,
        message: gitMessages[result.reason] ?? 'Git 检查失败',
        detail: result.detail,
      }
    }
    const pinned = commitFromResolved(candidate.specifier)
      ?? commitFromResolved(candidate.lockfileVersion ?? candidate.resolvedCommit)
    if (pinned === null) {
      return { ...base, status: 'unknown', latestVersion: null, latestCommit: result.commit,
        pinnedCommit: null, message: '无法读取当前安装的 Git 提交，请检查依赖声明和锁文件后重试' }
    }
    const currentCommit = pinned.toLowerCase()
    const remoteCommit = result.commit.toLowerCase()
    const changed = !remoteCommit.startsWith(currentCommit) && !currentCommit.startsWith(remoteCommit)
    return {
      ...base,
      status: changed ? 'outdated' : 'current',
      latestVersion: null,
      latestCommit: result.commit,
      pinnedCommit: pinned,
      updateKind: changed ? 'commit' : 'none',
      message: changed
        ? `远端有新提交（${String(pinned).slice(0, 7)} → ${result.commit.slice(0, 7)}）`
        : '已是最新提交',
    }
  }

  if (candidate.shape !== SHAPE.REGISTRY) {
    return {
      ...base,
      status: 'unknown',
      latestVersion: null,
      message: `无法判断这个插件的依赖形态（${candidate.shape}），请用官方插件页手动处理`,
      detail: candidate.specifier === null
        ? `profile 的 package.json 里没有 ${candidate.name} 的依赖声明，无法确定它从哪里来。`
        : `依赖声明是 ${String(candidate.specifier)}，本插件不识别这种形态。`,
    }
  }

  const result = await queryLatestVersion({ ctx, profile, name: candidate.name, registry, signal })
  if (!result.ok) {
    const messages = {
      'registry-unreachable': '注册表不可达，无法检查更新',
      'not-found': '注册表里找不到这个包（可能已改名或未发布）',
      'spawn-failed': '无法启动包管理器（pnpm）',
      unparsable: '注册表返回了无法解析的版本号',
    }
    return {
      ...base,
      status: 'error',
      latestVersion: null,
      message: messages[result.reason] ?? '检查更新失败',
      detail: result.detail,
    }
  }

  const current = candidate.installedVersion
  if (compareVersions(result.version, current) === null) {
    return { ...base, status: 'unknown', latestVersion: result.version,
      message: '无法确认当前安装版本，请检查插件安装信息后重试' }
  }
  const newer = current !== null && isNewer(result.version, current)
  return {
    ...base,
    status: newer ? 'outdated' : 'current',
    latestVersion: result.version,
    updateKind: newer ? bumpKind(result.version, current) : 'none',
    message: newer ? `${String(current)} → ${result.version}` : '已是最新版本',
  }
}
