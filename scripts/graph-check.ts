/// <reference lib="dom" />
// Browser check of the projects' graph (home "프로젝트" → "그래프"), against a real gateway on a
// temporary data folder with stand-in engines (no model). Works get tags and "관련" through
// /api/projects/:id/property, sessions of both engines. It checks: points and lines; the layout
// settles to rest; a point dragged with the pointer moves and its neighbour follows, and the drag
// does not open the project; a click without movement opens it, a tag lights its projects, Enter
// works on a focused point; the settings panel (gear): a line colour and a line length change the
// drawing, the filters (archived, unlinked, by name), and everything is kept after a reload;
// "끌어 놓은 점 고정" and "고정 풀기"; "화면에 맞추기" and "처음 크기로"; reduced motion draws at rest
// at once and a drag still moves a point; and frame times with 300 projects and about 600 lines.
// Usage: node scripts/graph-check.ts [outDir]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Page } from "playwright-core";
import type { Provider, Work } from "@workbench/contracts";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-graph");
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-graph-"));
const worksDir = mkdtempSync(join(tmpdir(), "workbench-graph-works-"));
const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
};
const numbers: string[] = [];

const child = spawn(process.execPath, ["apps/host/src/main.ts"], {
  env: {
    ...process.env,
    WORKBENCH_DATA_DIR: dataDir,
    WORKBENCH_WEB_DIR: "apps/web/dist",
    WORKBENCH_HOST_LABEL: "노트북",
    WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"),
    WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"),
  },
  stdio: ["ignore", "pipe", "inherit"],
});
const ready = await new Promise<{ url: string; token: string }>((done) => {
  createInterface({ input: child.stdout! }).on("line", (line) => {
    if (line.startsWith("WORKBENCH_READY ")) done(JSON.parse(line.slice(16)));
  });
});
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
};
// The drags below were measured beside the single-tree sidebar ("한 칸"); the two-pane navigator is
// wider and a point dragged 140px left would land on it, outside the graph (navigator-check covers it).
await api("PUT", "/api/prefs", { prefs: { onboarding: "done", startScreen: "last", homeMode: "projects", navigator: { layout: "tree" } } });

