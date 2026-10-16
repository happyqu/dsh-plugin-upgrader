import { readFile, writeFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { commitFromResolved, gitRefOf, gitUrlOf } from './shapes.js'

const FILE = '.dsh-plugin-upgrader-git.json'

async function readTracking(profileDir) {
  try {
    const value = JSON.parse(await readFile(join(profileDir, FILE), 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Git 跟踪记录格式无效')
    return value
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw error
  }
}

/** A saved branch is valid only for the same repository and the exact pin we wrote. */
export async function trackedDeclaration(profileDir, name, declared) {
  if (gitRefOf(declared) !== null) return declared
  const pin = commitFromResolved(declared)
  if (pin === null) return declared
  const saved = (await readTracking(profileDir))[`${name}@${pin}`]
  if (saved?.url !== gitUrlOf(declared) || saved?.commit !== pin || typeof saved?.ref !== 'string') return declared
  return `${declared.slice(0, declared.indexOf('#'))}#${saved.ref}`
}

/** Persist before installation; an unsuccessful install leaves a non-matching, inert record. */
export async function rememberGitRef(profileDir, name, declared, commit) {
  const ref = gitRefOf(declared)
  if (ref === null) return
  const state = await readTracking(profileDir)
  Object.defineProperty(state, `${name}@${commit}`, { value: { url: gitUrlOf(declared), ref, commit }, enumerable: true, configurable: true })
  const temp = join(profileDir, `${FILE}.${randomUUID()}.tmp`)
  try {
    await writeFile(temp, JSON.stringify(state, null, 2) + '\n', { flag: 'wx' })
    await rename(temp, join(profileDir, FILE))
  } finally {
    await rm(temp, { force: true })
  }
}
