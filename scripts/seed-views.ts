// A store of many sessions for checking the home overview modes without asking any engine: six
// folders, thirty works, 120 sessions (some with new replies, failures or kept requests), turns
// spread over the last thirty days, Markdown documents with revisions, and proposals waiting.
// Written straight into a gateway store before it starts.
// Usage as a program: node scripts/seed-views.ts <dataDir> <worksDir>
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Artifact, Folder, Proposal, Session, TranscriptItem, Work } from "@workbench/contracts";
import { Store } from "../apps/host/src/store.ts";

const DAY = 86_400_000;
const FOLDERS: [string, string, string | null][] = [
  ["f-lecture", "강의", null],
  ["f-term", "2026-2", "f-lecture"],
  ["f-research", "연구", null],
  ["f-admin", "행정", null],
  ["f-dev", "개발", null],
  ["f-writing", "글쓰기", null],
];
const TOPICS = ["강의안", "과제 안내", "논문 리뷰", "회의록", "보고서", "예산", "발표 자료", "설문 분석", "코드 정리", "칼럼 초고"];
const PURPOSES = ["초안 쓰기", "자료 검토", "문서 수정", "인용 확인", "표 정리", "요약", "피드백 반영", "구조 잡기"];

/** A reply long enough to fold: each paragraph opens with its point, as the engines are asked to write. */
const reply = (title: string, purpose: string) =>
  [
    `# ${title}`,
    `정리했습니다. 먼저 핵심을 말씀드리면, ${purpose}을 마쳤고 남은 일은 표 정리와 인용 확인입니다. 바꾼 곳은 세 군데이며 각 문단의 첫 문장에 요점을 두었습니다.`,
    "도입부는 질문 하나로 시작하게 바꿨습니다. 학생이 바로 답할 수 있는 짧은 질문으로 시작하고, 그 질문이 오늘 활동 전체를 이끌도록 했습니다.",
    "- 첫째 항목은 고쳤습니다. 문장이 길어 두 문장으로 나눴고 용어를 앞 장과 맞췄습니다.\n- 둘째 항목은 근거를 붙였습니다. 인용 쪽수를 확인해 괄호에 넣었습니다.\n- 셋째 항목은 확인이 필요합니다. 원문과 번역본의 표현이 달라 어느 쪽을 따를지 정해 주셔야 합니다.",
    "마지막으로 표는 다음 판에서 정리하겠습니다. 열 이름을 통일하고 빈 칸은 '자료 없음'으로 채우겠습니다.",
  ].join("\n\n");

