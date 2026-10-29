// How big and how fast "찾는 길"'s index is on a seeded store: 120 sessions (3,600 messages) in 30
// works and a fixture vault of 1,300 notes (plus a folder hidden in Notebook Navigator), all made
// up in temporary folders — the user's vault is never read. Measures the full rebuild of the
// conversation index (what an older database gets once), the first indexing of the vault, the
// database size, and the time of a few queries. Usage: node scripts/search-bench.ts

import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Session, TranscriptItem, Work } from "@workbench/contracts";
import { EventBus } from "../apps/host/src/bus.ts";
import { Pkm } from "../apps/host/src/pkm.ts";
import { SessionManager } from "../apps/host/src/sessions.ts";
import { Store } from "../apps/host/src/store.ts";
import { put } from "../apps/host/src/vault-fixture.ts";

const dir = mkdtempSync(join(tmpdir(), "wb-search-bench-"));
const vault = join(dir, "vault");
let seed = 20261029;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T>(list: T[]) => list[Math.floor(random() * list.length)]!;
const NOUNS = ["채점", "기준", "루브릭", "강의", "수업", "과제", "평가", "학생", "보고서", "예산", "일정", "발표", "설문", "표본", "자료", "근거", "인용", "논문", "초안", "목차", "슬라이드", "표지", "회의록", "연구", "질문", "피드백", "문단", "도입부", "결론", "방법", "결과", "한계", "사례", "실습", "토론", "프로젝트", "설계", "검토", "수정안", "문서"];
const PARTICLES = ["을", "를", "은", "는", "이", "가", "의", "에", "에서", "으로", "와", "과", "도", ""];
const VERBS = ["정리했습니다", "고쳤습니다", "만들었습니다", "확인했습니다", "나눴습니다", "붙였습니다", "바꿨습니다", "살펴봤습니다", "줄였습니다", "보탰습니다"];
const LATIN = ["AI", "Playwright", "MCP", "Codex", "Claude", "PDF", "HWPX", "2026", "3주차", "R2", "APA", "GPT"];
const sentence = () => {
  const words = Array.from({ length: 4 + Math.floor(random() * 6) }, () => (random() < 0.12 ? pick(LATIN) : `${pick(NOUNS)}${pick(PARTICLES)}`));
  return `${words.join(" ")} ${pick(VERBS)}.`;
};
const paragraph = (sentences: number) => Array.from({ length: sentences }, sentence).join(" ");

// ── 120 sessions in 30 works, written straight into a store ─────────────────────────────────
const t0 = performance.now();
const store = new Store(join(dir, "state.sqlite"));
const now = Date.now();
let items = 0;
for (let w = 0; w < 30; w += 1) {
  const work: Work = { id: `w${w}`, title: `${pick(NOUNS)} ${pick(NOUNS)} ${w + 1}`, titleSource: "user", folderId: null, cwd: join(dir, "works", `w${w}`), cwdManaged: false, activeSessionId: null, pinned: false, sort: w, archivedAt: null, createdAt: now - 30 * 86_400_000, updatedAt: now - w * 3_600_000, tags: [pick(NOUNS)] };
  store.saveWork(work);
  for (let s = 0; s < 4; s += 1) {
    const id = `s${w}-${s}`;
    const session = { id, workId: work.id, provider: s % 2 ? "claude" : "codex", hostId: "h", nativeSessionId: null, purpose: `${pick(NOUNS)} ${pick(NOUNS)}`, purposeSource: "user", model: null, effort: null, engineModel: null, engineEffort: null, preview: null, previewAt: null, status: "idle", activity: null, lastError: null, pinned: false, sort: s, archivedAt: null, seenAt: null, unread: false, queued: [], access: null, context: null, createdAt: now - 20 * 86_400_000, updatedAt: now - s * 60_000 } as Session;
    store.saveSession(session);
    let at = now - 10 * 86_400_000 + s * 1000;
    for (let turn = 0; turn < 15; turn += 1) {
      const user: TranscriptItem = { kind: "user", id: `u${turn}`, text: paragraph(2), at: (at += 60_000) };
      const reply: TranscriptItem = { kind: "assistant", id: `a${turn}`, text: `## ${pick(NOUNS)}\n\n${paragraph(8)}\n\n- ${sentence()}\n- ${sentence()}\n\n${paragraph(6)}`, streaming: false, at: (at += 60_000) };
      store.saveItem(id, user);
      store.saveItem(id, reply);
      items += 2;
    }
  }
}
const seeded = performance.now() - t0;
store.close();

