// Adapted from IeumOffice packages/ai-provider/src/user-skills/history.ts @ 8602a39410adb86037f3008588b64efc75b08c60.
// Apache-2.0; see ../LICENSE and ../NOTICE. Changes: explicit Node .ts and local package imports.
/**
 * Earlier versions of the app's own skills, kept so the person can go back.
 *
 *   ~/.ieumoffice/skill-history/<skill name, lower case>/<UTC time>-<reason>.zip
 *
 * Each zip holds one version of the skill folder under a top folder of the
 * skill's name (the shape of a one-skill export), with the GitHub source
 * record when the folder had one. When it was kept, why, and how large it is
 * are read from the file name and the file itself; nothing else is stored.
 * The folder is outside the skill folder, so exports and content hashes never
 * see it. This module alone reads and writes it; a kept zip is read back
 * through the checks every imported zip goes through.
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import JSZip from 'jszip'
import { extractSkillArchive } from './archive.ts'
import { IEUM_SOURCE_FILE } from './constants.ts'
import { SkillImportError } from './errors.ts'
import { listSkillFolderFiles, type SkillFolderFile } from './folder.ts'
import { isValidUserSkillName } from './names.ts'
import type { SkillFileChange } from './update.ts'

/** Why a version was kept: what was about to take its place */
export const SKILL_HISTORY_REASONS = ['edit', 'replace', 'update', 'restore'] as const
export type SkillHistoryReason = (typeof SKILL_HISTORY_REASONS)[number]

export interface SkillVersion {
  /** the file name without `.zip`: `<UTC time>-<reason>` */
  id: string
  /** when it was kept (ISO 8601, UTC) */
  at: string
  reason: SkillHistoryReason
  /** the size of the kept zip */
  bytes: number
}

/** One line of a text comparison; `gap` stands for unchanged lines left out */
export interface SkillDiffLine {
  kind: 'same' | 'added' | 'removed' | 'gap'
  text: string
}

export interface SkillVersionDiff {
  /** SKILL.md, from the current version to the kept one; empty when it is the same */
  skillMd: SkillDiffLine[]
  /** the other files that differ, as going back would change them */
  files: SkillFileChange[]
}

/** Where every own skill's earlier versions are kept */
export function skillHistoryDirOf(homeDir: string): string {
  return join(homeDir, '.ieumoffice', 'skill-history')
}

const VERSION_ID =
  /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-(edit|replace|update|restore)$/

/** A skill name Windows cannot hold as a folder name: a device name, or one ending in a dot */
const WINDOWS_CANNOT_HOLD = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$|\.$/

/** Unchanged lines shown on each side of a change */
const DIFF_CONTEXT_LINES = 2

/**
 * The most cells the line comparison's table may take. Past it, the lines
 * between the first and the last difference are shown as taken out and put in
 * whole, which is still a true account of the change.
 */
const DIFF_TABLE_MAX_CELLS = 4_000_000

function stampOf(date: Date): string {
  return date.toISOString().replace(/[-:.]/g, '')
}

function versionOf(id: string, bytes: number): SkillVersion | undefined {
  const match = VERSION_ID.exec(id)
  if (!match) return undefined
  const [, y, mo, d, h, mi, s, ms, reason] = match
  const at = `${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`
  if (Number.isNaN(Date.parse(at))) return undefined
  return { id, at, reason: reason as SkillHistoryReason, bytes }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function allFiles(dir: string): Promise<SkillFolderFile[]> {
  const listed = await listSkillFolderFiles(dir)
  if (!listed) throw new SkillImportError('failed', `Cannot read ${dir}`)
  return listed.files
}

/** Do two folders hold the same files with the same bytes (the source record counted) */
export async function sameSkillFolderBytes(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([allFiles(a), allFiles(b)])
  if (left.length !== right.length) return false
  for (const [index, file] of left.entries()) {
    const other = right[index]!
    if (file.rel !== other.rel || file.size !== other.size) return false
  }
  for (const [index, file] of left.entries()) {
    const [x, y] = await Promise.all([readFile(file.path), readFile(right[index]!.path)])
    if (sha256(x) !== sha256(y)) return false
  }
  return true
}

/**
 * The lines of `before` and `after` as one list: lines only in `before`
 * (`removed`), only in `after` (`added`), and in both (`same`).
 */
export function diffTextLines(before: string, after: string): SkillDiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++
  }
  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)
  const lines: SkillDiffLine[] = a.slice(0, head).map((text) => ({ kind: 'same', text }))
  if (midA.length * midB.length > DIFF_TABLE_MAX_CELLS) {
    for (const text of midA) lines.push({ kind: 'removed', text })
    for (const text of midB) lines.push({ kind: 'added', text })
  } else {
    // longest common subsequence, filled from the end so it is read forwards
    const width = midB.length + 1
    const table = new Uint32Array((midA.length + 1) * width)
    for (let i = midA.length - 1; i >= 0; i--) {
      for (let j = midB.length - 1; j >= 0; j--) {
        table[i * width + j] =
          midA[i] === midB[j]
            ? table[(i + 1) * width + j + 1]! + 1
            : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) {
        lines.push({ kind: 'same', text: midA[i]! })
        i++
        j++
      } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
        lines.push({ kind: 'removed', text: midA[i++]! })
      } else {
        lines.push({ kind: 'added', text: midB[j++]! })
      }
    }
    while (i < midA.length) lines.push({ kind: 'removed', text: midA[i++]! })
    while (j < midB.length) lines.push({ kind: 'added', text: midB[j++]! })
  }
  for (const text of a.slice(a.length - tail)) lines.push({ kind: 'same', text })
  return lines
}