export function seedViews(dataDir: string, worksDir: string, now = Date.now()) {
  const store = new Store(join(dataDir, "state.sqlite"));
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  FOLDERS.forEach(([id, name, parentId], index) => store.saveFolder({ id, name, parentId, sort: index, archivedAt: null } satisfies Folder));

  const works: Work[] = [];
  const sessions: Session[] = [];
  for (let index = 0; index < 30; index += 1) {
    const id = `vw${index}`;
    const cwd = join(worksDir, id);
    mkdirSync(cwd, { recursive: true });
    const folderId = index % 7 === 6 ? null : FOLDERS[(index % 6) as number]![0];
    const updatedAt = now - Math.floor(random() * 20) * DAY - Math.floor(random() * 8) * 3600_000;
    const work: Work = { id, title: `${TOPICS[index % TOPICS.length]} ${Math.floor(index / TOPICS.length) + 1}`, titleSource: "user", folderId, cwd, cwdManaged: false, activeSessionId: null, pinned: false, sort: index, archivedAt: null, createdAt: now - 40 * DAY, updatedAt };
    works.push(work);
    for (let number = 0; number < 4; number += 1) {
      const sessionId = `vs${index}-${number}`;
      const provider = (index + number) % 2 === 0 ? "claude" : "codex";
      // Turns on a few days of the last month; the newest reply is the session's preview.
      let at = now - Math.floor(random() * 29 + 1) * DAY + Math.floor(random() * 10) * 3600_000;
      const turns = 1 + Math.floor(random() * 4);
      let lastReply = at;
      for (let turn = 0; turn < turns; turn += 1) {
        const length = (20 + Math.floor(random() * 600)) * 1000;
        const items: TranscriptItem[] = [
          { kind: "user", id: `user:${sessionId}-${turn}`, text: `${work.title}: ${PURPOSES[(index + turn) % PURPOSES.length]} 부탁해요`, at },
          { kind: "assistant", id: `a:${sessionId}-${turn}`, text: reply(work.title, PURPOSES[(number + turn) % PURPOSES.length]!), streaming: false, at: at + length - 1000 },
          { kind: "turnEnd", id: `end:${sessionId}-${turn}`, status: random() < 0.1 ? "interrupted" : "completed", durationMs: length, at: at + length },
        ];
        for (const item of items) store.saveItem(sessionId, item);
        lastReply = at + length - 1000;
        at += Math.floor(random() * 3 + 1) * DAY + Math.floor(random() * 5) * 3600_000;
        if (at > now - 3600_000) break;
      }
      const kind = (index * 4 + number) % 10;
      const session: Session = {
        id: sessionId,
        workId: id,
        provider,
        hostId: "h",
        nativeSessionId: `native-${sessionId}`,
        purpose: PURPOSES[(index + number) % PURPOSES.length]!,
        purposeSource: "user",
        model: null,
        effort: null,
        engineModel: null,
        engineEffort: null,
        preview: `${work.title} 정리했습니다. 먼저 핵심을 말씀드리면…`,
        previewAt: lastReply,
        status: kind === 3 && index % 3 === 0 ? "error" : "idle",
        activity: null,
        lastError: kind === 3 && index % 3 !== 2 ? "엔진이 응답을 끝내지 못했습니다" : null,
        pinned: false,
        sort: number,
        archivedAt: null,
        // Every tenth session has a reply not looked at yet.
        seenAt: kind === 1 ? lastReply - 60_000 : lastReply + 60_000,
        unread: false,
        queued: kind === 7 && index % 4 === 1 ? [{ id: `held-${sessionId}`, text: "표를 마저 정리해 줘", refs: [], create: null, at: lastReply, held: true }] : [],
        access: null,
        context: null,
        createdAt: now - 35 * DAY + number,
        updatedAt: lastReply,
      };
      store.saveSession(session);
      sessions.push(session);
    }
    work.activeSessionId = `vs${index}-0`;
    store.saveWork(work);
  }

  // Markdown documents in a third of the works, each with a few revisions over the last days.
  const artifacts: Artifact[] = [];
  for (let index = 0; index < 30; index += 3) {
    for (const [suffix, revisions] of [["강의 노트", 3], ["요약", 1]] as const) {
      const work = works[index]!;
      const id = `vd${index}-${revisions}`;
      const name = `${work.title} ${suffix}.md`;
      const path = join(work.cwd, name);
      let text = "";
      let at = now - Math.floor(random() * 9 + 1) * DAY;
      for (let revision = 1; revision <= revisions; revision += 1) {
        text = `# ${work.title} ${suffix}\n\n판 ${revision}입니다. 질문에서 시작하는 수업 흐름을 정리했습니다.\n\n## 도입\n\n학생이 고른 질문을 함께 다듬습니다.\n\n## 활동\n\n- 조별 토론\n- 근거 정리 표\n- 3분 발표\n`;
        const bytes = Buffer.from(text, "utf8");
        mkdirSync(join(dataDir, "artifacts", id), { recursive: true });
        writeFileSync(join(dataDir, "artifacts", id, `r${revision}.md`), bytes);
        store.saveRevision({ artifactId: id, revision, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, author: revision === 1 ? "user" : "engine", sessionId: revision === 1 ? null : `vs${index}-0`, baseRevision: revision === 1 ? null : revision - 1, note: null, at });
        at += Math.floor(random() * 2 + 1) * DAY;
      }
      writeFileSync(path, text);
      const bytes = Buffer.from(text, "utf8");
      const artifact: Artifact = { id, workId: work.id, path, name, format: "markdown", revision: revisions, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, diskState: "same", readBy: {}, createdAt: now - 10 * DAY, updatedAt: Math.min(at, now - 3600_000) };
      store.saveArtifact(artifact);
      artifacts.push(artifact);
    }
  }
  // Proposals waiting for a decision on a few of them.
  for (const artifact of artifacts.filter((_, index) => index % 4 === 0)) {
    const workingPath = join(dirname(artifact.path), ".workbench", "drafts", `${artifact.id}.md`);
    mkdirSync(dirname(workingPath), { recursive: true });
    writeFileSync(workingPath, `# 고친 판\n\n도입부를 다듬었습니다.\n`);
    store.saveProposal({ id: `vp-${artifact.id}`, artifactId: artifact.id, sessionId: `vs${artifact.id.slice(2).split("-")[0]}-0`, requestId: `vp-${artifact.id}`, baseRevision: artifact.revision, workingPath, status: "pending", added: 2, removed: 6, appliedRevision: null, createdAt: now - 7200_000, updatedAt: now - 7200_000 } satisfies Proposal);
  }
  store.setMeta("ui.prefs", JSON.stringify({ onboarding: "done", startScreen: "last" }));
  store.close();
  return { works, sessions, artifacts };
}

if (import.meta.main) {
  const [dataDir, worksDir] = process.argv.slice(2);
  if (!dataDir || !worksDir) throw new Error("usage: seed-views.ts <dataDir> <worksDir>");
  const { sessions, artifacts } = seedViews(dataDir, worksDir);
  console.log(`seeded ${sessions.length} sessions, ${artifacts.length} documents`);
}