// ── the conversation index rebuilt as an older database gets it ────────────────────────────
const raw = new DatabaseSync(join(dir, "state.sqlite"));
raw.prepare("UPDATE meta SET value = '1' WHERE key = 'search.version'").run();
raw.close();
const t1 = performance.now();
const rebuilt = new Store(join(dir, "state.sqlite"));
const rebuildMs = performance.now() - t1;

// ── 1,300 notes (and 60 in a folder hidden in Notebook Navigator) ──────────────────────────
put(vault, ".obsidian/app.json", "{}");
put(vault, ".obsidian/plugins/notebook-navigator/data.json", JSON.stringify({ vaultProfile: "default", vaultProfiles: [{ id: "default", hiddenFolders: ["/99. 숨김*"] }] }));
const folders = ["01. Inbox", "10. Data (D)", "20. Information (I)", "30. Knowledge (K)", "40. Meaning (M)", "50. Teaching Materials"];
for (let n = 0; n < 1300; n += 1) {
  const title = `${pick(NOUNS)} ${pick(NOUNS)} 노트 ${n}`;
  put(vault, `${pick(folders)}/${n % 7}/${title}.md`, ["---", `title: ${title}`, `tags: [${pick(NOUNS)}, ${pick(NOUNS)}]`, `"DIKM_단계:": ${pick(["🟢 D", "🔵 I", "🟣 K", "🟠 M"])}`, "date created: 2026-10-20T09:30:00+09:00", "---", "", `# ${title}`, "", paragraph(12), "", paragraph(14), "", paragraph(10)].join("\n"));
}
for (let n = 0; n < 60; n += 1) put(vault, `99. 숨김/비밀 ${n}.md`, `비밀숨김단어 ${paragraph(4)}`);
const bus = new EventBus();
const manager = new SessionManager(rebuilt, bus, { hostId: "h", hostLabel: "노트북", managedWorksDir: join(dir, "works"), dataDir: dir });
const pkm = new Pkm(rebuilt, bus, manager, { dataDir: dir });
pkm.attachVault(vault);
const t2 = performance.now();
await manager.finder.useVault(pkm.vault, bus);
const vaultMs = performance.now() - t2;

// ── size and queries ───────────────────────────────────────────────────────────────────────
rebuilt.search.transaction(() => undefined);
const size = (file: string) => (existsSync(file) ? statSync(file).size : 0);
const check = new DatabaseSync(join(dir, "state.sqlite"));
check.exec("PRAGMA wal_checkpoint(TRUNCATE)");
let tables: { name: string; bytes: number }[] = [];
try {
  tables = (check.prepare("SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC").all() as { name: string; bytes: number }[]).map((row) => ({ name: String(row.name), bytes: Number(row.bytes) }));
} catch {
  // SQLite built without dbstat.
}
check.close();
const dbBytes = size(join(dir, "state.sqlite")) + size(join(dir, "state.sqlite-wal"));
const indexBytes = tables.filter((table) => table.name.startsWith("search_")).reduce((sum, table) => sum + table.bytes, 0);
const timed = (label: string, query: string) => {
  const started = performance.now();
  const page = manager.search(query, { legacy: false });
  return `${label} "${query}": ${(performance.now() - started).toFixed(1)}ms · ${page.total}건 · 작업 ${page.groupsTotal}곳`;
};
const session = manager.view.sessions.get("s0-0")!;
const findStarted = performance.now();
const found = manager.finder.find(["--all", "채점 기준"], { sessionId: session.id });
const findMs = performance.now() - findStarted;

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
console.log(`seeded ${items} messages in 120 sessions (${seeded.toFixed(0)}ms with indexing as they were saved)`);
console.log(`rebuild of the conversation index: ${rebuildMs.toFixed(0)}ms`);
console.log(`first vault indexing (1,300 notes; 60 hidden left out): ${vaultMs.toFixed(0)}ms`);
console.log(`rows: ${JSON.stringify(rebuilt.search.stats())}`);
console.log(`database ${mb(dbBytes)}, of which the search index ${tables.length ? mb(indexBytes) : "(dbstat unavailable)"}`);
for (const table of tables.filter((entry) => entry.name.startsWith("search_")).slice(0, 8)) console.log(`  ${table.name}: ${mb(table.bytes)}`);
console.log(timed("2-syllable", "기준"));
console.log(timed("spaced", "채점 기준"));
console.log(timed("joined", "채점기준"));
console.log(timed("particle", "루브릭을"));
console.log(timed("latin 3+", "playwright"));
console.log(timed("1 syllable (LIKE)", "표"));
console.log(timed("hidden word", "비밀숨김단어"));
console.log(`workbench-find --all "채점 기준": ${findMs.toFixed(1)}ms · ${Buffer.byteLength(found.stdout)} bytes`);
pkm.close();
rebuilt.close();
rmSync(dir, { recursive: true, force: true });
