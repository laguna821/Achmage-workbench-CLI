// Editor memory in WebKitGTK, the Linux app's engine (0.5.3 perf/editor-memory; the owner, 2026-11-16: "PPT 탭자체는 왜 그리
// 크지?"). For each kind: the built UI and gateway in a WebKitGTK window (scripts/perf/wk-editor-memory.py: Python GTK3 +
// WebKit2GTK 4.1 on a private Broadway display, stand-in engines, fixture documents), one tab opened from the sidebar, then
// three times: close the tab, wait 30 s, read the web process again (and reopen). Fails when
//   - the first tab adds more than OPEN_BOUND_MB[kind] to the web process (RSS + swap), or
//   - 30 s after a close the web process holds more than CLOSE_SLACK_MB over the window before the first open, or
//   - the closed readings grow from the first cycle to the last by more than GROWTH_MB (memory kept per open/close).
// WebKit, not Chromium: the numbers this guards were taken in WebKitGTK and differ from Chromium's (ux/reports/perf-measure-webkit.md).
// Needs python3-gobject, webkit2gtk-4.1 and broadwayd; built apps/web/dist (with office) and apps/host/dist.
// Usage: node scripts/editor-memory-check.ts <out folder> [pptx,xlsx,hwpx,docx]   (through ux/run-isolated.sh; ONE WebKit run at a time)
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** First tab of the kind over the window before it (MB, RSS + swap). PowerPoint was +620–700 before this unit. */
export const OPEN_BOUND_MB: Record<string, number> = { pptx: 450, xlsx: 450, hwpx: 350, docx: 250 };
/**
 * Closing does NOT yet give the memory back within 30 s in WebKitGTK (0.5.3: +80–260 MB over the window 30 s after a
 * close, all kinds; 90 s and clearing WebKit's resource cache take back only 10–60 MB more — ux/reports/perf-editor-memory-report.md §3).
 * These two bounds guard against that getting worse (a closed editor kept whole is +300–700 MB); they are not the ~40 MB goal.
 */
export const CLOSE_SLACK_MB = 300;
export const GROWTH_MB = 200;

type Step = { step: string; webProcessRssMb: number; webProcessRssSwapMb?: number };
const out = resolve(process.argv[2] ?? "editor-memory"); mkdirSync(out, { recursive: true });
const kinds = (process.argv[3] ?? "pptx,xlsx,hwpx,docx").split(",").filter(Boolean);
const harness = resolve("scripts/perf/wk-editor-memory.py");
const failures: string[] = [];
const check = (name: string, ok: boolean, detail: string) => { console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`); if (!ok) failures.push(name); };
const mb = (step: Step) => step.webProcessRssSwapMb ?? step.webProcessRssMb;

for (const kind of kinds) {
  const json = join(out, `${kind}.json`);
  const run = spawnSync("python3", ["-u", harness, "doc", kind, json, "never"], { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, CYCLES: "3", WK_MAX: "540" } });
  if (run.status !== 0) { check(`${kind}: harness`, false, `exit ${run.status}`); continue; }
  const result = JSON.parse(readFileSync(json, "utf8")) as { steps: Step[]; failure?: string };
  if (result.failure) { check(`${kind}: harness`, false, result.failure.split("\n").slice(-2).join(" ")); continue; }
  const base = result.steps.find((step) => step.step.startsWith("window"));
  const first = result.steps.find((step) => step.step.startsWith("first:"));
  const closed = result.steps.filter((step) => step.step.includes("closed"));
  if (!base || !first || closed.length < 3) { check(`${kind}: steps`, false, `${result.steps.length} readings`); continue; }
  check(`${kind}: first tab`, mb(first) - mb(base) <= OPEN_BOUND_MB[kind]!, `+${mb(first) - mb(base)} MB (bound ${OPEN_BOUND_MB[kind]})`);
  for (const [i, step] of closed.entries()) check(`${kind}: closed ${i + 1}`, mb(step) - mb(base) <= CLOSE_SLACK_MB, `+${mb(step) - mb(base)} MB over the window before the first open (bound ${CLOSE_SLACK_MB})`);
  check(`${kind}: no growth per cycle`, mb(closed.at(-1)!) - mb(closed[0]!) <= GROWTH_MB, `${mb(closed.at(-1)!) - mb(closed[0]!)} MB from the first close to the last (bound ${GROWTH_MB})`);
}
// A bundled template font the deck did not use, set by the editor's own tool (apply_slide_ops setFont) on a Latin text
// (Bebas Neue) and a Korean one (Gowun Batang): the page holds the faces as loaded data right after the edit, the saved
// file names them, and the reopened deck has them again (perf/editor-memory: only used template faces reach the page).
if (kinds.includes("pptx")) {
  const json = join(out, "pptx-font-case.json");
  const run = spawnSync("python3", ["-u", harness, "doc", "pptx", json, "never"], { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, CYCLES: "0", WK_CASE: "c-ai", WK_MAX: "400" } });
  const result = run.status === 0 ? JSON.parse(readFileSync(json, "utf8")) as { acts?: { act: string; out: { loaded?: string[] } }[]; savedXmlFonts?: Record<string, string[]>; failure?: string } : null;
  const fonts = (result?.acts ?? []).filter((act) => act.act === "fonts").map((act) => act.out?.loaded ?? []);
  const has = (loaded: string[] | undefined) => Boolean(loaded?.includes("Gowun Batang|700") && loaded.includes("Bebas Neue|400"));
  check("pptx: picked template font in the page after the edit", has(fonts[0]), JSON.stringify(fonts[0] ?? result?.failure ?? `exit ${run.status}`));
  const saved = Object.values(result?.savedXmlFonts ?? {})[0] ?? [];
  check("pptx: picked template font saved in the file", saved.includes("Gowun Batang") && saved.includes("Bebas Neue"), JSON.stringify(saved));
  check("pptx: picked template font in the page after reopening", has(fonts[1]), JSON.stringify(fonts[1] ?? null));
}
console.log(failures.length ? `FAILED: ${failures.join(", ")}` : "all passed");
process.exit(failures.length ? 1 : 0);
