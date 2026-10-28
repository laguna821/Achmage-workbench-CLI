import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CARD_LIMIT, claudeWriteGuard, codexSandbox, contextCard, guardDecision, shellWrites } from "./pkm-guard.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function place() {
  const dir = mkdtempSync(join(tmpdir(), "wb-guard-"));
  dirs.push(dir);
  const vault = join(dir, "My Vault");
  const work = join(dir, "work");
  mkdirSync(join(vault, "01. Inbox"), { recursive: true });
  mkdirSync(work, { recursive: true });
  symlinkSync(vault, join(work, "link-to-vault"));
  return { dir, vault, work };
}

describe("context card", () => {
  it("names the work, the vault rule and the pinned notes in at most 2 KB", () => {
    const card = contextCard({ title: "1주차 강의", folders: ["강의", "2026"], cwd: "/w/1", vault: "/v/Achmage", pinned: ["/v/Achmage/01. Inbox/a.md"] });
    expect(card).toContain("작업: 1주차 강의 · 분류: 강의 / 2026");
    expect(card).toContain("옵시디언 볼트(사람 원본, 읽기 전용): /v/Achmage");
    expect(card).toContain("- /v/Achmage/01. Inbox/a.md");
    const many = contextCard({ title: "t", folders: [], cwd: "/w", vault: "/v", pinned: Array.from({ length: 200 }, (_, index) => `/v/아주 긴 폴더 이름/노트 ${index}.md`) });
    expect(Buffer.byteLength(many, "utf8")).toBeLessThanOrEqual(CARD_LIMIT);
    expect(many).toMatch(/… 외 \d+개$/);
    expect(contextCard({ title: "x".repeat(5000), folders: [], cwd: "/w", vault: null, pinned: [] }).length).toBeLessThanOrEqual(CARD_LIMIT);
    expect(contextCard({ title: "t", folders: [], cwd: "/w", vault: null, pinned: [] })).not.toContain("볼트");
  });
});

describe("write guard", () => {
  it("denies file tools writing under the vault, through links and relative paths too", () => {
    const { vault, work } = place();
    expect(guardDecision("Write", { file_path: join(vault, "01. Inbox/new.md") }, work, [vault])).toContain("읽기 전용");
    expect(guardDecision("Edit", { file_path: "link-to-vault/01. Inbox/a.md" }, work, [vault])).toContain("읽기 전용");
    expect(guardDecision("NotebookEdit", { notebook_path: join(vault, "x.ipynb") }, work, [vault])).not.toBeNull();
    expect(guardDecision("Write", { file_path: join(work, "page.md") }, work, [vault])).toBeNull();
    expect(guardDecision("Read", { file_path: join(vault, "01. Inbox/a.md") }, work, [vault])).toBeNull();
    expect(guardDecision("Write", { file_path: join(vault, "x.md") }, work, [])).toBeNull();
  });

  it("denies shell commands that write into the vault, not those that only read it", () => {
    const { vault, work } = place();
    const q = (path: string) => `"${path}"`;
    const denied = [
      `echo 안녕 > ${q(join(vault, "01. Inbox/a.md"))}`,
      `cat x >> link-to-vault/b.md`,
      `cp notes.md ${q(join(vault, "01. Inbox"))}/`,
      `mv ${q(join(vault, "01. Inbox/a.md"))} ./a.md`,
      `rm -rf ${q(join(vault, "01. Inbox"))}`,
      `sed -i 's/a/b/' ${q(join(vault, "a.md"))}`,
      `printf x | tee ${q(join(vault, "t.md"))}`,
      `git -C ${q(vault)} commit -am x`,
      `ls; touch ${q(join(vault, "z.md"))}`,
    ];
    for (const command of denied) expect(guardDecision("Bash", { command }, work, [vault]), command).not.toBeNull();
    const allowed = [`cat ${q(join(vault, "01. Inbox/a.md"))}`, `ls ${q(vault)} 2>/dev/null`, `cp ${q(join(vault, "a.md"))} ./copy.md`, `rg 수업 ${q(vault)} > results.txt`, `grep -r x link-to-vault | head`];
    for (const command of allowed) expect(guardDecision("Bash", { command }, work, [vault]), command).toBeNull();
    expect(shellWrites("echo a 2>/dev/null >out.txt && cp a b c/")).toEqual(["out.txt", "c/"]);
  });

  it("answers as a PreToolUse hook: deny with the reason, nothing otherwise", async () => {
    const { vault, work } = place();
    const hook = claudeWriteGuard([vault]).hooks[0]!;
    const base = { session_id: "s", transcript_path: "/t", cwd: work, hook_event_name: "PreToolUse" as const, tool_use_id: "t1" };
    const signal = new AbortController().signal;
    const denied = await hook({ ...base, tool_name: "Write", tool_input: { file_path: join(vault, "x.md"), content: "x" } } as never, "t1", { signal });
    expect(denied).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });
    expect(await hook({ ...base, tool_name: "Write", tool_input: { file_path: join(work, "x.md"), content: "x" } } as never, "t1", { signal })).toEqual({});
  });

  it("keeps the vault out of Codex's writable roots, and says when full access cannot", () => {
    const { vault, work } = place();
    expect(codexSandbox("auto", work, [vault])).toEqual({ mode: null, excludeTmp: true, protected: true });
    expect(codexSandbox("ask", join(vault, "01. Inbox"), [vault]).mode).toBe("read-only");
    expect(codexSandbox("full", work, [vault]).protected).toBe(false);
    expect(codexSandbox("auto", work, [])).toEqual({ mode: null, excludeTmp: false, protected: true });
  });
});
