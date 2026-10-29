/// <reference lib="dom" />
// Browser check of how a vault note looks, against a real gateway and a fixture vault in a temporary
// folder (the user's vault is never touched), with a second local server standing in for R2:
//   callouts (`> [!NOTE] 제목`, a nested one, a folded one, a custom kind), ==highlights==, #tags,
//   hidden ^block-ids; pictures from the vault (`![[pic.png|120]]`), from the web (Markdown and
//   `<img width>`) fetched without the gateway's token or a referrer; `<details>`; a script and an
//   onerror that must not run; `![[note#heading]]` and `![[note]]` shown in place and opening that
//   note; a note whose first picture is on the web shows it on its card.
// Usage: node scripts/vault-markdown-check.ts [outDir]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";
import { pagePng } from "./fixtures/png.mjs";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-vault-markdown");
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-vault-markdown-"));
const vault = mkdtempSync(join(tmpdir(), "workbench-vault-markdown-vault-"));
const results: { step: string; ok: boolean; detail: string }[] = [];
const pass = (step: string, ok: boolean, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
};

// ── a stand-in for R2: serves pictures and remembers what each request carried ─────────────────
const seen: { path: string; headers: IncomingHttpHeaders }[] = [];
const remote = createServer((req, res) => {
  seen.push({ path: req.url ?? "", headers: req.headers });
  res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
  res.end(pagePng(240, 140, [216, 90, 60]));
});
await new Promise<void>((done) => remote.listen(0, "127.0.0.1", done));
const web = `http://127.0.0.1:${(remote.address() as AddressInfo).port}`;

// ── the fixture vault ──────────────────────────────────────────────────────────────────────────
const put = (path: string, data: string | Buffer) => {
  mkdirSync(dirname(join(vault, path)), { recursive: true });
  writeFileSync(join(vault, path), data);
};
put(".obsidian/app.json", "{}");
put("attachments/pic.png", pagePng(300, 180, [47, 111, 223]));
put(
  "20. Information/표시 검사.md",
  [
    "---",
    "title: 표시 검사",
    "tags: [검사]",
    "---",
    "# 표시 검사",
    "",
    "> [!NOTE] 회의 메모",
    "> 본문 ==강조== 와 #워크벤치/검사 태그 ^blk-1",
    ">",
    "> > [!quote] 안쪽 인용",
    "> > 인용 내용",
    "",
    "> [!warning]- 접힌 경고",
    "> 숨은 내용",
    "",
    "> [!full sermon] 사용자 정의 종류",
    "> 사용자 정의 내용",
    "",
    "![[pic.png|120]]",
    "",
    `![원격 그림|200](${web}/r2.png)`,
    "",
    `<img src="${web}/r2-html.png" alt="HTML 그림" width="150" loading="lazy" onerror="window.__ran = 'onerror'">`,
    "",
    "<details><summary>더 보기</summary>",
    "",
    "접힌 HTML 내용",
    "",
    "</details>",
    "",
    "<script>window.__ran = 'script'</script>",
    "",
    "![[수업 설계#목표]]",
    "",
    "![[수업 설계]]",
    "",
  ].join("\n"),
);
put("20. Information/수업 설계.md", ["# 수업 설계", "", "소개 문단", "", "## 목표", "", "학생이 직접 써 본다", "", "## 평가", "", "평가 기준", ""].join("\n"));
put("20. Information/원격 표지.md", [`![표지](${web}/cover.png)`, "", "첫 그림이 웹에 있는 노트", ""].join("\n"));

