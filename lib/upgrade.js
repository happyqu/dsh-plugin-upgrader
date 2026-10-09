/**
 * Upgrade orchestration on top of the official `pluginManager.installBundle`.
 *
 * There is no "upgrade" action in DSH. There is only `installBundle(spec)`, and it happens
 * to be a correct upgrade path, because the profile manifest's `dependencies` already
 * contains the name being replaced:
 *
 *   const before = readProfileManifest(...).dependencies   // contains `name`
 *   ...pnpm add name@newVersion...
 *   if (Object.hasOwn(before, name)) return 'restart-required'   // <- always taken on upgrade
 *   ...reload()...                                               // <- never reached
 *
 * So an upgrade ALWAYS lands as `restart-required`: the bytes on disk are replaced and the
 * running code is untouched until the next start. This module's job is to (a) drive that
 * call with a caller-owned `requestId`, (b) collect the real progress the manager emits,
 * and (c) report the four terminal states honestly, never implying "already live".
 *
 * Progress is taken from two Host events, so no polling is needed:
 *   plugin-manager/install-state  -> phase 'installing' | 'cancelling' | 'applying'
 *   plugin-manager/install-log    -> the pnpm process's own stdout/stderr chunks
 *
 * `waitForInstall(requestId)` exists but does NOT retain completed results, so the promise
 * returned by `installBundle` is kept here instead.
 */

/** The official install phases, plus the terminal states this module adds. */
export const PHASE = Object.freeze({
  INSTALLING: 'installing',
  CANCELLING: 'cancelling',
  APPLYING: 'applying',
  DONE: 'done',
})

/** Keep at most this many log lines per run, so a chatty install cannot grow without bound. */
const MAX_LOG_LINES = 400

/**
 * Owns every in-flight and recently finished upgrade for this profile.
 */
export class UpgradeTracker {
  /**
   * @param {object} input - tracker wiring.
   * @param {any} input.ctx - the plugin context (event subscription + services).
   * @param {any} input.pluginManager - the `pluginManager` service.
   * @param {() => void} [input.onProgress] - called whenever a run's state changes.
   */
  constructor({ ctx, pluginManager, onProgress }) {
    this.ctx = ctx
    this.pluginManager = pluginManager
    this.onProgress = typeof onProgress === 'function' ? onProgress : () => {}
    /** @type {Map<string, any>} */
    this.runs = new Map()
    this.subscribed = false
  }

  /**
   * Subscribe to the two official install events. Idempotent.
   * @returns {void}
   */
  subscribe() {
    if (this.subscribed) return
    this.subscribed = true

    const stateEvent = 'plugin-manager/install-state'
    const logEvent = 'plugin-manager/install-log'

    this.ctx.on(stateEvent, (progress) => {
      const id = progress?.requestId
      const run = typeof id === 'string' ? this.runs.get(id) : undefined
      if (run === undefined) return
      if (typeof progress?.phase === 'string') run.phase = progress.phase
      if (progress?.attempt !== undefined) run.attempt = progress.attempt
      this.onProgress()
    })

    this.ctx.on(logEvent, (chunk) => {
      const id = chunk?.requestId
      const run = typeof id === 'string' ? this.runs.get(id) : undefined
      if (run === undefined) return
      const text = typeof chunk?.text === 'string' ? chunk.text : ''
      if (text !== '') {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim() === '') continue
          run.log.push(line)
        }
        if (run.log.length > MAX_LOG_LINES) run.log.splice(0, run.log.length - MAX_LOG_LINES)
      }
      if (typeof chunk?.exitCode === 'number') run.exitCode = chunk.exitCode
      run.logStream = chunk?.stream === 'stderr' ? 'stderr' : 'stdout'
      this.onProgress()
    })
  }

  /**
   * Build the public view of one run.
   * @param {any} run - the internal run record.
   * @returns {object} a serializable snapshot for the client.
   */
  static view(run) {
    return {
      requestId: run.requestId,
      name: run.name,
      version: run.version,
      phase: run.phase,
      attempt: run.attempt ?? null,
      running: run.running,
      result: run.result ?? null,
      application: run.application ?? null,
      error: run.error ?? null,
      logTail: run.log.slice(-120),
      startedAt: run.startedAt,
      finishedAt: run.finishedAt ?? null,
    }
  }

  /**
   * Read one run's snapshot.
   * @param {string} requestId - the caller-supplied run id.
   * @returns {object|null} the snapshot, or null when unknown.
   */
  status(requestId) {
    const run = this.runs.get(requestId)
    return run === undefined ? null : UpgradeTracker.view(run)
  }

  /**
   * List every run this session has seen, most recent first.
   * @returns {object[]} run snapshots.
   */
  list() {
    return [...this.runs.values()]
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((run) => UpgradeTracker.view(run))
  }

  /**
   * Start one upgrade and return immediately with the run's id.
   *
   * The returned promise from `installBundle` is NOT awaited here: an install can take
   * minutes, and the caller (an HTTP request) must return at once so the UI can show
   * progress and offer cancellation.
   *
   * `spec` is decided by the HOST half, never by the client, because the correct spec differs
   * per dependency shape:
   *   - registry: `name@1.2.3`  (installs that exact version; pnpm rewrites the range)
   *   - git:      the repository URL, un-pinned, so pnpm re-resolves the branch's HEAD
   *   - link:     not upgradable at all
   * A client-supplied version number cannot express the git case, which is exactly the bug
   * this signature removes.
   * @param {object} input - the upgrade request.
   * @param {string} input.requestId - the caller-owned run id.
   * @param {string} input.name - the package name.
   * @param {string} input.spec - the full install spec the Host resolved.
   * @param {string} [input.label] - what to show as the target, for display only.
   * @returns {object} the initial run snapshot.
   */
  start({ requestId, name, spec, label }) {
    this.subscribe()

    if (this.runs.has(requestId)) {
      const existing = this.runs.get(requestId)
      if (existing.running) return UpgradeTracker.view(existing)
    }

    const run = {
      requestId,
      name,
      spec,
      version: label ?? null,
      phase: PHASE.INSTALLING,
      attempt: null,
      running: true,
      log: [],
      logStream: 'stdout',
      exitCode: null,
      result: null,
      application: null,
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
    }
    this.runs.set(requestId, run)

    Promise.resolve()
      .then(() => this.pluginManager.installBundle(spec, { requestId }))
      .then((result) => {
        run.result = result ?? null
        run.application = typeof result?.application === 'string' ? result.application : null
        run.phase = PHASE.DONE
        // A failed install carries its diagnosis in `error`; keep it verbatim for the UI.
        if (result?.error !== undefined && result.error !== null) run.error = result.error
      })
      .catch((error) => {
        run.phase = PHASE.DONE
        run.application = 'failed'
        run.error = {
          code: 'upgrade/threw',
          message: error instanceof Error ? error.message : String(error),
        }
      })
      .finally(() => {
        run.running = false
        run.finishedAt = Date.now()
        this.onProgress()
      })

    this.onProgress()
    return UpgradeTracker.view(run)
  }

  /**
   * Ask the manager to cancel a run.
   * @param {string} requestId - the run to cancel.
   * @returns {Promise<object>} the cancellation status plus the refreshed snapshot.
   */
  async cancel(requestId) {
    const service = this.pluginManager
    let status = { status: 'not-running' }
    if (typeof service.cancelInstall === 'function') {
      status = await service.cancelInstall(requestId)
    }
    return { cancellation: status, run: this.status(requestId) }
  }
}

