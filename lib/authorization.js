/**
 * Recognise pnpm's "git dependency needs build authorization" refusal and say what to do.
 *
 * Background, measured against pnpm 11's own source (`dist/pnpm.mjs`):
 *
 *   - A git-hosted dependency that declares build scripts is REFUSED outright with
 *     `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`, before any script runs.
 *   - pnpm's usual "pending build" mechanism does NOT cover this case. For registry packages
 *     pnpm writes `allowBuilds: { <name>: "set this to true or false" }` and DSH's
 *     "Allow these scripts and retry" button can approve it. A git dependency goes through
 *     `preparePackage`, which throws a hard error instead — so no pending entry is written and
 *     `approvedBuilds` cannot be used. Confirmed by reading pnpm's source, not by inference.
 *   - Therefore the ONLY remedy is editing `pnpm-workspace.yaml`, and pnpm already prints the
 *     exact line to add. pnpm's matcher then requires that line to name the resolved COMMIT:
 *     a git version is a `nonSemverVersion`, which makes `trustPackageIdentity` false and skips
 *     the package-name branch entirely, so a commit-less key can never match.
 *
 * So this module does the one thing that is both safe and genuinely helpful: it captures the
 * line pnpm printed and hands it to the user verbatim. It never writes the authorization
 * itself — that would silently grant arbitrary remote code execution on the next commit.
 */

/**
 * pnpm's error code for the refusal, as it appears in captured output.
 *
 * Exported so the detector and the extractor agree on ONE spelling of it: duplicating the literal
 * is how a code-only match ends up unable to build an action.
 */
export const GIT_BUILD_REFUSAL_CODE = 'ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED'

/**
 * pnpm's `packageResult.kind` for the same refusal, which is how the Host classifies it when
 * output classification succeeds.
 */
export const GIT_BUILD_REFUSAL_KIND = 'git-dep-prepare-not-allowed'

/**
 * Extract the `allowBuilds` entry pnpm suggested, straight from its own output.
 *
 * Deliberately does NOT re-check for the error code: whether this is a git-authorization refusal
 * is decided by the caller (`isGitAuthorizationFailure`), which can recognise it from either the
 * error code or the output. Requiring the code here as well would make a code-only match produce
 * no action, i.e. a refusal reported with no way forward.
 * @param {unknown} text - pnpm's captured stdout/stderr.
 * @returns {{key: string, line: string}|null} the suggested entry, or null when absent.
 */
export function extractAllowBuildsHint(text) {
  if (typeof text !== 'string' || text === '') return null
  // pnpm prints the example as a YAML block: a bare `allowBuilds:` line, then the entry indented
  // beneath it. The key is a git depPath, so it may contain `@`, `/`, `:` and a `#commit`.
  const match = /(?:\r?\n)[ \t]+(\S+@git\+\S+?)[ \t]*:[ \t]*true[ \t]*(?:\r?\n|$)/.exec(text)
  if (match === null) return null
  const key = match[1].trim()
  return { key, line: `  ${key}: true` }
}

/**
 * Pull the package name out of a `name@specifier` allowBuilds key.
 *
 * The key is `<pkg>@git+<url>#<commit>`, and `<pkg>` may itself be scoped (`@scope/name`). So the
 * separator is the LAST `@` that precedes the specifier — found by anchoring on `@git+`, which is
 * what every git depPath contains — never the first `@`, which belongs to a scope.
 * @param {unknown} key - the allowBuilds key.
 * @returns {string|null} the package name, or null when it cannot be determined.
 */
export function packageNameFromAllowBuildsKey(key) {
  if (typeof key !== 'string') return null
  const specifier = key.indexOf('@git+')
  if (specifier <= 0) return null
  const name = key.slice(0, specifier)
  return name === '' ? null : name
}

/**
 * Build the verdict for a git-authorization refusal.
 * @param {string} name - the package being upgraded.
 * @param {unknown} output - pnpm's captured output.
 * @returns {{state: string, needsRestart: boolean, headline: string, detail: string, action: object}|null}
 *   the verdict, or null when this is not that failure.
 */
export function gitAuthorizationVerdict(name, output) {
  const hint = extractAllowBuildsHint(output)
  if (hint === null) return null

  // Prefer the name pnpm printed (it is authoritative for the specifier it rejected); fall back to
  // the name the caller gave.
  const displayName = packageNameFromAllowBuildsKey(hint.key) ?? name

  return {
    state: 'needs-authorization',
    needsRestart: false,
    headline: `${name} 需要先授权构建脚本`,
    detail: [
      `pnpm 拒绝在安装时执行 ${displayName} 的构建脚本，因为该包来自 git 仓库（不是注册表包）。`,
      '这是 pnpm 的安全门禁，不是插件的问题。',
      '',
      '把下面这一行加进 profile 的 pnpm-workspace.yaml，然后重新点一次升级：',
      '',
      'allowBuilds:',
      hint.line,
      '',
      '注意：这行必须带上面这个 commit。pnpm 对 git 依赖做的是精确匹配，',
      '少了 commit 或只写包名都不会生效。',
      '',
      '安全提示：授权等于允许这一次提交的代码在你机器上执行构建脚本。',
      '这个仓库每次提交都会换一个新的 commit，所以每升一次都要重新授权一次 ——',
      '这是 pnpm 的有意设计（授权「某次提交」而不是「某仓库永久」）。',
    ].join('\n'),
    action: {
      kind: 'add-allow-builds',
      file: 'pnpm-workspace.yaml',
      yaml: `allowBuilds:\n${hint.line}\n`,
      key: hint.key,
    },
  }
}
