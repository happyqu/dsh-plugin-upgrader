/**
 * Minimal semver comparison — deliberately dependency-free.
 *
 * This plugin must never import an `@deepseek-ai/dsh-*` package: DSH skips a whole
 * bundle whose declared peer range does not match the running runtime, and an
 * upgrader that ships itself broken behind a version gate would be absurd. So the
 * comparison lives here.
 *
 * Prerelease handling is the part that actually matters on this machine: the whole
 * runtime is versioned `0.2.0-rc.2`, so `0.2.0-rc.2 < 0.2.0-rc.10 < 0.2.0` must
 * hold. Numeric prerelease identifiers compare numerically, not as strings.
 */

/**
 * Parse one semver string into comparable parts.
 * @param {unknown} input - candidate version text, with or without a leading `v`.
 * @returns {{major: number, minor: number, patch: number, prerelease: string[]|null}|null}
 *   the parsed version, or `null` when the text is not a plain semver.
 */
export function parseVersion(input) {
  if (typeof input !== 'string') return null
  const text = input.trim().replace(/^v/, '')
  // Deliberately strict: build metadata after `+` is not part of precedence.
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text)
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? null : match[4].split('.'),
  }
}

/**
 * Compare two prerelease identifier lists per semver §11.4.
 * @param {string[]|null} a - left identifiers (null = no prerelease = highest).
 * @param {string[]|null} b - right identifiers.
 * @returns {number} negative, zero, or positive.
 */
function comparePrerelease(a, b) {
  // A version WITHOUT a prerelease outranks one WITH it: 0.2.0 > 0.2.0-rc.9.
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1

  const limit = Math.min(a.length, b.length)
  for (let index = 0; index < limit; index++) {
    const left = a[index]
    const right = b[index]
    if (left === right) continue
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (leftNumeric && rightNumeric) return Number(left) - Number(right)
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return left < right ? -1 : 1
  }
  // A larger set of fields outranks a smaller one when all preceding are equal.
  return a.length - b.length
}

/**
 * Compare two semver strings.
 * @param {string} a - left version.
 * @param {string} b - right version.
 * @returns {number|null} negative when `a < b`, positive when `a > b`, zero when
 *   equal, and `null` when either side is not parseable semver.
 */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return null
  if (left.major !== right.major) return left.major - right.major
  if (left.minor !== right.minor) return left.minor - right.minor
  if (left.patch !== right.patch) return left.patch - right.patch
  return comparePrerelease(left.prerelease, right.prerelease)
}

/**
 * Decide whether `candidate` is a strictly newer release than `current`.
 * @param {string} candidate - the version offered by the registry.
 * @param {string} current - the version installed on disk.
 * @returns {boolean} true only when both parse and the candidate is greater.
 */
export function isNewer(candidate, current) {
  const order = compareVersions(candidate, current)
  return order !== null && order > 0
}

/**
 * Extract the operator from a dependency range.
 * @param {unknown} range - a range such as `^1.2.3`, `~1.2.3`, `>=1.2.3`, `1.2.3`.
 * @returns {string} the operator text, or `''` for an exact pin.
 */
export function rangeOperator(range) {
  if (typeof range !== 'string') return ''
  const match = /^\s*(\^|~|>=|<=|>|<|=)?/.exec(range)
  return match === null || match[1] === undefined ? '' : match[1]
}

/**
 * Count how far a registry version is from the installed one.
 * @param {string} latest - the registry's newest version.
 * @param {string} current - the installed version.
 * @returns {'major'|'minor'|'patch'|'prerelease'|'none'|'unknown'} the bump kind.
 */
export function bumpKind(latest, current) {
  const left = parseVersion(latest)
  const right = parseVersion(current)
  if (left === null || right === null) return 'unknown'
  if (left.major !== right.major) return 'major'
  if (left.minor !== right.minor) return 'minor'
  if (left.patch !== right.patch) return 'patch'
  if (comparePrerelease(left.prerelease, right.prerelease) !== 0) return 'prerelease'
  return 'none'
}
