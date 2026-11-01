// Fixed synthetic product workloads. Original files stay separate from the derived cache.
// Reports native rank time, complete Finder latency, startup/change latency and owned worker RSS.
// Usage: WORKBENCH_SEARCH_WORKER_BIN=... node scripts/fast-find-bench.ts <evidence>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { Session, Work } from "@workbench/contracts";
import { Store } from "../apps/host/src/store.ts";
import { Finder, type FinderHost } from "../apps/host/src/search.ts";
import { VaultMirror } from "../apps/host/src/vault.ts";
import { EventBus } from "../apps/host/src/bus.ts";

const out = resolve(process.argv[2]!); mkdirSync(out, { recursive: true });
const summary: unknown[] = [];
const topics = ["data engineering", "project planning", "research methods", "education assessment", "software architecture", "annual report", "knowledge management", "design systems", "product analytics", "meeting notes"];
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)]!;
const round = (n: number) => Math.round(n * 1000) / 1000;
const now = Date.now();
for (const [name, count] of [["notes-10k-30mb", 10_000], ["messages-100k", 100_000]] as const) {
  const root = join(out, name); mkdirSync(root, { recursive: true });
  const store = new Store(join(root, "cache.sqlite")), works = new Map<string, Work>(), sessions = new Map<string, Session>();
  const host: FinderHost = { works: () => works, sessions: () => sessions, folders: () => new Map(), artifact: () => null, proposals: () => [], items: () => [], hidden: () => false };
  const finder = new Finder(store.search, host), bus = new EventBus();
  let mirror: VaultMirror | null = null, bytes = 0, peakWorker = 0, peakHost = process.memoryUsage().rss;
  const rss = () => {
    const pid = finder.projection.service.pid;
    if (pid && process.platform === "linux") {
      try { peakWorker = Math.max(peakWorker, Number(/^VmRSS:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0) * 1024); } catch { /* already closed */ }
    }
    peakHost = Math.max(peakHost, process.memoryUsage().rss);
  };
  const memory = setInterval(rss, 50); memory.unref();
  const seedStarted = performance.now();
  try {
    if (name.startsWith("notes")) {
      const vault = join(root, "vault"); mkdirSync(join(vault, ".obsidian"), { recursive: true });
      writeFileSync(join(vault, ".obsidian/app.json"), "{}");
      for (let n = 0; n < count; n++) {
        const topic = topics[n % topics.length]!;
        let text = `---\ntitle: ${topic} 자료${n}\naliases: [alias${n}]\ntags: [${n % 2 ? "연구" : "교육"}]\n"단계:": ${n % 3}\n---\n# ${topic}\n\n채점 기준과 연구 자료를 정리합니다.\n\n`;
        text += `${topic} source${n} evidence${n % 107} method${n % 31}. `.repeat(12);
        const remaining = 3000 - Buffer.byteLength(text);
        if (remaining > 0) text += "background context reference analysis ".repeat(Math.ceil(remaining / 38)).slice(0, remaining);
        bytes += Buffer.byteLength(text); writeFileSync(join(vault, `note-${n}.md`), text);
      }
      mirror = new VaultMirror(() => {}, { debounceMs: 50 }); mirror.attach(vault);
      await finder.useVault(mirror, bus);
    } else {
      for (let n = 0; n < 20; n++) works.set(`w${n}`, { id: `w${n}`, title: `Project ${n}`, folderId: null, updatedAt: now } as Work);
      for (let n = 0; n < 100; n++) sessions.set(`s${n}`, { id: `s${n}`, workId: `w${n % 20}`, provider: n % 2 ? "codex" : "claude", purpose: `Session ${n}`, status: "idle", updatedAt: now } as Session);
      store.search.transaction(() => {
        for (let n = 0; n < count; n++) {
          const topic = topics[n % topics.length]!;
          let body = `${topic} 해바라기점검${n % 997} 채점 기준을 정리합니다. Message ${n}. `;
          body += `${topic} evidence${n % 107} `.repeat(18);
          bytes += Buffer.byteLength(body);
          store.search.put({ key: `item:s${n % 100}:m${n}`, kind: n % 2 ? "user" : "assistant", scope: "session", workId: `w${n % 20}`, sessionId: `s${n % 100}`, itemId: `m${n}`, at: now - n * 1000, title: "", body, own: n % 2 === 1 });
        }
      });
      const body = "긴 문단 자료입니다.\n\n".repeat(20_000) + "끝부분고유확인값"; bytes += Buffer.byteLength(body);
      store.search.put({ key: "item:s0:long", kind: "assistant", scope: "session", workId: "w0", sessionId: "s0", itemId: "long", at: now, title: "", body });
    }
    const seedMs = performance.now() - seedStarted;
    const started = performance.now(); await finder.projection.ready(); const firstBatchMs = performance.now() - started;
    while (finder.projection.state().indexed < Math.min(500, count) && finder.projection.state().phase === "indexing") await nextTurn();
    const first500Ms = performance.now() - started;
    await finder.projection.settled(); const fullMs = performance.now() - started;
    await finder.projection.service.warmUp(); rss();
    const queries = name.startsWith("notes") ? ["data engineering", "alias9876", "자료707", "#교육", "채점 기준"] : ["해바라기점검773", '"project planning"', "끝부분고유확인값", "채점 기준"];
    const rows = [];
    for (const query of queries) {
      const native: number[] = [], finderMs: number[] = [];
      let total = 0;
      for (let i = 0; i < 18; i++) {
        const n = await finder.projection.service.search(query, { limit: 30 });
        const at = performance.now(); const page = await finder.search(query, { legacy: false }); const elapsed = performance.now() - at;
        if (i >= 2) { native.push(n.elapsedUs / 1000); finderMs.push(elapsed); }
        total = page.total; rss();
      }
      const result = { query, total, nativeP50Ms: round(percentile(native, .5)), nativeP95Ms: round(percentile(native, .95)), finderP50Ms: round(percentile(finderMs, .5)), finderP95Ms: round(percentile(finderMs, .95)), samples: native.length };
      rows.push(result); console.log(name, JSON.stringify(result));
    }
    const at = performance.now();
    if (mirror) { writeFileSync(join(mirror.root!, "delta.md"), "외부변경고유표식"); mirror.rescan(); await finder.syncVault(); }
    else store.search.put({ key: "item:s0:delta", kind: "user", scope: "session", workId: "w0", sessionId: "s0", itemId: "delta", at: now, title: "", body: "외부변경고유표식" });
    const changed = await finder.search("외부변경고유표식", { legacy: false });
    const changeMs = performance.now() - at;
    const result = { name, count, bytes, seedMs: round(seedMs), firstBatchMs: round(firstBatchMs), first500Ms: round(first500Ms), fullMs: round(fullMs), changeMs: round(changeMs), changeFound: changed.total === 1, peakWorkerBytes: peakWorker, peakHostHarnessBytes: peakHost, workerCount: 1, pid: finder.projection.service.pid, rows };
    summary.push(result); writeFileSync(join(out, "results.json"), JSON.stringify(summary, null, 2)); console.log("CORPUS", JSON.stringify(result));
  } finally { clearInterval(memory); mirror?.close(); await finder.close(); store.close(); }
}
