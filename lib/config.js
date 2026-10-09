/**
 * A hand-written Standard Schema for this plugin's config — zero dependencies.
 *
 * Why not just export no schema at all? Because two things need one:
 *
 *  1. Cordis calls `runtime.Config['~standard'].validate(config)` whenever a plugin exports a
 *     `Config`. Exporting a PLAIN OBJECT therefore aborts activation with
 *     "Cannot read properties of undefined (reading 'validate')". Providing a real
 *     Standard Schema both satisfies that contract and validates user input.
 *  2. The official Plugins page renders an editable form for a plugin's config only when it
 *     can derive a schema, which is what makes the ignore list editable without any UI of ours.
 *
 * The obvious alternative — `@deepseek-ai/schemastery` — is a dependency this plugin must not
 * take: DSH drops a bundle whose declared `@deepseek-ai/dsh-*` peer range mismatches the
 * running runtime, and an upgrader that gates itself out of action would be self-defeating.
 * `@deepseek-ai/schemastery` is not matched by the `dsh-*` wildcard, but depending on it still
 * ties this plugin to a package that ships on the runtime's own release train.
 *
 * Standard Schema v1 is a tiny, stable interface: an object carrying `~standard` with
 * `validate(value)` returning either `{ value }` or `{ issues }`. That is the entire contract
 * Cordis consumes, so ~60 lines replaces the dependency.
 *
 * @see https://github.com/standard-schema/standard-schema
 */

/** Marker the spec uses to detect a Standard Schema implementation. */
const STANDARD = '~standard'

/**
 * Build a Standard Schema that validates one optional field.
 * @param {object} spec - the field's rules.
 * @param {string} spec.name - the config key.
 * @param {(raw: unknown) => {value?: any, issue?: string}} spec.parse - validator/coercer.
 * @param {any} spec.fallback - value used when the key is absent.
 * @param {boolean} [spec.required] - whether an absent key is an issue.
 * @returns {object} a Standard Schema validating a single-key object.
 */
function fieldSchema({ name, parse, fallback, required = false }) {
  return {
    [STANDARD]: {
      version: 1,
      vendor: '@happyqu/dsh-plugin-upgrader',
      /**
       * Validate a partial config object.
       * @param {unknown} value - the raw config from the patch layer.
       * @returns {{value: object}|{issues: Array<{message: string, path?: string[]}>}} the result.
       */
      validate(value) {
        const source = typeof value === 'object' && value !== null ? value : {}
        const raw = source[name]

        if (raw === undefined) {
          if (required) return { issues: [{ message: `${name} is required`, path: [name] }] }
          return { value: { [name]: fallback } }
        }

        const result = parse(raw)
        if (result.issue !== undefined) return { issues: [{ message: result.issue, path: [name] }] }
        return { value: { [name]: result.value } }
      },
    },
  }
}

/**
 * Combine field schemas into one object schema.
 * @param {Array<object>} fields - schemas built by {@link fieldSchema}.
 * @returns {object} a Standard Schema whose `value` carries every field.
 */
function objectSchema(fields) {
  return {
    [STANDARD]: {
      version: 1,
      vendor: '@happyqu/dsh-plugin-upgrader',
      /**
       * Validate the whole config object.
       * @param {unknown} value - the raw config from the patch layer.
       * @returns {{value: object}|{issues: Array<unknown>}} the merged result.
       */
      validate(value) {
        const out = {}
        const issues = []
        for (const field of fields) {
          const result = field[STANDARD].validate(value)
          if (result.issues !== undefined) issues.push(...result.issues)
          else Object.assign(out, result.value)
        }
        return issues.length > 0 ? { issues } : { value: out }
      },
    },
  }
}

/**
 * Parse a non-negative integer, tolerating a numeric string.
 * @param {unknown} raw - the raw config value.
 * @param {number} max - the inclusive upper bound.
 * @returns {{value?: number, issue?: string}} the coerced value or an issue.
 */
function nonNegativeInt(raw, max) {
  const num = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
  if (typeof num !== 'number' || !Number.isFinite(num) || !Number.isInteger(num)) {
    return { issue: 'must be an integer' }
  }
  if (num < 0) return { issue: 'must not be negative' }
  if (num > max) return { issue: `must not exceed ${String(max)}` }
  return { value: num }
}

/** The plugin's config schema, applied to whatever the patch layer supplies. */
export const Config = objectSchema([
  fieldSchema({
    name: 'checkTtlMs',
    fallback: 6 * 60 * 60 * 1000,
    parse: (raw) => nonNegativeInt(raw, 30 * 24 * 60 * 60 * 1000),
  }),
  fieldSchema({
    name: 'concurrency',
    fallback: 3,
    parse: (raw) => nonNegativeInt(raw, 16),
  }),
  fieldSchema({
    name: 'ignored',
    fallback: [],
    parse: (raw) => {
      if (!Array.isArray(raw)) return { issue: 'must be an array of package names' }
      const cleaned = raw.filter((item) => typeof item === 'string' && item.trim() !== '')
      return { value: cleaned }
    },
  }),
])
