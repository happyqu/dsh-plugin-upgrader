/**
 * @happyqu/dsh-plugin-upgrader — Host half.
 *
 * Answers the one question DSH does not: "which of my third-party plugins have a newer
 * version?" — and then installs it for you.
 *
 * Why this plugin exists at all:
 *   - DSH has no "upgrade" action. The official tool exposes install/remove/enable, and
 *     `inspect()` actively refuses an already-installed package with `already-installed`,
 *     so nothing in the runtime can tell you an update exists.
 *   - An update is therefore assembled from two halves: our own registry query for
 *     "is there something newer", plus the official `installBundle(name@version)` to
 *     actually place it on disk. That call always settles as `restart-required`, which is
 *     a property of the runtime, not a shortcut of ours.
 *
 * Design constraints worth keeping in mind while reading:
 *   - ZERO `@deepseek-ai/dsh-*` imports. DSH drops an entire bundle whose declared peer
 *     range mismatches the running runtime, and an upgrader that gates itself out of
 *     action would be self-defeating. Everything comes from services or node: builtins.
 *   - `connection` is an OPTIONAL injection. It exists only under the Web bundle; a static
 *     inject would leave this plugin permanently pending in a headless profile and fail
 *     the profile with "plugin tree failed to load: 1 entry did not activate".
 *   - `apply()` performs NO network work. Version checks are lazy, triggered by the first
 *     request from the UI, so plugin startup cost stays zero.
 *
 * See README.md for the user-facing behaviour and the upgrade semantics.
 */
import { CheckCache } from './cache.js'
import { Config } from './config.js'
import { buildCandidates } from './discover.js'
import { checkCandidate, queryLatestVersion, queryRemoteHead } from './registry.js'
import { SHAPE, gitRefOf, gitUpgradeSpec, gitUrlOf, readLockfile, readProfileManifest } from './shapes.js'
import { UpgradeTracker, interpretResult } from './upgrade.js'

// Re-exported so Cordis can validate the patch layer's `config:` block and so the official
// Plugins page can render an editable form for it. This is a hand-written Standard Schema
// (`./config.js`), NOT a plain object and NOT a `@deepseek-ai/schemastery` schema — a plain
// object aborts activation inside Cordis, and the real package is a dependency this plugin
// must not take.
export { Config }

/** Endpoint name used by `connection.rpc.call('/api', …)` from the browser. */
const RPC_ENDPOINT = 'plugin-upgrader'
/** Absolute route path below `/api`. */
const RPC_PATH = '/api/plugin-upgrader'

/** This plugin's own package name, never offered as an upgrade target. */
const SELF_NAME = '@happyqu/dsh-plugin-upgrader'

/**
 * Plugin name, as the loader entry and the client bundle both refer to it.
 */
export const name = 'plugin-upgrader'

// `connection` is deliberately absent here; see the note above.
export const inject = ['pluginManager', 'profileContext']

/** Default policy, applied when the patch supplies no override. Kept in sync with `./config.js`. */
const DEFAULTS = {
  /** How long a successful check stays fresh, in milliseconds. */
  checkTtlMs: 6 * 60 * 60 * 1000,
  /** Maximum overlapping registry queries. */
  concurrency: 3,
  /** Package names, or `name@version` pairs, to hide from the upgrade list. */
  ignored: [],
}

/**
 * Build the reply envelope the browser client understands.
 * @param {string} rpcId - correlation id echoed from the request.
 * @param {object} result - the `{ok, value}` or `{ok: false, error}` payload.
 * @returns {Response} the JSON response.
 */
function reply(rpcId, result) {
  const value = typeof result === 'object' && result !== null && result.ok === false
    ? { ...result, error: { details: {}, ...result.error } }
    : result
  return Response.json({ type: 'server-response', rpcId, result: value })
}

/**
 * Normalize the plugin's resolved configuration.
 *
 * Cordis passes the validated config as `apply`'s SECOND argument
 * (`runtime.callback(this.ctx, this.config)`), and reading `ctx.config` instead throws
 * "cannot get property \"config\" without inject". Every field is optional: an absent patch
 * block means `config` is undefined here.
 * @param {any} raw - the config Cordis resolved, if any.
 * @returns {{ttlMs: number, concurrency: number, ignored: string[]}} resolved policy.
 */
