// A store for checking home "흐름" as a calendar without asking any engine: two works (one per
// engine) with requests at known local times — yesterday morning (Codex) and afternoon (Claude,
// with two document revisions), the evening before, the 15th of last month and the 14th of this
// month last year. Written straight into a gateway store before it starts. Times are local to the
// process (run it with TZ set the way the browser is).
// Usage as a program: node scripts/seed-flow.ts <dataDir> <worksDir>
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Artifact, Session, TranscriptItem, Work } from "@workbench/contracts";
import { Store } from "../apps/host/src/store.ts";

export type SeededRequest = { id: string; sessionId: string; workId: string; text: string; start: number; end: number };

const local = (base: Date, days: number, hour: number, minute = 0) => {
  const date = new Date(base.getFullYear(), base.getMonth(), base.getDate() + days, hour, minute);
  return date.getTime();
};

export function seedFlow(dataDir: string, worksDir: string, now = Date.now()) {
  const store = new Store(join(dataDir, "state.sqlite"));
  const today = new Date(now);
  const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 15, 10, 0).getTime();
  const lastYear = new Date(today.getFullYear() - 1, today.getMonth(), 14, 11, 0).getTime();
  const works: Work[] = [];
  const sessions: Session[] = [];
  for (const [id, title, provider] of [
    ["w-codex", "Codex 달력", "codex"],
    ["w-claude", "Claude 달력", "claude"],
  ] as const) {
    const cwd = join(worksDir, id);
    mkdirSync(cwd, { recursive: true });
    const work: Work = { id, title, titleSource: "user", folderId: null, cwd, cwdManaged: false, activeSessionId: `s-${provider}`, pinned: false, sort: works.length, archivedAt: null, createdAt: now - 400 * 86_400_000, updatedAt: now - 86_400_000 };
    works.push(work);
    store.saveWork(work);
    const session: Session = {
      id: `s-${provider}`,
      workId: id,
      provider,
      hostId: "h",
      nativeSessionId: null,
      purpose: provider === "codex" ? "달력 정리" : "강의 준비",
      purposeSource: "user",
      model: null,
      effort: null,
      engineModel: null,
      engineEffort: null,
      preview: "정리했습니다.",
      previewAt: now - 86_400_000,
      status: "idle",
      activity: null,
      lastError: null,
      pinned: false,
      sort: 0,
      archivedAt: null,
      seenAt: now,
      unread: false,
      queued: [],
      access: null,
      context: null,
      createdAt: now - 400 * 86_400_000,
      updatedAt: now - 86_400_000,
    };
    sessions.push(session);
    store.saveSession(session);
  }
  const requests: SeededRequest[] = [];
  const add = (sessionId: string, workId: string, key: string, text: string, start: number, minutes: number) => {
    const end = start + minutes * 60_000;
    const items: TranscriptItem[] = [
      { kind: "user", id: `user-${key}`, text, at: start },
      { kind: "assistant", id: `reply-${key}`, text: `${text}에 답했습니다. 정리했습니다.`, streaming: false, at: end - 1000 },
      { kind: "turnEnd", id: `end-${key}`, status: "completed", durationMs: minutes * 60_000, at: end },
    ];
    for (const item of items) store.saveItem(sessionId, item);
    requests.push({ id: `user-${key}`, sessionId, workId, text, start, end });
  };
  // In stored order per session (oldest first), as a real session keeps them.
  add("s-codex", "w-codex", "last-month", "지난달 Codex 요청", lastMonth, 12);
  add("s-codex", "w-codex", "evening", "그저께 저녁 정리", local(today, -2, 20, 0), 20);
  add("s-codex", "w-codex", "morning", "어제 아침 Codex 요청", local(today, -1, 9, 10), 15);
  add("s-claude", "w-claude", "last-year", "작년 Claude 요청", lastYear, 30);
  add("s-claude", "w-claude", "afternoon", "어제 오후 Claude 요청", local(today, -1, 14, 5), 35);

  // A lecture note revised during yesterday afternoon's turn.
  const work = works[1]!;
  const path = join(work.cwd, "강의안.md");
  let text = "";
  const revisions = [
    { revision: 1, at: local(today, -1, 14, 20), author: "engine" as const },
    { revision: 2, at: local(today, -1, 14, 35), author: "user" as const },
  ];
  for (const entry of revisions) {
    text = `# 강의안\n\n판 ${entry.revision}입니다.\n`;
    const bytes = Buffer.from(text, "utf8");
    mkdirSync(join(dataDir, "artifacts", "d-lesson"), { recursive: true });
    writeFileSync(join(dataDir, "artifacts", "d-lesson", `r${entry.revision}.md`), bytes);
    store.saveRevision({ artifactId: "d-lesson", revision: entry.revision, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, author: entry.author, sessionId: entry.author === "engine" ? "s-claude" : null, baseRevision: entry.revision === 1 ? null : entry.revision - 1, note: null, at: entry.at });
  }
  writeFileSync(path, text);
  const bytes = Buffer.from(text, "utf8");
  const artifact: Artifact = { id: "d-lesson", workId: work.id, path, name: "강의안.md", format: "markdown", revision: 2, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, diskState: "same", readBy: {}, createdAt: revisions[0]!.at, updatedAt: revisions[1]!.at };
  store.saveArtifact(artifact);
  store.setMeta("ui.prefs", JSON.stringify({ onboarding: "done", startScreen: "last", homeMode: "flow" }));
  store.close();
  return { works, sessions, requests, revisions, artifact };
}

if (import.meta.main) {
  const [dataDir, worksDir] = process.argv.slice(2);
  if (!dataDir || !worksDir) throw new Error("usage: seed-flow.ts <dataDir> <worksDir>");
  const { requests } = seedFlow(dataDir, worksDir);
  console.log(JSON.stringify({ requests }));
}