/**
 * A comparison cut down to its changes: each with a few unchanged lines
 * around it, and one `gap` line (its text the count) for every run left out.
 * Nothing when no line differs.
 */
export function foldDiffLines(
  lines: readonly SkillDiffLine[],
  context = DIFF_CONTEXT_LINES,
): SkillDiffLine[] {
  const shown = new Array<boolean>(lines.length).fill(false)
  let changed = false
  for (const [index, line] of lines.entries()) {
    if (line.kind === 'same') continue
    changed = true
    const from = Math.max(0, index - context)
    const to = Math.min(lines.length - 1, index + context)
    for (let i = from; i <= to; i++) shown[i] = true
  }
  if (!changed) return []
  const folded: SkillDiffLine[] = []
  let hidden = 0
  for (const [index, line] of lines.entries()) {
    if (shown[index]) {
      if (hidden > 0) folded.push({ kind: 'gap', text: String(hidden) })
      hidden = 0
      folded.push(line)
    } else {
      hidden++
    }
  }
  if (hidden > 0) folded.push({ kind: 'gap', text: String(hidden) })
  return folded
}

async function filesByRel(dir: string): Promise<Map<string, SkillFolderFile>> {
  return new Map((await allFiles(dir)).map((file) => [file.rel, file]))
}

/**
 * What going back from `currentDir` to the version in `versionDir` changes:
 * SKILL.md line by line, the other files by name. The source record is the
 * app's own note and is not listed.
 */
export async function diffSkillVersion(
  currentDir: string,
  versionDir: string,
): Promise<SkillVersionDiff> {
  const [current, version] = await Promise.all([filesByRel(currentDir), filesByRel(versionDir)])
  const text = async (file: SkillFolderFile | undefined) =>
    file ? await readFile(file.path, 'utf8') : ''
  const skillMd = foldDiffLines(
    diffTextLines(await text(current.get('SKILL.md')), await text(version.get('SKILL.md'))),
  )
  const listed = (rel: string) => rel !== 'SKILL.md' && rel !== IEUM_SOURCE_FILE
  const files: SkillFileChange[] = []
  for (const [rel, file] of version) {
    if (!listed(rel)) continue
    const now = current.get(rel)
    if (!now) {
      files.push({ rel, change: 'added' })
      continue
    }
    const differs =
      now.size !== file.size ||
      sha256(await readFile(now.path)) !== sha256(await readFile(file.path))
    if (differs) files.push({ rel, change: 'modified' })
  }
  for (const rel of current.keys()) {
    if (listed(rel) && !version.has(rel)) files.push({ rel, change: 'removed' })
  }
  files.sort((x, y) => (x.rel < y.rel ? -1 : x.rel > y.rel ? 1 : 0))
  return { skillMd, files }
}

export interface SkillHistoryOptions {
  /** the history folder (`skillHistoryDirOf`) */
  dir: string
  /** where a kept version is opened for a comparison */
  tempDir: string
  now?: (() => Date) | undefined
}

export interface SkillHistory {
  /** the folder holding one skill's versions; it may not exist */
  folderOf(name: string): string
  /** the kept versions of a skill, newest first */
  list(name: string): Promise<SkillVersion[]>
  /**
   * Keep the skill folder as it is now. Nothing is written when the newest
   * kept version already holds exactly these files; `undefined` then.
   */
  keep(
    skillDir: string,
    name: string,
    reason: SkillHistoryReason,
  ): Promise<SkillVersion | undefined>
  /** Write a kept version's files into `destDir` (made new), through the zip checks */
  extract(name: string, id: string, destDir: string): Promise<void>
  /** Take one kept version away for good */
  remove(name: string, id: string): Promise<void>
  /** A renamed skill's versions go with it */
  follow(from: string, to: string): Promise<void>
}