function resolveConfig(raw) {
  const source = raw ?? {}
  const ttlMs = Number(source.checkTtlMs)
  const concurrency = Number(source.concurrency)
  const ignored = Array.isArray(source.ignored)
    ? source.ignored.filter((item) => typeof item === 'string' && item.trim() !== '')
    : []
  return {
    ttlMs: Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : DEFAULTS.checkTtlMs,
    concurrency: Number.isFinite(concurrency) && concurrency >= 1
      ? Math.min(16, Math.floor(concurrency))
      : DEFAULTS.concurrency,
    ignored,
  }
}

/**
 * Decide whether a candidate is muted by the ignore list.
 * @param {object} candidate - one discovery candidate.
 * @param {string} latestVersion - its newest known version, when any.
 * @param {string[]} ignored - the configured ignore entries.
 * @returns {boolean} true when the plugin or that exact version is ignored.
 */
function isIgnored(candidate, latestVersion, ignored) {
  if (ignored.includes(candidate.name)) return true
  if (typeof latestVersion === 'string' && ignored.includes(`${candidate.name}@${latestVersion}`)) return true
  return false
}

/**
 * Mount the plugin.
 * @param {any} ctx - the plugin context.
 * @param {any} [rawConfig] - the config Cordis resolved from the patch layer.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const pluginManager = ctx.pluginManager
  const profile = ctx.profileContext
  const logger = ctx.logger ?? console
  const config = resolveConfig(rawConfig)
  const cache = new CheckCache({ ttlMs: config.ttlMs, concurrency: config.concurrency })

  // Defensive reads: the published `ProfileContext` signature lists only a few fields,
  // while the running object carries more. Fail loudly rather than letting `undefined`
  // travel into a filesystem call.
  const profileDir = typeof profile?.dir === 'string' ? profile.dir : null
  if (profileDir === null) {
    logger.warn?.('[plugin-upgrader] profileContext.dir unavailable; upgrade checks disabled')
  }

  /** Notify connected browsers that a run changed. */
  const notify = () => {
    try {
      ctx.emit('plugin-upgrader/changed', { at: Date.now() })
    } catch {
      // Emitting is best-effort; a missing listener must never break an install.
    }
  }

  const tracker = new UpgradeTracker({ ctx, pluginManager, onProgress: notify })

  /** The registry the user's installs would ask first, or null for pnpm's own. */
  let registryOverride = null

  /**
   * List every managed third-party plugin WITHOUT any network access.
   *
   * Checking for updates costs one `pnpm view` (registry) or one `git ls-remote` (git) per
   * plugin, so doing it for every plugin on page open makes opening the page the expensive
   * action. This separates "what do I have" from "what is new": the list is derived purely from
   * local files and the live bundle inventory, and the checks run only when asked.
   * @returns {Promise<object>} the roster the UI renders before any check has run.
   */
  async function list() {
    if (profileDir === null) return noProfile()

    const bundles = await pluginManager.listBundles()
    const manifest = await readProfileManifest(profileDir)
    const lock = await readLockfile(profileDir)
    const candidates = buildCandidates({
      bundles,
      dependencies: manifest.dependencies,
      lockfile: lock,
      selfName: SELF_NAME,
    })

    const visible = candidates.filter((candidate) => {
      return !isIgnored(candidate, null, config.ignored)
    })

    return {
      ok: true,
      value: {
        profile: profileDir,
        registry: registryOverride,
        ttlMs: config.ttlMs,
        checkedAt: null,
        summary: summarize(visible.map((candidate) => unCheckedRecord(candidate))),
        plugins: visible.map((candidate) => unCheckedRecord(candidate)),
      },
    }
  }

  /**
   * Build the pre-check record for one candidate: identity only, status `unchecked`.
   * @param {any} candidate - one discovery candidate.
   * @returns {object} the record the UI renders as "未检查".
   */
  function unCheckedRecord(candidate) {
    return {
      name: candidate.name,
      installedVersion: candidate.installedVersion,
      latestVersion: null,
      status: 'unchecked',
      shape: candidate.shape,
      enabled: candidate.enabled,
      description: candidate.description,
      message: candidate.local ? '本地依赖，没有远端可比对' : '尚未检查，点击「检查更新」',
      upgradable: false,
      target: null,
      ignored: false,
    }
  }

  /**
   * Count one set of records into the summary the UI shows.
   * @param {any[]} records - check records.
   * @returns {object} counts per status.
   */
  function summarize(records) {
    return {
      total: records.length,
      outdated: records.filter((item) => item.status === 'outdated').length,
      current: records.filter((item) => item.status === 'current').length,
      local: records.filter((item) => item.status === 'local').length,
      error: records.filter((item) => item.status === 'error').length,
      unchecked: records.filter((item) => item.status === 'unchecked').length,
      ignored: records.filter((item) => item.ignored === true).length,
    }
  }

  /** The standard refusal when the profile directory is unavailable. */
  function noProfile() {
    return {
      ok: false,
      error: {
        code: 'plugin-upgrader/no-profile',
        message: 'profileContext.dir 不可用，无法检查插件版本（该 profile 可能不是文件型 profile）。',
      },
    }
  }

  /**
   * Check one plugin for an available update.
   *
   * Scoped to a single plugin on purpose: the caller decides what to pay for, so a roster of
   * twenty plugins never turns one click into twenty network calls.
   * @param {string|null} only - the package name to check; null/absent means every plugin.
   * @param {boolean} force - ignore fresh cache entries.
   * @returns {Promise<object>} the checked record(s).
   */
  async function check({ only = null, force = false } = {}) {
    if (profileDir === null) return noProfile()

    const bundles = await pluginManager.listBundles()
    const manifest = await readProfileManifest(profileDir)
    const lock = await readLockfile(profileDir)
    const candidates = buildCandidates({
      bundles,
      dependencies: manifest.dependencies,
      lockfile: lock,
      selfName: SELF_NAME,
    }).filter((candidate) => (only === null ? true : candidate.name === only))

    if (candidates.length === 0) {
      return {
        ok: false,
        error: {
          code: 'plugin-upgrader/not-managed',
          message: only === null
            ? '没有可检查的第三方插件。'
            : `${only} 不在可管理的第三方插件列表里。`,
        },
      }
    }

    if (registryOverride === null) {
      try {
        const registries = await pluginManager.registries()
        registryOverride = typeof registries?.registry === 'string' ? registries.registry : null
      } catch (error) {
        logger.warn?.('[plugin-upgrader] could not read registries; using pnpm defaults', error)
      }
    }

    const checks = await Promise.all(candidates.map(async (candidate) => {
      const { value, cached, stale } = await cache.get(
        candidate.name,
        () => checkCandidate({
          ctx,
          profile,
          candidate,
          registry: registryOverride,
        }),
        { force },
      )
      const record = { ...value, cached, stale }
      record.ignored = isIgnored(candidate, value?.latestVersion ?? null, config.ignored)
      // The actionable facts, decided on the Host so the client never has to infer them from
      // shape-specific fields. A git update has a target COMMIT and no target version, which
      // is precisely what the UI used to render as "升级到 null".
      record.upgradable = record.status === 'outdated'
        && (candidate.shape === SHAPE.REGISTRY || candidate.shape === SHAPE.GIT)
      record.target = record.status !== 'outdated'
        ? null
        : candidate.shape === SHAPE.GIT
          ? (typeof value?.latestCommit === 'string' ? value.latestCommit.slice(0, 7) : '远端最新提交')
          : (value?.latestVersion ?? null)
      return record
    }))

    const visible = checks.filter((item) => item.ignored !== true)
    return {
      ok: true,
      value: {
        profile: profileDir,
        registry: registryOverride,
        ttlMs: config.ttlMs,
        checkedAt: Date.now(),
        summary: summarize(visible),
        plugins: visible,
      },
    }
  }

  /**
   * Start one upgrade.
   *
   * The client sends only a package NAME. The Host resolves the actual install spec, because
   * the correct spec depends on the dependency shape and a version number cannot express the
   * git case at all:
   *   registry -> `name@1.2.3`
   *   git      -> the repository URL, un-pinned, so pnpm re-resolves the branch HEAD
   *   link     -> refused (there is no remote to upgrade from)
   * @param {any} payload - `{name, requestId?}`.
   * @returns {Promise<object>} the initial run snapshot, or a refusal.
   */
  async function startUpgrade(payload) {
    const pluginName = typeof payload?.name === 'string' ? payload.name : null
    const requestId = typeof payload?.requestId === 'string' && payload.requestId !== ''
      ? payload.requestId
      : `upgrade-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

    if (pluginName === null) {
      return { ok: false, error: { code: 'plugin-upgrader/bad-request', message: '缺少 name' } }
    }
    // Never let a crafted request hand us a spec that `pnpm add` would read as a flag or a
    // second package. The name is validated, not merely interpolated.
    if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i.test(pluginName)) {
      return { ok: false, error: { code: 'plugin-upgrader/bad-request', message: `非法的包名：${pluginName}` } }
    }

    // Resolve the spec from live profile facts rather than trusting the caller.
    let resolved
    try {
      resolved = await resolveUpgradeSpec(pluginName)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: { code: 'plugin-upgrader/resolve-failed', message } }
    }
    if (resolved.ok !== true) return resolved

    const run = tracker.start({
      requestId,
      name: pluginName,
      spec: resolved.value.spec,
      label: resolved.value.label,
      // Re-read the plugin's installed state after the install settles. A pnpm run can exit 0
      // having changed nothing (observed live on a git dependency whose specifier was unchanged),
      // and reporting that as success would be a lie.
      verify: () => recheckOne(pluginName),
    })
    // The cache now describes a state we just replaced; drop it so the next check is honest.
    cache.clear()
    return { ok: true, value: run }
  }

  /**
   * Re-check ONE plugin against live facts, bypassing the cache.
   *
   * Used to confirm an install actually changed something. Deliberately not the cached `check`:
   * the whole point is to observe the post-install disk state, so a cached record would defeat it.
   * @param {string} name - the package name.
   * @returns {Promise<object|null>} the freshly checked record, or null when it cannot be read.
   */
  async function recheckOne(name) {
    if (profileDir === null) return null
    const bundles = await pluginManager.listBundles()
    const manifest = await readProfileManifest(profileDir)
    const lock = await readLockfile(profileDir)
    const candidate = buildCandidates({
      bundles,
      dependencies: manifest.dependencies,
      lockfile: lock,
      selfName: SELF_NAME,
    }).find((item) => item.name === name)
    if (candidate === undefined) return null
    return checkCandidate({ ctx, profile, candidate, registry: registryOverride })
  }

  /**
   * Resolve the install spec for one plugin, honouring its dependency shape.
   *
   * Re-reads the live profile rather than trusting a cached check record: the record could be
   * minutes old, and a wrong spec here means `pnpm add` installs the wrong thing.
   * @param {string} name - the package name.
   * @returns {Promise<{ok: true, value: {spec: string, label: string, shape: string}}|{ok: false, error: object}>}
   *   the spec to install, or a refusal explaining why this plugin cannot be upgraded.
   */
  async function resolveUpgradeSpec(name) {
    if (profileDir === null) {
      return {
        ok: false,
        error: { code: 'plugin-upgrader/no-profile', message: 'profileContext.dir 不可用，无法升级。' },
      }
    }

    const bundles = await pluginManager.listBundles()
    const manifest = await readProfileManifest(profileDir)
    const lock = await readLockfile(profileDir)
    const candidates = buildCandidates({
      bundles,
      dependencies: manifest.dependencies,
      lockfile: lock,
      selfName: SELF_NAME,
    })

    const candidate = candidates.find((item) => item.name === name)
    if (candidate === undefined) {
      return {
        ok: false,
        error: {
          code: 'plugin-upgrader/not-managed',
          message: `${name} 不在可管理的第三方插件列表里（可能是官方层，或已不在 profile 声明中）。`,
        },
      }
    }

    if (candidate.shape === SHAPE.LINK || candidate.shape === SHAPE.FILE) {
      return {
        ok: false,
        error: {
          code: 'plugin-upgrader/local-dependency',
          message: `${name} 是本地依赖（${candidate.shape}），没有远端可以升级。请直接更新它所在的目录。`,
        },
      }
    }

    if (candidate.shape === SHAPE.GIT) {
      const declared = candidate.specifier ?? candidate.lockfileSpecifier ?? candidate.lockfileVersion
      const url = gitUrlOf(declared) ?? gitUrlOf(candidate.lockfileVersion)
      if (url === null) {
        return {
          ok: false,
          error: {
            code: 'plugin-upgrader/unresolvable-git',
            message: `无法从 ${name} 的依赖声明里解析出 git 地址，无法升级。`,
          },
        }
      }

      // The spec must satisfy TWO independent constraints, and getting either one wrong
      // produces a failure that looks like success. Both were measured against a real profile
      // and pnpm 11.7.0; see the two defects below.
      //
      // (1) It must be NAME-QUALIFIED, i.e. `<name>@…`.
      //     `installBundle` decides which package the run changed by diffing the profile's
      //     `dependencies` before and after pnpm. A git reinstall writes the same URL back, so
      //     that diff is EMPTY, and the manager then falls back to
      //     `Object.keys(after).filter((n) => spec === n || spec.startsWith(`${n}@`))`.
      //     A bare URL matches no key, so `installed.length === 0` and the manager throws
      //     `ambiguous-install` — reporting `application: 'failed'` and restoring
      //     `package.json`/`pnpm-lock.yaml` AFTER pnpm already exited 0. The user saw exactly
      //     that: a green pnpm run followed by "升级失败".
      //
      // (2) It must be COMMIT-PINNED.
      //     pnpm treats an unpinned git specifier — and equally a branch or `HEAD` ref — as
      //     already satisfied by whatever commit the lockfile holds, so it reports
      //     "Already up to date", exits 0, and never re-resolves the branch. Re-installing the
      //     unpinned URL therefore CANNOT upgrade anything past the first time; it is a silent
      //     no-op. Only a spec naming a commit the lockfile does not currently hold forces a
      //     re-resolution.
      //
      // Pinning to the freshly-read HEAD is safe precisely because this function re-reads HEAD
      // on every upgrade: the pin is not a permanent freeze, it is rewritten each time. Pinning
      // to the commit already in the lockfile would be the no-op.
      const head = await queryRemoteHead({ ctx, profile, url, ref: gitRefOf(declared) })
      if (head.ok !== true) {
        const gitMessages = {
          'git-missing': '系统里找不到 git，无法查询远端最新提交',
          'git-unreachable': '远端不可达（git ls-remote 失败）',
          unparsable: 'git 返回了无法解析的结果',
          'spawn-failed': '无法启动 git',
        }
        return {
          ok: false,
          error: {
            code: 'plugin-upgrader/git-unresolved',
            message: `无法确定 ${name} 的远端最新提交，无法升级：${gitMessages[head.reason] ?? 'Git 检查失败'}`
              + (head.detail === undefined || head.detail === '' ? '' : `（${head.detail}）`),
          },
        }
      }

      return {
        ok: true,
        value: {
          spec: gitUpgradeSpec({ name, url, commit: head.commit, declared }),
          label: head.commit.slice(0, 7),
          shape: candidate.shape,
        },
      }
    }

    if (candidate.shape !== SHAPE.REGISTRY) {
      return {
        ok: false,
        error: {
          code: 'plugin-upgrader/unsupported-shape',
          message: `${name} 的依赖形态（${candidate.shape}）不支持自动升级，请用官方插件页处理。`,
        },
      }
    }

    // Registry shape: ask for the exact latest version rather than re-installing the same
    // range, which pnpm would treat as already satisfied and skip.
    const latest = await queryLatestVersion({ ctx, profile, name, registry: registryOverride })
    if (latest.ok !== true) {
      return {
        ok: false,
        error: {
          code: 'plugin-upgrader/version-unknown',
          message: `无法确定 ${name} 的最新版本，无法升级：${latest.detail ?? latest.reason}`,
        },
      }
    }
    return { ok: true, value: { spec: `${name}@${latest.version}`, label: latest.version, shape: candidate.shape } }
  }

  /**
   * Dispatch one client method call.
   * @param {string} method - the method name.
   * @param {any} payload - the method payload.
   * @returns {Promise<object>} the envelope payload.
   */
  async function handleMethod(method, payload) {
    switch (method) {
      // The roster: no network, safe to call on page open.
      case 'list':
        return list()

      // The checks: network per plugin. `only` scopes one plugin; absent means every plugin,
      // which the UI reaches only through an explicit "检查更新" click.
      case 'check':
        return check({
          only: typeof payload?.name === 'string' && payload.name !== '' ? payload.name : null,
          force: payload?.force === true,
        })

      case 'upgrade.start':
        return startUpgrade(payload)

      case 'upgrade.status': {
        const requestId = typeof payload?.requestId === 'string' ? payload.requestId : null
        if (requestId === null) {
          return { ok: false, error: { code: 'plugin-upgrader/bad-request', message: '缺少 requestId' } }
        }
        const run = tracker.status(requestId)
        if (run === null) {
          return { ok: false, error: { code: 'plugin-upgrader/unknown-run', message: '没有这个升级任务' } }
        }
        return {
          ok: true,
          value: {
            run,
            // The profile's real name, so any remediation hint names the right profile.
            verdict: run.phase === 'done'
              ? interpretResult(run.result, {
                profileName: profile?.name,
                verification: run.verification ?? null,
              })
              : null,
          },
        }
      }

      case 'upgrade.cancel': {
        const requestId = typeof payload?.requestId === 'string' ? payload.requestId : null
        if (requestId === null) {
          return { ok: false, error: { code: 'plugin-upgrader/bad-request', message: '缺少 requestId' } }
        }
        return { ok: true, value: await tracker.cancel(requestId) }
      }

      case 'upgrade.runs':
        return { ok: true, value: { runs: tracker.list() } }

      default:
        return {
          ok: false,
          error: { code: 'plugin-upgrader/unknown-method', message: `unknown method: ${String(method)}` },
        }
    }
  }

  // `connection` exists only under the Web bundle, so this injection is optional by
  // design: every other profile simply never registers the endpoint.
  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.connection ?? connectionCtx.get('connection')
    if (connection === undefined || typeof connection?.fetch?.register !== 'function') {
      logger.warn?.('[plugin-upgrader] connection.fetch unavailable; RPC endpoint not registered')
      return
    }
    connection.fetch.register({
      path: RPC_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      async fetch(request) {
        if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
        const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
        if (contentType !== 'application/json') {
          return new Response('content type must be application/json', { status: 415 })
        }
        let message
        try {
          message = await request.json()
        } catch {
          return new Response('body is not JSON', { status: 400 })
        }
        const rpcId = typeof message?.rpcId === 'string' ? message.rpcId : 'invalid-request'
        const call = message?.payload
        if (
          message?.type !== 'client-request'
          || typeof message.rpcId !== 'string'
          || message.method !== RPC_ENDPOINT
          || !call
          || typeof call.method !== 'string'
          || !Object.prototype.hasOwnProperty.call(call, 'payload')
        ) {
          return reply(rpcId, {
            ok: false,
            error: { code: 'plugin-upgrader/bad-request', message: 'Invalid plugin-upgrader request.' },
          })
        }
        try {
          return reply(rpcId, await handleMethod(call.method, call.payload))
        } catch (error) {
          // A bare 500 leaves the client unable to recognize the failure, which surfaces
          // to the user as "clicking does nothing".
          const text = error instanceof Error ? error.message : String(error)
          logger.warn?.(`[plugin-upgrader] ${String(call.method)} failed: ${text}`)
          return reply(rpcId, {
            ok: false,
            error: { code: 'plugin-upgrader/handler-failed', message: text },
          })
        }
      },
    })
    logger.info?.('[plugin-upgrader] RPC endpoint registered')
  })

  logger.info?.('[plugin-upgrader] host ready')
}
