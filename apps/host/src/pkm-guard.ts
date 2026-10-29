import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { HookCallbackMatcher, HookInput } from "@anthropic-ai/claude-agent-sdk";
import type { AccessMode } from "@workbench/contracts";

// What a new engine session is told about its work and the vault, and what keeps it from writing
// into the vault. The instruction ("찾아서 읽어도 된다, 쓰지 마라") goes into the context card; the
// rule itself is enforced, not asked for: Claude through a PreToolUse hook that denies writes under
// the vault, Codex by keeping the vault outside its writable roots. With full access Codex has no
// sandbox, and a shell command can always reach further than a tool check sees: the screen says so.

/** The context card's size limit (UTF-8 bytes). */
export const CARD_LIMIT = 2048;

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** The project part of a context card (project.ts `cardInfo`). */
export type CardProject = { note: string; exists: boolean; stage: string | null; tags: string[]; decisions: string[]; questions: string[]; achmage?: string | null };

/** A line cut to at most this many UTF-8 bytes (on a character boundary). */
function clip(text: string, limit: number) {
  let out = text.replace(/\s+/g, " ").trim();
  if (bytes(out) <= limit) return out;
  while (bytes(`${out}…`) > limit) out = out.slice(0, -1);
  return `${out}…`;
}

/**
 * A new session's context card, in at most 2 KB: the work, its project note (stage, tags, recent
 * decisions, open questions), where the vault is and which of its folders the user hid, and the
 * notes pinned to the work. The general context (decisions, research) already comes from the
 * Achmage hooks.
 */