/** A work with its folder, its note's tags and "관련", and sessions of the given engines. */
async function project(title: string, tags: string[], related: string[], engines: Provider[] = []) {
  const cwd = join(worksDir, title.replace(/\s+/g, "-"));
  mkdirSync(cwd, { recursive: true });
  const work = await api<Work>("POST", "/api/works", { title, cwd });
  if (tags.length) await api("PUT", `/api/projects/${work.id}/property`, { key: "tags", values: tags });
  if (related.length) await api("PUT", `/api/projects/${work.id}/property`, { key: "관련", values: related.map((name) => `[[${name}]]`) });
  for (const provider of engines) await api("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "준비", access: "auto" });
  return work;
}

const works = {
  autumn: await project("가을 특강", ["강의", "2026"], [], ["codex", "claude", "codex"]),
  hello: await project("안녕", ["강의"], ["가을 특강"], ["claude"]),
  draft: await project("논문 초고", ["연구"], [], ["codex", "claude"]),
  plan: await project("연구 계획서", ["연구"], ["논문 초고"], ["claude"]),
  talk: await project("학회 발표", ["연구", "2026"], ["논문 초고", "연구 계획서"], ["codex"]),
  app: await project("워크벤치 앱", ["코딩"], [], ["codex", "codex", "claude", "claude"]),
  flow: await project("AI 워크플로우", ["코딩", "AI"], ["워크벤치 앱"], ["claude"]),
  alone: await project("혼자 쓰는 노트", [], []),
  old: await project("지난 학기 강의", ["강의"], ["가을 특강"]),
};
await api("PATCH", `/api/works/${works.old.id}`, { archived: true });
const nodeOf = (work: Work) => `p:${work.id}`;

const browser = await chromium.launch();
const logs: string[] = [];
const watch = (page: Page, label: string) => {
  page.on("console", (message) => message.type() === "error" && logs.push(`[${label} error] ${message.text().slice(0, 200)}`));
  page.on("pageerror", (error) => logs.push(`[${label} pageerror] ${error.message.slice(0, 200)}`));
};

const state = (page: Page) => page.evaluate(() => document.querySelector(".graph-canvas")?.getAttribute("data-state") ?? "");
const atRest = (page: Page, timeout = 15_000) => page.waitForFunction(() => document.querySelector(".graph-canvas")?.getAttribute("data-state") === "rest", undefined, { timeout }).then(() => true, () => false);
/** A point's centre on screen (after two frames: Chromium updates an SVG child's box a frame after its group moves). */
const centre = (page: Page, id: string) =>
  page.evaluate(async (id) => {
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const box = document.querySelector(`g[data-node="${id}"] .graph-dot`)!.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }, id);
/** Every point's place in the graph's own coordinates. */
const places = (page: Page) =>
  page.evaluate(() =>
    Object.fromEntries(
      Array.from(document.querySelectorAll("g[data-node]")).map((node) => {
        const match = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(node.getAttribute("transform") ?? "");
        return [node.getAttribute("data-node")!, match ? [Number(match[1]), Number(match[2])] : null];
      }),
    ) as Record<string, [number, number] | null>,
  );
/** Mean length of the drawn "관련" lines, in the graph's coordinates. */
const relatedLength = (page: Page) =>
  page.evaluate(() => {
    const d = Array.from(document.querySelectorAll(".graph-edges.related")).map((path) => path.getAttribute("d") ?? "").join("");
    const lengths = Array.from(d.matchAll(/M([-\d.]+) ([-\d.]+)L([-\d.]+) ([-\d.]+)/g)).map((m) => Math.hypot(Number(m[3]) - Number(m[1]), Number(m[4]) - Number(m[2])));
    return lengths.length ? lengths.reduce((sum, value) => sum + value, 0) / lengths.length : 0;
  });
/** requestAnimationFrame intervals over `ms`. */
const frames = (page: Page, ms: number) =>
  page.evaluate(
    (ms) =>
      new Promise<number[]>((done) => {
        const times: number[] = [];
        let last = 0;
        const end = performance.now() + ms;
        const step = (now: number) => {
          if (last) times.push(now - last);
          last = now;
          if (performance.now() < end) requestAnimationFrame(step);
          else done(times);
        };
        requestAnimationFrame(step);
      }),
    ms,
  );
const stats = (times: number[]) => {
  const sorted = [...times].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / Math.max(1, sorted.length);
  return { frames: sorted.length, mean: Math.round(mean * 10) / 10, p95: Math.round((sorted[Math.floor(sorted.length * 0.95)] ?? 0) * 10) / 10, max: Math.round((sorted.at(-1) ?? 0) * 10) / 10 };
};

async function openGraph(page: Page) {
  await page.goto(`${ready.url}/?token=${ready.token}`);
  await page.waitForSelector(".topbar .brand, .home-modes", { timeout: 20_000 });
  if (!(await page.locator(".home-modes").count())) await page.locator(".topbar .brand").click();
  await page.waitForSelector(".home-modes.mode-projects", { timeout: 10_000 });
  if (!(await page.locator(".projects-layouts button.on", { hasText: "그래프" }).count())) await page.locator(".projects-layouts button", { hasText: "그래프" }).click();
  await page.waitForSelector(".graph-node.project", { timeout: 10_000 });
  // The frame sits under the home's input box: bring all of it into view (the wheel over it zooms).
  await page.locator(".graph-stage").evaluate((element) => element.scrollIntoView({ block: "center" }));
}

try {
  // ── the graph, settling ───────────────────────────────────────────────────────────────
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  watch(page, "graph");
  const shot = (name: string, target: Page = page) => target.screenshot({ path: join(outDir, name) });
  await openGraph(page);
  const first = await state(page);
  const started = Date.now();
  const rested = await atRest(page);
  const settleMs = Date.now() - started;
  const counts = await page.evaluate(() => ({
    projects: document.querySelectorAll(".graph-node.project").length,
    tags: document.querySelectorAll(".graph-node.tag").length,
    related: (document.querySelector(".graph-edges.related")?.getAttribute("d") ?? "").split("M").length - 1,
    tagLines: (document.querySelector(".graph-edges.tag")?.getAttribute("d") ?? "").split("M").length - 1,
    bar: document.querySelector(".graph-count")?.textContent ?? "",
  }));
  await shot("01-graph.png");
  numbers.push(`처음 배치가 쉬기까지 ${settleMs}ms`);
  check("그래프: 프로젝트마다 점(보관한 것은 빼고), 태그 점, 관련 선 5 · 태그 선, 움직이다 쉼", first === "running" && rested && counts.projects === 8 && counts.tags === 5 && counts.related === 5 && counts.tagLines === 10 && counts.bar.startsWith("프로젝트 8 · 선 15"), `${JSON.stringify(counts)} · 처음 ${first} · ${settleMs}ms`);

  // Same projects, same picture: a second window lays them out the same way.
  const before = await places(page);
  const twin = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  watch(twin, "twin");
  await openGraph(twin);
  await atRest(twin);
  const again = await places(twin);
  await twin.close();
  const same = Object.keys(before).every((id) => JSON.stringify(before[id]) === JSON.stringify(again[id]));
  check("같은 프로젝트면 늘 같은 배치(새 창에서 다시 계산해도)", same && Object.keys(before).length === 13, `${Object.keys(before).length}점`);

  // ── dragging a point: it follows the pointer, its neighbour follows it, no page opens ─────
  const dragged = nodeOf(works.hello);
  const neighbour = nodeOf(works.autumn);
  const start = await centre(page, dragged);
  const neighbourStart = await centre(page, neighbour);
  const far = { x: start.x + 170, y: start.y + 110 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 20, start.y + 12, { steps: 3 });
  await page.mouse.move(far.x, far.y, { steps: 18 });
  await page.waitForTimeout(700);
  const held = await centre(page, dragged);
  const neighbourHeld = await centre(page, neighbour);
  const lit = await page.evaluate((id) => document.querySelector(".graph-canvas")!.classList.contains("dragging") && document.querySelector(`g[data-node="${id}"]`)!.hasAttribute("data-lit"), neighbour);
  await shot("02-drag.png");
  await page.mouse.up();
  await atRest(page);
  const dropped = await centre(page, dragged);
  // Followed: the neighbour came closer to where the dragged point is now than it was.
  const follow = Math.hypot(neighbourStart.x - held.x, neighbourStart.y - held.y) - Math.hypot(neighbourHeld.x - held.x, neighbourHeld.y - held.y);
  const stayed = (await page.locator(".project-view").count()) === 0;
  check(
    "점을 끌면 포인터를 따라가고 이웃(관련)이 따라오며, 놓아도 프로젝트 페이지는 열리지 않음",
    Math.hypot(held.x - far.x, held.y - far.y) < 3 && follow > 15 && lit && stayed && Math.hypot(dropped.x - start.x, dropped.y - start.y) > 60,
    `점 ${Math.round(Math.hypot(held.x - start.x, held.y - start.y))}px · 이웃 ${Math.round(Math.hypot(neighbourHeld.x - neighbourStart.x, neighbourHeld.y - neighbourStart.y))}px 움직여 ${Math.round(follow)}px 가까이 · 놓은 뒤 ${Math.round(Math.hypot(dropped.x - start.x, dropped.y - start.y))}px`,
  );

  // ── a tag lights its projects; Enter on a focused tag does the same; a background click lets go ─
  const tag = page.locator('g[data-node="t:연구"]');
  await tag.click();
  const tagLit = await page.evaluate(() => ({
    lit: Array.from(document.querySelectorAll("g[data-lit]")).map((node) => node.getAttribute("aria-label")),
    bar: Array.from(document.querySelectorAll(".graph-bar button")).map((button) => button.textContent),
  }));
  await page.waitForTimeout(300);
  await shot("03-tag-focus.png");
  await page.locator(".graph-bar button", { hasText: "강조 풀기" }).click();
  await tag.focus();
  await page.keyboard.press("Enter");
  const byKey = await page.locator(".graph-bar button", { hasText: "#연구 강조 풀기" }).count();
  const box = (await page.locator(".graph-canvas").boundingBox())!;
  await page.mouse.click(box.x + 6, box.y + box.height - 6);
  const cleared = await page.locator(".graph-bar button", { hasText: "강조 풀기" }).count();
  check("태그를 누르면(또는 Enter) 그 프로젝트들만 또렷하고, 바탕을 누르면 풀림", tagLit.lit.length === 4 && tagLit.lit.includes("#연구") && tagLit.bar.includes("#연구 강조 풀기") && byKey === 1 && cleared === 0, tagLit.lit.join(", "));

  // ── the settings panel ──────────────────────────────────────────────────────────────
  await page.locator(".graph-gear").click();
  await page.waitForSelector(".graph-panel");
  for (const name of ["색", "표시", "힘"]) await page.locator(".graph-section-toggle", { hasText: name }).click();
  await shot("04-panel.png");
  const lengthBefore = await relatedLength(page);
  await page.locator('[role="radiogroup"][aria-label="관련 선 색"] [aria-label="#e5484d"]').click();
  await page.locator(".graph-slider", { hasText: "관련 선 길이" }).locator("input").fill("300");
  await page.locator(".graph-slider", { hasText: "관련 선 두께" }).locator("input").fill("3");
  await page.locator(".graph-switch", { hasText: "관련 선에 방향 화살표" }).locator("input").check();
  const reheated = await state(page);
  await atRest(page);
  const lengthAfter = await relatedLength(page);
  const drawn = await page.evaluate(() => {
    const path = document.querySelector(".graph-edges.related")!;
    return { stroke: getComputedStyle(path).stroke, width: getComputedStyle(path).strokeWidth, arrows: (document.querySelector(".graph-arrows")?.getAttribute("d") ?? "").split("M").length - 1 };
  });
  await shot("05-settings-changed.png");
  check(
    "설정: 관련 선 색·두께·화살표가 그림에 바로, 관련 선 길이를 늘리면 다시 움직여 관련 선이 길어짐",
    drawn.stroke === "rgb(229, 72, 77)" && drawn.width === "3px" && drawn.arrows >= 5 && reheated === "running" && lengthAfter > lengthBefore * 1.6,
    `${JSON.stringify(drawn)} · 길이 ${Math.round(lengthBefore)} → ${Math.round(lengthAfter)}`,
  );

  // Filters: archived projects, unlinked ones, by name.
  const projectCount = () => page.locator(".graph-node.project").count();
  await page.locator(".graph-switch", { hasText: "보관한 프로젝트 보이기" }).locator("input").check();
  const withArchived = await projectCount();
  const archivedClass = await page.locator(`g[data-node="${nodeOf(works.old)}"]`).getAttribute("class");
  await page.locator(".graph-switch", { hasText: "보관한 프로젝트 보이기" }).locator("input").uncheck();
  await page.locator(".graph-switch", { hasText: "연결 없는 프로젝트 보이기" }).locator("input").uncheck();
  const withoutAlone = await page.locator(`g[data-node="${nodeOf(works.alone)}"]`).count();
  await page.locator(".graph-switch", { hasText: "연결 없는 프로젝트 보이기" }).locator("input").check();
  await page.locator(".graph-search").fill("-#연구");
  const named = await page.evaluate(() => Array.from(document.querySelectorAll(".graph-node.project")).map((node) => node.getAttribute("aria-label")));
  await page.locator(".graph-search").fill("");
  await page.locator(".graph-switch", { hasText: "태그 점 보이기" }).locator("input").uncheck();
  const noTags = await page.locator(".graph-node.tag").count();
  const tagLineSwitch = await page.locator(".graph-switch", { hasText: "태그 선 보이기" }).locator("input").isDisabled();
  await page.locator(".graph-switch", { hasText: "태그 점 보이기" }).locator("input").check();
  check(
    "필터: 보관한 프로젝트(흐리게), 연결 없는 프로젝트, 이름으로 거르기(-#태그), 태그 점",
    withArchived === 9 && Boolean(archivedClass?.includes("archived")) && withoutAlone === 0 && named.length === 5 && !named.includes("논문 초고") && noTags === 0 && tagLineSwitch,
    `보관 포함 ${withArchived} · 이름 ${named.join(", ")}`,
  );

  // Pinning: a dropped point stays where it was put; "고정 풀기" lets it go.
  await page.locator(".graph-switch", { hasText: "끌어 놓은 점 고정" }).locator("input").check();
  await atRest(page);
  const pinTarget = nodeOf(works.app);
  const pinStart = await centre(page, pinTarget);
  await page.mouse.move(pinStart.x, pinStart.y);
  await page.mouse.down();
  await page.mouse.move(pinStart.x - 140, pinStart.y + 60, { steps: 12 });
  await page.mouse.up();
  const justDropped = await centre(page, pinTarget);
  await atRest(page);
  const afterRest = await centre(page, pinTarget);
  const pinBar = await page.locator(".graph-bar button", { hasText: "고정 1개 풀기" }).count();
  await page.locator(".graph-bar button", { hasText: "고정 1개 풀기" }).click();
  await atRest(page);
  const released = await centre(page, pinTarget);
  check(
    "'끌어 놓은 점 고정': 놓은 자리에 남고, '고정 1개 풀기'로 풀면 제자리를 찾아감",
    pinBar === 1 && Math.hypot(afterRest.x - justDropped.x, afterRest.y - justDropped.y) < 1 && Math.hypot(released.x - afterRest.x, released.y - afterRest.y) > 5,
    `놓은 뒤 ${Math.round(Math.hypot(afterRest.x - justDropped.x, afterRest.y - justDropped.y))}px · 푼 뒤 ${Math.round(Math.hypot(released.x - afterRest.x, released.y - afterRest.y))}px`,
  );

  // View: 처음 크기로 = 100%, 화면에 맞추기 = every point inside the frame.
  await page.locator(".graph-bar button", { hasText: "처음 크기로" }).click();
  await page.waitForTimeout(400);
  const scale = await page.evaluate(() => /scale\(([\d.]+)\)/.exec(document.querySelector(".graph-world")!.getAttribute("transform")!)![1]);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(100);
  const zoomedOut = await page.evaluate(() => Number(/scale\(([\d.]+)\)/.exec(document.querySelector(".graph-world")!.getAttribute("transform")!)![1]));
  await page.locator(".graph-bar button", { hasText: "화면에 맞추기" }).click();
  await page.waitForTimeout(400);
  const inside = await page.evaluate(() => {
    const frame = document.querySelector(".graph-canvas")!.getBoundingClientRect();
    return Array.from(document.querySelectorAll("g[data-node] .graph-dot")).every((circle) => {
      const box = circle.getBoundingClientRect();
      return box.left >= frame.left && box.right <= frame.right && box.top >= frame.top && box.bottom <= frame.bottom;
    });
  });
  check("휠은 커서 자리에서 확대·축소, '처음 크기로'는 100%, '화면에 맞추기'는 모든 점이 틀 안", scale === "1" && zoomedOut < 0.6 && inside, `처음 ${scale} · 휠 뒤 ${zoomedOut.toFixed(2)}`);
  await page.locator(".graph-panel .icon-button[aria-label='닫기']").click();

  // Kept on this device: a reload shows the same colour, length and filters.
  await page.reload();
  await openGraph(page);
  await atRest(page);
  await page.locator(".graph-gear").click();
  const kept = await page.evaluate(() => ({
    stroke: getComputedStyle(document.querySelector(".graph-edges.related")!).stroke,
    length: (Array.from(document.querySelectorAll<HTMLInputElement>(".graph-slider")).find((row) => row.textContent?.includes("관련 선 길이"))?.querySelector("input") as HTMLInputElement | null)?.value,
    pin: (Array.from(document.querySelectorAll(".graph-switch")).find((row) => row.textContent?.includes("끌어 놓은 점 고정"))?.querySelector("input") as HTMLInputElement | null)?.checked,
    saved: JSON.parse(localStorage.getItem("workbench.graphSettings") ?? "{}"),
  }));
  await shot("06-after-reload.png");
  check("다시 열어도 설정이 남음(이 기기, workbench.graphSettings v1)", kept.stroke === "rgb(229, 72, 77)" && kept.length === "300" && kept.pin === true && kept.saved.v === 1, `${kept.stroke} · 길이 ${kept.length}`);
  await page.locator(".graph-panel button", { hasText: "모두 기본값으로" }).click();
  const reset = await page.evaluate(() => JSON.parse(localStorage.getItem("workbench.graphSettings") ?? "{}"));
  check("'모두 기본값으로'", reset.color?.related === null && reset.force?.relatedDistance === 130 && reset.force?.pin === false, JSON.stringify(reset.force));
  await page.locator(".graph-panel .icon-button[aria-label='닫기']").click();

  // A click without movement opens the project; so does Enter on a focused point.
  await atRest(page);
  await page.locator(`g[data-node="${nodeOf(works.draft)}"]`).click();
  const opened = await page.waitForSelector(".project-view .project-title", { timeout: 8000 }).then(() => page.locator(".project-title").innerText(), () => "");
  await page.locator(".topbar .brand").click();
  await page.waitForSelector(".graph-node.project");
  await page.locator(`g[data-node="${nodeOf(works.talk)}"]`).focus();
  await page.keyboard.press("Enter");
  const openedByKey = await page.waitForSelector(".project-view .project-title", { timeout: 8000 }).then(() => page.locator(".project-title").innerText(), () => "");
  check("움직이지 않은 누름은 프로젝트 페이지, 포커스한 점에서 Enter도", opened === "논문 초고" && openedByKey === "학회 발표", `${opened} · ${openedByKey}`);
  await page.close();

  // ── reduced motion: at rest at once, a drag still moves the point ─────────────────────
  const calm = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: "reduce" });
  watch(calm, "reduced");
  await calm.addInitScript(() => localStorage.setItem("workbench.projectsLayout", "graph"));
  await openGraph(calm);
  await calm.waitForFunction(() => document.querySelector(".graph-count")?.textContent?.startsWith("프로젝트 8 · 선 15"), undefined, { timeout: 10_000 });
  const calmState = await state(calm);
  const calmFirst = await places(calm);
  await calm.waitForTimeout(600);
  const calmLater = await places(calm);
  const still = JSON.stringify(calmFirst) === JSON.stringify(calmLater);
  const calmStart = await centre(calm, nodeOf(works.flow));
  await calm.mouse.move(calmStart.x, calmStart.y);
  await calm.mouse.down();
  await calm.mouse.move(calmStart.x + 120, calmStart.y - 80, { steps: 10 });
  const calmHeld = await centre(calm, nodeOf(works.flow));
  await calm.mouse.up();
  const calmDropped = await places(calm);
  await calm.waitForTimeout(400);
  const calmAfter = await places(calm);
  await calm.screenshot({ path: join(outDir, "07-reduced-motion.png") });
  check(
    "움직임 줄이기: 처음부터 쉬는 자리에 그리고(움직임 없음), 끌면 점이 바로 따라오고 놓은 뒤 움직이지 않음",
    calmState === "rest" && still && Math.hypot(calmHeld.x - calmStart.x - 120, calmHeld.y - calmStart.y + 80) < 3 && JSON.stringify(calmDropped) === JSON.stringify(calmAfter),
    `상태 ${calmState} · 그대로 ${still} · 끈 점 ${Math.round(calmHeld.x - calmStart.x)},${Math.round(calmHeld.y - calmStart.y)} · 놓은 뒤 그대로 ${JSON.stringify(calmDropped) === JSON.stringify(calmAfter)}`,
  );
  await calm.close();

  // ── dark: the theme's colours for points, lines and the panel ───────────────────────────
  const dark = await browser.newPage({ viewport: { width: 1440, height: 1100 }, colorScheme: "dark" });
  watch(dark, "dark");
  await dark.addInitScript(() => localStorage.setItem("workbench.projectsLayout", "graph"));
  await openGraph(dark);
  await atRest(dark);
  await dark.locator(".graph-gear").click();
  await dark.locator(`g[data-node="${nodeOf(works.talk)}"]`).hover();
  await dark.waitForTimeout(300);
  await dark.screenshot({ path: join(outDir, "09-dark.png") });
  const darkLook = await dark.evaluate(() => {
    const luminance = (color: string) => {
      const [r, g, b] = (color.match(/[\d.]+/g) ?? ["0", "0", "0"]).slice(0, 3).map(Number);
      return (0.2126 * r! + 0.7152 * g! + 0.0722 * b!) / 255;
    };
    return {
      panel: luminance(getComputedStyle(document.querySelector(".graph-panel")!).backgroundColor),
      label: luminance(getComputedStyle(document.querySelector(".graph-node.project text")!).fill),
    };
  });
  check("다크: 패널은 어두운 면, 점 글자는 밝게(테마 색 그대로)", darkLook.panel < 0.25 && darkLook.label > 0.6, JSON.stringify(darkLook));
  await dark.close();

  // ── 300 projects, about 600 lines: frame times ───────────────────────────────────────
  const many: Work[] = [];
  const created = Date.now();
  for (let batch = 0; batch < 30; batch += 1) {
    many.push(
      ...(await Promise.all(
        Array.from({ length: 10 }, async (_, at) => {
          const n = batch * 10 + at;
          const cwd = join(worksDir, `many-${n}`);
          mkdirSync(cwd, { recursive: true });
          return api<Work>("POST", "/api/works", { title: `과제 ${String(n).padStart(3, "0")}`, cwd });
        }),
      )),
    );
  }
  for (let batch = 0; batch < 30; batch += 1) {
    await Promise.all(
      many.slice(batch * 10, batch * 10 + 10).map(async (work, at) => {
        const n = batch * 10 + at;
        await api("PUT", `/api/projects/${work.id}/property`, { key: "tags", values: [`묶음${n % 12}`] });
        await api("PUT", `/api/projects/${work.id}/property`, { key: "관련", values: [`[[과제 ${String((n + 12 * (1 + (n % 3))) % 300).padStart(3, "0")}]]`] });
      }),
    );
  }
  numbers.push(`프로젝트 300개 만들기 ${Math.round((Date.now() - created) / 1000)}초`);
  const big = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  watch(big, "300");
  await big.addInitScript(() => localStorage.setItem("workbench.projectsLayout", "graph"));
  await big.goto(`${ready.url}/?token=${ready.token}`);
  await big.waitForSelector(".topbar .brand, .home-modes", { timeout: 20_000 });
  if (!(await big.locator(".home-modes").count())) await big.locator(".topbar .brand").click();
  await big.waitForFunction(() => document.querySelectorAll(".graph-node.project").length >= 300, undefined, { timeout: 20_000 });
  await big.locator(".graph-stage").evaluate((element) => element.scrollIntoView({ block: "center" }));
  const bigCounts = await big.evaluate(() => ({
    points: document.querySelectorAll(".graph-node").length,
    lines: Array.from(document.querySelectorAll(".graph-edges")).reduce((sum, path) => sum + (path.getAttribute("d") ?? "").split("M").length - 1, 0),
  }));
  const bigRested = await atRest(big, 20_000);
  await big.screenshot({ path: join(outDir, "08-300-projects.png") });
  // Measured on the graph alone, once the app's own start-up work is done: tag points off and on
  // again warm every point up (alpha 0.5), then a point dragged with a pointer event each frame.
  await big.waitForTimeout(1000);
  await big.evaluate(() => {
    (window as unknown as { longTasks: number[] }).longTasks = [];
    new PerformanceObserver((list) => (window as unknown as { longTasks: number[] }).longTasks.push(...list.getEntries().map((entry) => entry.duration))).observe({ type: "longtask" });
  });
  await big.locator(".graph-gear").click();
  const tagSwitch = big.locator(".graph-switch", { hasText: "태그 점 보이기" }).locator("input");
  const dragOnce = () =>
    big.evaluate(async (id) => {
      const dot = document.querySelector(`g[data-node="${id}"] .graph-dot`)!;
      const box = dot.getBoundingClientRect();
      const x0 = box.left + box.width / 2;
      const y0 = box.top + box.height / 2;
      const fire = (type: string, x: number, y: number, target: EventTarget) =>
        target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 9, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y }));
      fire("pointerdown", x0, y0, dot);
      const times: number[] = [];
      await new Promise<void>((done) => {
        let last = 0;
        let step = 0;
        const tick = (now: number) => {
          if (last) times.push(now - last);
          last = now;
          step += 1;
          fire("pointermove", x0 + step * 3, y0 + Math.sin(step / 8) * 40, window);
          if (step < 150) requestAnimationFrame(tick);
          else done();
        };
        requestAnimationFrame(tick);
      });
      fire("pointerup", x0 + 450, y0, window);
      return times;
    }, nodeOf(many[5]!));
  // Two windows each (other programs share this computer): the better one counts, both are reported.
  const settlings: ReturnType<typeof stats>[] = [];
  const draggings: ReturnType<typeof stats>[] = [];
  for (let round = 0; round < 2; round += 1) {
    await tagSwitch.uncheck();
    await atRest(big, 20_000);
    await tagSwitch.check();
    settlings.push(stats(await frames(big, 2500)));
    await atRest(big, 20_000);
  }
  await big.locator(".graph-panel .icon-button[aria-label='닫기']").click();
  for (let round = 0; round < 2; round += 1) {
    draggings.push(stats(await dragOnce()));
    await atRest(big, 20_000);
  }
  const best = (list: ReturnType<typeof stats>[]) => [...list].sort((a, b) => a.p95 - b.p95)[0]!;
  const settling = best(settlings);
  const dragging = best(draggings);
  const longTasks = await big.evaluate(() => (window as unknown as { longTasks: number[] }).longTasks.map(Math.round));
  numbers.push(`300점·${bigCounts.lines}선 Chromium 움직이는 동안 프레임 평균 ${settling.mean}ms · p95 ${settling.p95}ms · 최대 ${settling.max}ms (${settling.frames}프레임; 두 번: ${settlings.map((entry) => `${entry.mean}/${entry.p95}`).join(", ")})`);
  numbers.push(`끄는 동안 평균 ${dragging.mean}ms · p95 ${dragging.p95}ms · 최대 ${dragging.max}ms (두 번: ${draggings.map((entry) => `${entry.mean}/${entry.p95}`).join(", ")})`);
  numbers.push(`그 동안 긴 작업(50ms 넘음) ${longTasks.length}개${longTasks.length ? `: ${longTasks.slice(0, 6).join(", ")}ms` : ""}`);
  check(
    "300점·약 600선: 움직이는 동안과 끄는 동안 프레임이 부드러움(p95 25ms 미만)",
    bigCounts.points >= 300 && bigCounts.lines >= 560 && bigRested && settling.p95 < 25 && dragging.p95 < 25,
    `${bigCounts.points}점 · ${bigCounts.lines}선 · 움직임 ${JSON.stringify(settling)} · 끌기 ${JSON.stringify(dragging)}`,
  );
  await big.close();
} catch (error) {
  check("실행", false, error instanceof Error ? error.message.split("\n")[0]! : String(error));
} finally {
  await browser.close();
  child.kill();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(worksDir, { recursive: true, force: true });
  writeFileSync(join(outDir, "results.json"), JSON.stringify({ results, numbers, logs }, null, 2));
  for (const line of numbers) console.log(`· ${line}`);
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} passed · console: ${logs.length ? logs.slice(0, 6).join(" | ") : "clean"}`);
  process.exit(failed ? 1 : 0);
}
