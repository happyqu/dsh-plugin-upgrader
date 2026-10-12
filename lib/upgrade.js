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
import {
  GIT_BUILD_REFUSAL_CODE,
  GIT_BUILD_REFUSAL_KIND,
  gitAuthorizationVerdict,
} from './authorization.js'

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
      verification: run.verification ?? null,
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
   * @param {() => Promise<object|null>} [input.verify] - re-read the plugin's installed state after
   *   the install settles. This exists because a pnpm run CAN exit 0 having changed nothing:
   *   observed live, `pnpm add <bare-git-url>` printed "Already up to date" and left the lockfile
   *   pinned to the old commit while `installBundle` reported `restart-required`. Without this
   *   check the UI would claim success while nothing moved — the worst possible failure mode.
   * @returns {object} the initial run snapshot.
   */
  start({ requestId, name, spec, label, verify }) {
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
      verification: null,
      startedAt: Date.now(),
      finishedAt: null,
    }
    this.runs.set(requestId, run)

    Promise.resolve()
      .then(() => this.pluginManager.installBundle(spec, { requestId }))
      .then(async (result) => {
        run.result = result ?? null
        run.application = typeof result?.application === 'string' ? result.application : null
        run.phase = PHASE.DONE
        // A failed install carries its diagnosis in `error`; keep it verbatim for the UI.
        if (result?.error !== undefined && result.error !== null) run.error = result.error
        // Only verify a run the manager considered successful: a failed or cancelled install has
        // already restored its files, so re-reading would report a confusing intermediate state.
        if (run.application === 'restart-required' || run.application === 'applied') {
          run.verification = await this.verifyOutcome(name, label, verify)
        }
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
   * Confirm that a "successful" install actually changed what is on disk.
   *
   * A pnpm run can exit 0 having done nothing — observed live, `pnpm add <bare-git-url>` printed
   * "Already up to date" and left the lockfile on the old commit while `installBundle` returned
   * `restart-required`. Reporting that as success would be a lie, so the installed version is
   * re-read and compared with the target.
   * @param {string} name - the package name.
   * @param {string|null} label - the target the Host asked for: a version, or the short commit a
   *   git upgrade pinned to.
   * @param {(() => Promise<object|null>)|undefined} verify - re-reads the plugin's state.
   * @returns {Promise<object|null>} `{ changed, installedVersion, expected, note }`, or null when
   *   no verifier was supplied (in which case the caller simply has no opinion).
   */
  async verifyOutcome(name, label, verify) {
    if (typeof verify !== 'function') return null
    try {
      const record = await verify()
      if (record === null || typeof record !== 'object') return null
      const installed = typeof record.installedVersion === 'string' ? record.installedVersion : null

      // A git upgrade now names the exact commit it installed, so the strongest available check
      // is to confirm the freshly-read pin IS that commit. This is stricter than the status
      // check below, which cannot tell "the pin moved to what I asked for" apart from "the pin
      // moved somewhere else"; it is also what catches the case where the requested commit was
      // already the installed one, so the run changed nothing.
      //
      // When the target is a commit but no pin could be read, the answer is "cannot confirm",
      // NOT "did nothing": for a git dependency the status is computed FROM the pin, so a
      // missing pin makes the status read `current` no matter what actually happened. Treating
      // that as a no-op would report a successful install as a failure to change anything.
      const isCommitTarget = typeof label === 'string' && /^[0-9a-f]{7,40}$/i.test(label)
      const pinned = typeof record.pinnedCommit === 'string' ? record.pinnedCommit : null
      const commitChanged = pinned === null
        ? null
        : pinned.toLowerCase().startsWith(label.toLowerCase())

      // For a registry target the new version is known exactly, so compare it. For a git target
      // `installedVersion` is NOT a version at all — DSH reports the git depPath there — so the
      // pinned commit, or failing that the record's own status, is the reliable signal: still
      // `outdated` means the pin did not move.
      const isVersionTarget = typeof label === 'string' && /^\d+\.\d+\.\d+/.test(label)
      const changed = isVersionTarget
        ? installed === label
        : isCommitTarget
          ? commitChanged
          : record.status !== 'outdated'

      return {
        changed,
        installedVersion: installed,
        expected: label ?? null,
        status: typeof record.status === 'string' ? record.status : null,
        // A confirmed change needs no note. Every other outcome does, and the two reasons must
        // not be confused: `changed === null` is "could not confirm", which is NOT "did nothing".
        // `null` can only come from the commit branch above, so it always means the git case.
        note: changed === true
          ? null
          : changed === null
            ? '安装命令成功返回，但无法从 profile 读到该 git 依赖的当前提交，无法确认这次升级是否生效。'
              + '请重新检查更新，或查看运行日志确认 pnpm 实际做了什么。'
            : '安装命令成功返回，但磁盘上的版本没有变化 —— 这次操作实际是空操作。'
              + '常见原因：pnpm 认为当前已满足该依赖（例如 git 依赖的 lockfile 已固定在同一提交），'
              + '或上游没有新提交。请重新检查更新后再试。',
      }
    } catch (error) {
      // A verification failure must not turn a real success into a reported failure; it only means
      // the plugin cannot confirm the outcome.
      return {
        changed: null,
        installedVersion: null,
        expected: label ?? null,
        status: null,
        note: `无法复核安装结果：${error instanceof Error ? error.message : String(error)}`,
      }
    }
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
 * @param {object|null} [options.verification] - the post-install re-read. When it reports that
 *   nothing changed, a "successful" application is downgraded to a no-op: claiming an update that
 *   did not happen is worse than reporting no update at all.
 * @returns {{state: string, needsRestart: boolean, headline: string, detail: string}} the verdict.
 */
export function interpretResult(result, { profileName, verification } = {}) {
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

  // A run the manager called successful but which changed nothing is its own outcome. Checked
  // BEFORE the success branches so it cannot be reported as an update.
  if (
    verification !== null
    && verification !== undefined
    && (application === 'restart-required' || application === 'applied')
    && verification.changed === false
  ) {
    return {
      state: 'no-op',
      needsRestart: false,
      headline: `${name} 没有变化（空操作）`,
      detail: verification.note
        ?? '安装命令报告成功，但磁盘上的版本没有变化。请重新检查更新后再试。',
    }
  }

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
  const output = typeof result?.packageResult?.output === 'string' ? result.packageResult.output : ''
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
  }

  // A git dependency's build refusal is its own state, because it is the ONE failure whose
  // remedy is a config edit the user must make by hand: pnpm's normal "approve builds" path does
  // not cover git packages, so `pendingBuilds` is empty and DSH's own approval button cannot
  // help. Reporting it as a generic failure would strand the user with no path forward.
  // Checked before the raw-output fallback so the actionable text wins over pnpm's noise.
  if (isGitAuthorizationFailure(result)) {
    return gitAuthorizationVerdict(name, output) ?? genericFailure(name, detail, output)
  }

  if (detail === '' && output.trim() !== '') {
    // pnpm's own words, trimmed. Never paraphrase a supply-chain refusal.
    detail = output.trim().slice(-4000)
  } else if (detail === '') {
    detail = '安装失败。请查看运行日志了解 pnpm 的原始输出。'
  }

  return { state: 'failed', needsRestart: false, headline: `${name} 升级失败`, detail }
}

/**
 * Decide whether a failed result is pnpm's git build-authorization refusal.
 *
 * Accepting EITHER signal matters: `packageResult.kind` is the classified form and survives
 * localized or reworded output, while the raw code is present even when classification did not
 * run. Detection and extraction are kept independent so a match by kind alone still yields the
 * actionable YAML — a refusal recognised but not actionable would strand the user.
 * @param {object|null} result - the `ChangeResult`.
 * @returns {boolean} true when this is that specific refusal.
 */
function isGitAuthorizationFailure(result) {
  const kind = result?.packageResult?.kind
  if (typeof kind === 'string' && kind.includes(GIT_BUILD_REFUSAL_KIND)) return true
  const output = result?.packageResult?.output
  return typeof output === 'string' && output.includes(GIT_BUILD_REFUSAL_CODE)
}

/**
 * The plain failure verdict, used when a more specific one cannot be built.
 * @param {string} name - the package being upgraded.
 * @param {string} detail - the assembled detail text.
 * @param {string} output - pnpm's captured output.
 * @returns {{state: string, needsRestart: boolean, headline: string, detail: string}} the verdict.
 */
function genericFailure(name, detail, output) {
  const text = detail !== '' ? detail : output.trim().slice(-4000)
  return {
    state: 'failed',
    needsRestart: false,
    headline: `${name} 升级失败`,
    detail: text === '' ? '安装失败。请查看运行日志了解 pnpm 的原始输出。' : text,
  }
}
