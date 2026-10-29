import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { DISK_FOLDER, type Artifact, type PkmRule, type Session, type Work } from "@workbench/contracts";

// Rules: an ordered list of "조건 → 배치" for new works, read without any model. The first rule
// that matches decides; conditions left empty match anything.

/** `~/x` → the home folder's x; anything else as it is. */
const expand = (path: string) => (path.startsWith("~/") || path === "~" ? resolve(homedir(), path.slice(2)) : path);

/** Inside (or exactly) a folder, by path parts: `/a/강의` holds `/a/강의/1` but not `/a/강의자료`. */
export function underFolder(path: string, folder: string) {
  const from = resolve(expand(folder.trim()));
  const inside = relative(from, resolve(path));
  return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
}

/**
 * "디스크 위치대로": the name of the folder a work's folder sits in (`~/강의/1주차` → "강의").
 * Works the app made a folder for, and folders right under the home folder, have none.
 */
export function diskFolder(work: Pick<Work, "cwd" | "cwdManaged">) {
  if (work.cwdManaged) return null;
  const parent = dirname(resolve(work.cwd));
  if (parent === resolve(homedir()) || parent === dirname(parent)) return null;
  return basename(parent) || null;
}

export function ruleMatches(rule: PkmRule, work: Work, sessions: Session[], documents: Artifact[]) {
  if (!rule.enabled) return false;
  if (rule.when.cwdPrefix?.trim() && !underFolder(work.cwd, rule.when.cwdPrefix)) return false;
  if (rule.when.engine && !sessions.some((session) => session.provider === rule.when.engine)) return false;
  if (rule.when.format && !documents.some((document) => document.format === rule.when.format)) return false;
  return true;
}

/** Where the first matching rule puts a work: an app folder path, a tag, a pin (or null: no rule). */
export function placementFor(rules: PkmRule[], work: Work, sessions: Session[], documents: Artifact[]) {
  for (const rule of rules) {
    if (!ruleMatches(rule, work, sessions, documents)) continue;
    const folder = rule.then.folder?.trim() === DISK_FOLDER ? diskFolder(work) : rule.then.folder?.trim() || null;
    // "디스크 위치대로" says nothing about a work without such a folder: the next rule may.
    if (rule.then.folder?.trim() === DISK_FOLDER && !folder) continue;
    return { rule, folder: folder ? folder.split("/").map((part) => part.trim()).filter(Boolean).join("/") : null, tag: rule.then.tag?.trim().replace(/^#/, "") || null, pin: rule.then.pin, stage: rule.then.stage?.trim() || null };
  }
  return null;
}

/** Rules as they come from the UI: known fields only, sensible lengths. */
export function cleanRules(value: unknown): PkmRule[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    const entry = raw as Record<string, unknown>;
    const when = (entry.when && typeof entry.when === "object" ? entry.when : {}) as Record<string, unknown>;
    const then = (entry.then && typeof entry.then === "object" ? entry.then : {}) as Record<string, unknown>;
    const text = (input: unknown, max: number) => (typeof input === "string" && input.trim() ? input.trim().slice(0, max) : null);
    const engine = when.engine === "claude" || when.engine === "codex" ? when.engine : null;
    return [
      {
        id: text(entry.id, 64) ?? `rule-${Date.now()}-${index}`,
        name: text(entry.name, 60) ?? "규칙",
        enabled: entry.enabled !== false,
        when: { cwdPrefix: text(when.cwdPrefix, 500), engine, format: (text(when.format, 20) as PkmRule["when"]["format"]) ?? null },
        then: { folder: text(then.folder, 200), tag: text(then.tag, 60), pin: then.pin === true, stage: text(then.stage, 30) },
      },
    ];
  });
}
