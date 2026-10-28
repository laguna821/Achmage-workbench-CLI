// Conversations for checking the sidebar of many sessions without asking any engine: folders,
// works, sessions and Korean messages written straight into a gateway store (before it starts).
// Usage as a program: node scripts/seed-meta-sessions.ts <dataDir> <worksDir>
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Folder, Session, TranscriptItem, Work } from "@workbench/contracts";
import { Store } from "../apps/host/src/store.ts";

export function seedMetaSessions(dataDir: string, worksDir: string, now = Date.now()) {
  const store = new Store(join(dataDir, "state.sqlite"));
  const folder = (id: string, name: string, parentId: string | null, sort: number): Folder => ({ id, name, parentId, sort, archivedAt: null });
  const work = (id: string, title: string, folderId: string | null, sort: number): Work => {
    const cwd = join(worksDir, id);
    mkdirSync(cwd, { recursive: true });
    return { id, title, titleSource: "user", folderId, cwd, cwdManaged: false, activeSessionId: null, pinned: false, sort, archivedAt: null, createdAt: now - 86400_000, updatedAt: now - 3600_000 };
  };
  const session = (id: string, workId: string, provider: "claude" | "codex", purpose: string, sort: number, extra: Partial<Session> = {}): Session => ({
    id,
    workId,
    provider,
    hostId: "h",
    nativeSessionId: `native-${id}`,
    purpose,
    purposeSource: "user",
    model: null,
    effort: null,
    engineModel: provider === "claude" ? "claude-opus-5-5" : "gpt-5.5-codex",
    engineEffort: null,
    preview: null,
    previewAt: now - 3600_000,
    status: "idle",
    activity: null,
    lastError: null,
    pinned: false,
    sort,
    archivedAt: null,
    seenAt: now,
    unread: false,
    queued: [],
    access: null,
    context: null,
    createdAt: now - 7200_000 + sort,
    updatedAt: now - 3600_000,
    ...extra,
  });
  for (const entry of [folder("f-lecture", "강의", null, 0), folder("f-term", "2026-2", "f-lecture", 0), folder("f-research", "연구", null, 1)]) store.saveFolder(entry);
  const works = [work("w7", "7주차 강의 자료", "f-term", 0), work("w8", "8주차 강의 자료", "f-term", 1), work("wpaper", "논문 리뷰 정리", "f-research", 0), work("wloose", "보고서 초안", null, 0)];
  works[0]!.activeSessionId = "s-edit";
  for (const entry of works) store.saveWork(entry);
  const sessions = [
    session("s-edit", "w7", "claude", "문서 수정", 1),
    session("s-review", "w7", "codex", "자료 검토", 2, { previewAt: now - 60_000, seenAt: now - 600_000 }),
    session("s-8", "w8", "claude", "8주차 준비", 1),
    session("s-paper", "wpaper", "codex", "인용 확인", 1),
    session("s-loose", "wloose", "claude", "초안 쓰기", 1),
  ];
  for (const entry of sessions) store.saveSession(entry);
  const say = (sessionId: string, turns: [string, string][]) => {
    let at = now - 7000_000;
    turns.forEach(([request, reply], index) => {
      const items: TranscriptItem[] = [
        { kind: "user", id: `user:${sessionId}-${index}`, text: request, at: (at += 60_000) },
        { kind: "assistant", id: `a:${sessionId}-${index}`, text: reply, streaming: false, at: (at += 30_000) },
        { kind: "turnEnd", id: `end:${sessionId}-${index}`, status: "completed", durationMs: 30_000, at: (at += 1_000) },
      ];
      for (const item of items) store.saveItem(sessionId, item);
    });
  };
  say("s-edit", [
    ["강의안 도입부를 **두 문단**으로 다시 써 줘.\n- 질문에서 시작\n- 지식 생산", "# 도입부\n\n이번 주는 답을 외우는 대신 좋은 질문을 고르는 일부터 시작합니다."],
    ["자료 찾기 다음에 근거 정리 단계를 따로 두고 예시를 하나 넣어 줘", "학생이 고른 질문마다 근거 정리 표(출처·인용·한계)를 붙였습니다."],
    ["고마워, 이대로 저장해 줘", "저장했습니다."],
  ]);
  say("s-review", [["강의안 r3을 검토해 줘", "3장의 근거 정리가 인용 범위를 넘어섭니다. 원문 쪽수를 확인해 주세요."]]);
  say("s-paper", [["인용 근거를 확인해 줘", "Citation 범위를 확인했습니다."]]);
  say("s-8", [["8주차 활동 아이디어", "조별 토론과 발표 3분을 제안합니다."]]);
  say("s-loose", [["보고서 초안 목차", "1. 배경 2. 방법 3. 결과"]]);
  store.setMeta("ui.prefs", JSON.stringify({ onboarding: "done", startScreen: "last" }));
  store.close();

  return { works };
}

if (import.meta.main) {
  const [dataDir, worksDir] = process.argv.slice(2);
  if (!dataDir || !worksDir) throw new Error("usage: seed-meta-sessions.ts <dataDir> <worksDir>");
  seedMetaSessions(dataDir, worksDir);
  console.log("seeded");
}