const child = spawn(process.execPath, ["apps/host/src/main.ts"], {
  env: {
    ...process.env,
    WORKBENCH_DATA_DIR: dataDir,
    WORKBENCH_WEB_DIR: "apps/web/dist",
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
  return (await response.json()) as T;
};
await api("PUT", "/api/prefs", { prefs: { onboarding: "done", startScreen: "last" } });
await api("PUT", "/api/pkm/vault", { path: vault });

const browser = await chromium.launch();
const logs: string[] = [];
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("console", (message) => message.type() === "error" && logs.push(`[error] ${message.text().slice(0, 200)}`));
page.on("pageerror", (error) => logs.push(`[pageerror] ${error.message.slice(0, 200)}`));
const shot = (name: string) => page.screenshot({ path: join(outDir, name) });
const loaded = (selector: string) =>
  page.waitForFunction((css) => {
    const image = document.querySelector<HTMLImageElement>(css);
    return Boolean(image && image.complete && image.naturalWidth > 0);
  }, selector, { timeout: 10_000 }).then(() => true, () => false);

try {
  await page.goto(`${ready.url}/?token=${ready.token}`);
  await page.waitForSelector('.vault-row[data-vault-path="20. Information"]', { timeout: 15_000 });
  await page.locator('.vault-row[data-vault-path="20. Information"]').click();
  await page.waitForSelector(".pkm-card", { timeout: 10_000 });

  // ── a card whose first picture is on the web ──────────────────────────────────────────────
  const coverImage = page.locator(".pkm-card", { hasText: "원격 표지" }).locator(".pkm-card-thumb img");
  const cover = await coverImage
    .waitFor({ timeout: 10_000 })
    .then(() => coverImage.evaluate((image) => new Promise<boolean>((done) => ((image as HTMLImageElement).complete ? done((image as HTMLImageElement).naturalWidth > 0) : image.addEventListener("load", () => done(true), { once: true })))))
    .catch(() => false);
  pass("첫 그림이 웹(R2)에 있는 노트도 카드에 그림이 보임", cover);

  await page.locator(".pkm-card", { hasText: "표시 검사" }).click();
  await page.waitForSelector(".pkm-note-view .pkm-note-body .callout", { timeout: 10_000 });
  const body = page.locator(".pkm-note-view .pkm-note-body").first();

  // ── callouts ──────────────────────────────────────────────────────────────────────────────
  const kinds = await body.locator(":scope > .callout, :scope > details.callout, .callout .callout").evaluateAll((nodes) => nodes.map((node) => `${node.getAttribute("data-callout")}:${node.getAttribute("data-kind")}`));
  const titles = await body.locator(".callout-title-inner").allInnerTexts();
  const text = await body.innerText();
  pass(
    "콜아웃: [!NOTE]·중첩 [!quote]·접힌 [!warning]-·사용자 정의 종류가 상자로, 제목과 아이콘과 함께",
    kinds.length === 4 && kinds.includes("note:note") && kinds.includes("quote:quote") && kinds.includes("warning:warning") && kinds.includes("full sermon:note") && titles.includes("회의 메모") && (await body.locator(".callout-icon svg").count()) === 4 && !text.includes("[!NOTE]"),
    `${kinds.join(", ")} · ${titles.join(" / ")}`,
  );
  const folded = body.locator("details.callout[data-callout='warning']");
  const hiddenBefore = !(await folded.locator(".callout-content").isVisible());
  await folded.locator("summary").click();
  const shownAfter = await folded.locator(".callout-content").isVisible();
  await page.waitForTimeout(400);
  // The chevron turns down once open (rotate(45deg): the matrix's first two numbers are both +0.707).
  const turned = await folded.locator("summary").evaluate((summary) => getComputedStyle(summary, "::after").transform);
  pass("접힌 콜아웃은 닫혀 있다가 제목을 누르면 펼쳐지고 화살표가 아래를 향함", hiddenBefore && shownAfter && /^matrix\(0\.70\d+, 0\.70\d+,/.test(turned), turned);

  // ── highlights, tags, block ids ───────────────────────────────────────────────────────────
  const mark = await body.locator("mark").first().innerText();
  const tag = await body.locator(".md-tag").first().innerText();
  pass("==강조==는 형광펜, #태그는 알약, ^블록id는 안 보임", mark === "강조" && tag === "#워크벤치/검사" && !text.includes("^blk-1"), `${mark} · ${tag}`);

  // ── pictures ──────────────────────────────────────────────────────────────────────────────
  const local = await loaded(".pkm-note-body img[alt='pic.png']");
  const md = await loaded(".pkm-note-body img[alt='원격 그림']");
  const html = await loaded(".pkm-note-body img[alt='HTML 그림']");
  const widths = await body.locator("img").evaluateAll((images) => (images as HTMLImageElement[]).map((image) => `${image.alt}:${image.getAttribute("width")}`));
  pass("그림: 볼트 그림(![[pic.png|120]]), 웹 그림(마크다운·<img width>)이 모두 보이고 크기도 그대로", local && md && html && widths.includes("pic.png:120") && widths.includes("원격 그림:200") && widths.includes("HTML 그림:150"), widths.join(", "));
  const toRemote = seen.filter((entry) => entry.path.startsWith("/r2"));
  pass(
    "웹 그림 요청에 게이트웨이 토큰도, 어느 노트에서 왔는지(referer)도 실리지 않음",
    toRemote.length >= 2 && toRemote.every((entry) => !entry.headers.authorization && !entry.headers.referer),
    `${toRemote.length}건 · ${toRemote.map((entry) => entry.path).join(", ")}`,
  );

  // ── HTML the note carries ─────────────────────────────────────────────────────────────────
  const ran = await page.evaluate(() => (window as unknown as { __ran?: string }).__ran ?? null);
  const details = await body.locator("details:not(.callout) > summary").innerText();
  pass("HTML: <details>는 그려지고, <script>와 onerror는 실행되지 않음", details === "더 보기" && ran === null && !text.includes("window.__ran"), `ran=${ran}`);

  // ── notes put into the note ───────────────────────────────────────────────────────────────
  await page.waitForFunction(() => document.querySelectorAll(".pkm-note-body .note-embed-body").length === 2, undefined, { timeout: 10_000 }).catch(() => undefined);
  const embeds = await body.locator(".note-embed").allInnerTexts();
  const section = embeds[0] ?? "";
  const whole = embeds[1] ?? "";
  await shot("01-note.png");
  await body.locator(".note-embed").first().scrollIntoViewIfNeeded();
  await shot("02-embeds.png");
  pass(
    "![[수업 설계#목표]]는 그 제목 아래만, ![[수업 설계]]는 노트 전체를 그 자리에 보여 줌",
    embeds.length === 2 && section.includes("학생이 직접 써 본다") && !section.includes("평가 기준") && whole.includes("소개 문단") && whole.includes("평가 기준"),
    embeds.map((entry) => entry.replace(/\s+/g, " ").slice(0, 50)).join(" | "),
  );
  await body.locator(".note-embed .note-embed-head").first().click();
  const opened = await page.waitForFunction(() => document.querySelector(".pkm-note-view .pkm-title")?.textContent === "수업 설계", undefined, { timeout: 8000 }).then(() => true, () => false);
  pass("넣은 노트의 이름을 누르면 그 노트가 열림", opened);
} catch (error) {
  pass("실행", false, error instanceof Error ? error.message.split("\n")[0]! : String(error));
  await page.screenshot({ path: join(outDir, "99-failure.png") }).catch(() => undefined);
} finally {
  writeFileSync(join(outDir, "console.log"), logs.join("\n"));
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
  await browser.close();
  child.kill();
  await new Promise((done) => (child.exitCode === null && child.signalCode === null ? child.once("exit", done) : done(null)));
  remote.close();
  for (const dir of [dataDir, vault]) rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} passed · console: ${logs.length ? logs.slice(0, 6).join(" | ") : "clean"}`);
  process.exitCode = failed ? 1 : 0;
}