export function contextCard(input: { title: string; folders: string[]; cwd: string; vault: string | null; pinned: string[]; project?: CardProject | null; hidden?: string[]; find?: string | null }) {
  const head = [
    "[Achmage Workbench 맥락 카드]",
    `작업: ${input.title}${input.folders.length ? ` · 분류: ${input.folders.join(" / ")}` : ""}`,
    `작업 폴더: ${input.cwd}`,
  ];
  const project = input.project ?? null;
  if (project) {
    head.push(`프로젝트 노트: ${project.note}${project.exists ? "" : " (아직 없음)"} — 사람이 단계·태그·결정·열린 질문을 정리하는 곳입니다. 고쳐 달라는 요청이 있을 때만 고치세요.`);
    const facts = [project.stage ? `단계: ${project.stage}` : null, project.tags.length ? `태그: ${project.tags.map((tag) => `#${tag}`).join(" ")}` : null].filter(Boolean);
    if (facts.length) head.push(clip(facts.join(" · "), 240));
    // So an engine publishing an insight names this work, not a guess.
    if (project.achmage) head.push(clip(`Achmage 작업: ${project.achmage} — 인사이트를 낼 때 이 작업 id를 쓰세요.`, 240));
  }
  if (input.vault) {
    head.push(
      `옵시디언 볼트(사람 원본, 읽기 전용): ${input.vault}`,
      "- 관련 노트는 볼트에서 찾아 읽어도 됩니다. 볼트 안에는 파일을 만들거나 고치거나 지우지 마세요(Workbench가 막습니다).",
      "- 볼트에 남길 인사이트는 Achmage MCP(draft_insight → publish_insight)로만 냅니다.",
    );
    // The user hid these in Notebook Navigator: hidden from engines too (decision 2026-10-29).
    if (input.hidden?.length) head.push(clip(`- 사용자가 숨긴 폴더·파일(읽지도 찾지도 마세요): ${input.hidden.join(", ")}`, 360));
  }
  if (input.find) head.push(clip(input.find, 240));
  const lines = [...head];
  const fits = (more: string[]) => bytes([...lines, ...more].join("\n")) <= CARD_LIMIT;
  if (project?.decisions.length) {
    const block = ["최근 결정(사람이 고른 것, 오래된 것부터):", ...project.decisions.map((entry) => `- ${clip(entry, 160)}`)];
    while (block.length > 1 && !fits(block)) block.splice(1, 1);
    if (block.length > 1) lines.push(...block);
  }
  if (project?.questions.length) {
    const block = ["열린 질문:", ...project.questions.map((entry) => `- ${clip(entry, 160)}`)];
    while (block.length > 1 && !fits(block)) block.splice(1, 1);
    if (block.length > 1) lines.push(...block);
  }
  if (input.pinned.length) {
    lines.push("이 작업에 고정한 노트(먼저 읽을 것):");
    for (const [index, path] of input.pinned.entries()) {
      const rest = input.pinned.length - index - 1;
      const next = `- ${path}`;
      const tail = rest ? `… 외 ${rest}개` : "";
      if (bytes([...lines, next, tail].join("\n")) > CARD_LIMIT) {
        lines.push(`… 외 ${input.pinned.length - index}개`);
        break;
      }
      lines.push(next);
    }
  }
  let card = lines.join("\n");
  // A very long work name or path: cut at the limit (on a character boundary).
  while (bytes(card) > CARD_LIMIT) card = card.slice(0, -16);
  return card;
}

/** The real path of a file or of its nearest existing folder (a link cannot hide the vault). */
function realish(path: string) {
  let at = path;
  const rest: string[] = [];
  while (!existsSync(at) && dirname(at) !== at) {
    rest.unshift(at.slice(dirname(at).length + 1));
    at = dirname(at);
  }
  try {
    return resolve(realpathSync(at), ...rest);
  } catch {
    return path;
  }
}

export const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const FILE_TOOLS: Record<string, string[]> = { Write: ["file_path"], Edit: ["file_path"], MultiEdit: ["file_path"], NotebookEdit: ["notebook_path"] };

/** Commands whose path arguments are all written (or removed); `mv` also removes its sources. */
const WRITES_ALL = new Set(["rm", "rmdir", "mkdir", "touch", "truncate", "chmod", "chown", "ln", "mv", "unlink", "shred"]);
/** Commands that write only their last path (the destination); their sources are only read. */
const WRITES_LAST = new Set(["cp", "rsync", "install", "scp"]);

/** Shell words of one simple command: quotes keep spaces, adjacent pieces join (`"a b"/c`). */
function shellWords(segment: string) {
  const words: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  for (let index = 0; index < segment.length; index += 1) {
    const character = segment[index]!;
    if (quote) {
      if (character === quote) quote = null;
      else if (character === "\\" && quote === '"' && index + 1 < segment.length) current += segment[++index];
      else current += character;
    } else if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) words.push(current);
      current = "";
      started = false;
    } else {
      current += character === "\\" && index + 1 < segment.length ? segment[++index] : character;
      started = true;
    }
  }
  if (started) words.push(current);
  return words;
}

/**
 * The paths a shell command writes, as far as can be told from its text (best effort: a script
 * or an interpreter can always write more): redirections, `tee`, `dd of=`, `sed -i`, the
 * arguments of rm/mv/mkdir/touch…, the destination of cp/rsync, the targets of `git -C`.
 */