/**
 * Turn one settled `ChangeResult` into the sentence the user should read.
 *
 * `application` is authoritative: on an upgrade it is `restart-required` by construction,
 * because the name was already a dependency before the install ran. Saying "updated" without
 * saying "restart to use it" would be a lie.
 * @param {object|null} result - the `ChangeResult`, when one arrived.
 * @param {object} [options] - rendering options.
 * @param {string} [options.profileName] - the profile's own name, for copy-pasteable hints.
 *   Never assume `desktop`: profiles can be named anything, and a hint naming the wrong profile
 *   is worse than no hint.
 * @returns {{state: string, needsRestart: boolean, headline: string, detail: string}} the verdict.
 */
export function interpretResult(result, { profileName } = {}) {
  if (result === null || result === undefined) {
    return {
      state: 'unknown',
      needsRestart: false,
      headline: '升级未返回结果',
      detail: '安装调用没有返回结果，请查看运行日志。',
    }
  }

  const application = result.application
  const name = typeof result.target === 'string' ? result.target : '插件'

  if (application === 'restart-required') {
    return {
      state: 'restart-required',
      needsRestart: true,
      headline: `${name} 已更新，重启后生效`,
      detail: '新版本已经写入磁盘。运行中的代码要等下次启动才会换成新版本。',
    }
  }
  if (application === 'applied') {
    return {
      state: 'applied',
      needsRestart: false,
      headline: `${name} 已更新并生效`,
      detail: '本次变更已即时应用。',
    }
  }
  if (application === 'cancelled') {
    return {
      state: 'cancelled',
      needsRestart: false,
      headline: `${name} 升级已取消`,
      detail: '磁盘上的文件已还原为升级前的状态。',
    }
  }
  if (application === 'overridden') {
    return {
      state: 'overridden',
      needsRestart: true,
      headline: `${name} 的变更被更高优先级的设置覆盖`,
      detail: '已写入配置，但当前生效的是更高优先级的补丁。',
    }
  }

  // `failed`. `incompatible` is NOT a top-level ChangeResult field — it nests under
  // `error.incompatible` and `packageResult.incompatible`.
  const incompatible = result?.error?.incompatible ?? result?.packageResult?.incompatible
  const pendingBuilds = Array.isArray(result.pendingBuilds) ? result.pendingBuilds : null
  let detail = typeof result?.error?.diagnostic === 'string' ? result.error.diagnostic : ''

  if (Array.isArray(incompatible) && incompatible.length > 0) {
    const first = incompatible[0]
    // Only name a profile when the caller told us its name; a wrong `--profile` is a worse hint
    // than none, and the user can read their own profile name off the page.
    const profileFlag = typeof profileName === 'string' && profileName !== '' ? ` --profile ${profileName}` : ''
    const hint = `dsh plugin${profileFlag} allow-version ${String(first?.name)}@${String(first?.version)} --dsh-version ${String(first?.runtimeVersion)} --accept-risk`
    detail = `新版本与当前 DSH 运行时（${String(first?.runtimeVersion)}）的 peer 依赖不兼容，安装已回滚。如果确认要装，需要显式豁免：\n${hint}`
  } else if (pendingBuilds !== null && pendingBuilds.length > 0) {
    detail = `安装失败：以下包需要执行构建脚本，但尚未获批：${pendingBuilds.join(', ')}。请在官方插件页按提示批准后重试。`
  } else if (typeof result?.packageResult?.output === 'string' && result.packageResult.output.trim() !== '') {
    // pnpm's own words, trimmed. Never paraphrase a supply-chain refusal.
    detail = result.packageResult.output.trim().slice(-4000)
  } else if (detail === '') {
    detail = '安装失败。请查看运行日志了解 pnpm 的原始输出。'
  }

  return {
    state: 'failed',
    needsRestart: false,
    headline: `${name} 升级失败`,
    detail,
  }
}