export function createSkillHistory(options: SkillHistoryOptions): SkillHistory {
  const now = options.now ?? (() => new Date())

  function folderOf(name: string): string {
    if (!isValidUserSkillName(name)) {
      throw new SkillImportError('failed', `Not a skill name: ${name}`)
    }
    const lower = name.toLowerCase()
    // `_` is in no skill name, so the changed folder name is no other skill's
    return join(options.dir, WINDOWS_CANNOT_HOLD.test(lower) ? `${lower}_` : lower)
  }

  function fileOf(name: string, id: string): string {
    if (!VERSION_ID.test(id)) throw new SkillImportError('not-found', `No version ${id}`)
    return join(folderOf(name), `${id}.zip`)
  }

  async function list(name: string): Promise<SkillVersion[]> {
    const folder = folderOf(name)
    const names = await readdir(folder).catch(() => [] as string[])
    const versions: SkillVersion[] = []
    for (const file of names) {
      if (!file.endsWith('.zip')) continue
      const info = await stat(join(folder, file)).catch(() => undefined)
      if (!info?.isFile()) continue
      const version = versionOf(file.slice(0, -'.zip'.length), info.size)
      if (version) versions.push(version)
    }
    return versions.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
  }

  async function extract(name: string, id: string, destDir: string): Promise<void> {
    let bytes: Uint8Array
    try {
      bytes = await readFile(fileOf(name, id))
    } catch (error) {
      if (error instanceof SkillImportError) throw error
      throw new SkillImportError('not-found', `No version ${id}`)
    }
    await extractSkillArchive(bytes, destDir, { stripTopFolder: true })
    const skillMd = await stat(join(destDir, 'SKILL.md')).catch(() => undefined)
    if (!skillMd?.isFile()) {
      throw new SkillImportError('unsafe', 'The kept version does not hold a skill')
    }
  }

  /** Does the newest kept version hold exactly the files of `skillDir` */
  async function newestHolds(name: string, skillDir: string): Promise<boolean> {
    const newest = (await list(name))[0]
    if (!newest) return false
    await mkdir(options.tempDir, { recursive: true })
    const opened = join(options.tempDir, `skill-version-${randomBytes(6).toString('hex')}`)
    try {
      await extract(name, newest.id, opened)
      return await sameSkillFolderBytes(skillDir, opened)
    } catch {
      // a kept version that cannot be read is no reason to skip keeping this one
      return false
    } finally {
      await rm(opened, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async function keep(
    skillDir: string,
    name: string,
    reason: SkillHistoryReason,
  ): Promise<SkillVersion | undefined> {
    const folder = folderOf(name)
    const files = await allFiles(skillDir)
    if (await newestHolds(name, skillDir)) return undefined
    const zip = new JSZip()
    for (const file of files) zip.file(`${name}/${file.rel}`, await readFile(file.path))
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
    await mkdir(folder, { recursive: true })
    const partial = join(folder, `.${randomBytes(6).toString('hex')}.part`)
    try {
      await writeFile(partial, bytes, { flag: 'wx' })
      // two versions kept within one millisecond still get a name each, in order
      for (let at = now().getTime(); ; at++) {
        const id = `${stampOf(new Date(at))}-${reason}`
        const taken = (await readdir(folder)).some((file) => file.startsWith(id.slice(0, 19)))
        if (taken) continue
        await rename(partial, join(folder, `${id}.zip`))
        return versionOf(id, bytes.byteLength)
      }
    } catch (error) {
      await rm(partial, { force: true }).catch(() => undefined)
      if (error instanceof SkillImportError) throw error
      throw new SkillImportError('failed', 'Could not keep the earlier version')
    }
  }

  async function remove(name: string, id: string): Promise<void> {
    const file = fileOf(name, id)
    if (!(await stat(file).catch(() => undefined))) {
      throw new SkillImportError('not-found', `No version ${id}`)
    }
    await rm(file, { force: true })
    // an emptied folder goes too; one that still holds versions stays (rmdir fails)
    await rmdir(folderOf(name)).catch(() => undefined)
  }

  async function follow(from: string, to: string): Promise<void> {
    const source = folderOf(from)
    const target = folderOf(to)
    if (source === target) return
    const files = await readdir(source).catch(() => undefined)
    if (!files) return
    if (!(await stat(target).catch(() => undefined))) {
      await rename(source, target)
      return
    }
    // versions already under the new name stay; the renamed skill's join them
    for (const file of files) {
      const taken = await stat(join(target, file)).catch(() => undefined)
      if (!taken) await rename(join(source, file), join(target, file))
    }
    // a version whose file name was taken stays where it was rather than being lost
    await rmdir(source).catch(() => undefined)
  }

  return { folderOf, list, keep, extract, remove, follow }
}