export function shellWrites(command: string): string[] {
  const targets: string[] = [];
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const redirect = /(^|[^<0-9&])[0-9&]?>{1,2}\s*((?:"[^"]*"|'[^']*'|[^\s;&|"'])+)/g;
    for (const match of segment.matchAll(redirect)) targets.push(shellWords(match[2]!)[0] ?? "");
    const words = shellWords(segment.replace(redirect, "$1 ")).filter((word) => !/^[A-Z_][A-Z0-9_]*=/.test(word));
    let at = 0;
    while (words[at] === "sudo" || words[at] === "env" || words[at] === "command" || words[at] === "nohup") at += 1;
    const name = (words[at] ?? "").split("/").pop() ?? "";
    const args = words.slice(at + 1).filter((word) => word && !word.startsWith("-"));
    if (name === "tee" || WRITES_ALL.has(name)) targets.push(...args);
    else if (WRITES_LAST.has(name) && args.length >= 2) targets.push(args.at(-1)!);
    else if (name === "dd") targets.push(...words.filter((word) => word.startsWith("of=")).map((word) => word.slice(3)));
    else if ((name === "sed" || name === "perl") && words.some((word) => /^-[a-zA-Z]*i/.test(word))) targets.push(...args.slice(1));
    else if (name === "git") {
      const dir = words[words.indexOf("-C") + 1];
      if (words.includes("-C") && dir && /^(checkout|commit|apply|reset|restore|mv|rm|stash|pull|merge|clean|switch|add|init|clone)$/.test(args.find((word) => word !== dir) ?? "")) targets.push(dir);
    } else if (name === "unzip" || name === "tar") {
      const flag = words.findIndex((word) => word === "-d" || word === "-C");
      if (flag >= 0 && words[flag + 1]) targets.push(words[flag + 1]!);
    }
  }
  return targets.filter((target) => target && target !== "/dev/null" && !target.startsWith("/dev/fd/") && !target.startsWith("&"));
}

/**
 * Why a tool use must not run (it writes under a protected root), or null. File tools are checked
 * by their target path; a shell command when it names a protected root and looks like a write.
 */
export function guardDecision(toolName: string, toolInput: unknown, cwd: string, roots: string[]): string | null {
  if (!roots.length) return null;
  const input = (toolInput && typeof toolInput === "object" ? toolInput : {}) as Record<string, unknown>;
  const real = roots.map((root) => realish(resolve(root)));
  const hit = (path: string) => real.find((root) => inside(root, realish(resolve(cwd, path.replace(/^~(?=\/|$)/, homedir())))));
  for (const key of FILE_TOOLS[toolName] ?? []) {
    const target = input[key];
    if (typeof target === "string" && target && hit(target)) return `볼트(사람 원본)는 읽기 전용입니다. Workbench가 이 쓰기를 막았습니다: ${target}`;
  }
  if (toolName === "Bash" && typeof input.command === "string") {
    const written = shellWrites(input.command).find((target) => hit(target));
    if (written) return `볼트(사람 원본)는 읽기 전용입니다. 볼트에 쓰는 명령은 Workbench가 막습니다(읽기는 됩니다): ${written}`;
  }
  return null;
}

/** The PreToolUse hook Claude sessions get: writes under the vault are denied before they run (any access). */
export function claudeWriteGuard(roots: string[]): HookCallbackMatcher {
  return {
    matcher: "Write|Edit|MultiEdit|NotebookEdit|Bash",
    hooks: [
      async (input: HookInput) => {
        if (input.hook_event_name !== "PreToolUse") return {};
        const reason = guardDecision(input.tool_name, input.tool_input, input.cwd, roots);
        return reason ? { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: reason } } : {};
      },
    ],
  };
}

/**
 * Codex's sandbox for a session: the vault must stay outside the writable roots. Its work folder is
 * writable in "workspace-write"; a work folder inside the vault (or holding it) makes the sandbox
 * read-only; a vault in the temporary folders takes those out of the writable roots. Full access has
 * no sandbox at all (`protected: false`).
 */
export function codexSandbox(access: AccessMode, cwd: string, roots: string[]) {
  if (access === "full" || !roots.length) return { mode: null, excludeTmp: false, protected: !roots.length ? true : access !== "full" };
  const work = realish(resolve(cwd));
  const real = roots.map((root) => realish(resolve(root)));
  const overlaps = real.some((root) => inside(root, work) || inside(work, root));
  const temporary = [tmpdir(), "/tmp", process.env.TMPDIR].filter((dir): dir is string => Boolean(dir)).map((dir) => realish(resolve(dir)));
  const excludeTmp = real.some((root) => temporary.some((dir) => inside(dir, root)));
  return { mode: overlaps ? ("read-only" as const) : null, excludeTmp, protected: true };
}
