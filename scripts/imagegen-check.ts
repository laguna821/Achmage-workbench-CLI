/// <reference lib="dom" />
// Browser check of "그림" (GPT Image through Codex), for Codex and Claude conversations alike,
// against a real gateway driving stand-in engines (the stand-in Codex draws a small PNG; no model):
// the pill sits after access and context under the input; picking a template turns drawing on and
// the chip says how (and, in a Claude conversation, that a Codex session draws); the request comes
// back as a picture card in the same conversation, saved under images/ in the work folder with the
// template in its prompt; a Claude conversation stays the one shown while the work's Codex drawing
// session draws; the card opens the picture full size, copies its path and puts it into the current
// Markdown document; "여기에 그림 그리기" in a Markdown document draws and inserts the link where
// the cursor was, saved as the document's next revision.
// Usage: node scripts/imagegen-check.ts [outDir] [codex|claude]

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Page } from "playwright-core";
import type { Artifact, ImageItem, Provider, Session, TranscriptItem, Work } from "@workbench/contracts";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-imagegen");
const providers: Provider[] = process.argv[3] === "codex" || process.argv[3] === "claude" ? [process.argv[3]] : ["codex", "claude"];
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-imagegen-"));
const worksDir = mkdtempSync(join(tmpdir(), "workbench-imagegen-works-"));
const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
};

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
  return (await response.json()) as T;
};
const snapshot = () => api<{ sessions: Session[]; works: Work[]; artifacts: Artifact[] }>("GET", "/api/snapshot");
const items = async (id: string) => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${id}/items`)).items;
const images = async (id: string) => (await items(id)).filter((item): item is ImageItem => item.kind === "image");
const until = async (what: () => Promise<boolean>, timeout = 15_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await what()) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return false;
};
await api("PUT", "/api/prefs", { prefs: { onboarding: "done", startScreen: "last" } });

const browser = await chromium.launch();
const logs: string[] = [];

/** The picture in a card has loaded (a real image, not a broken one). */
const pictureLoaded = (page: Page, selector: string) =>
  page
    .waitForFunction((css) => {
      const image = document.querySelector<HTMLImageElement>(css);
      return Boolean(image && image.complete && image.naturalWidth > 0);
    }, selector, { timeout: 10_000 })
    .then(() => true)
    .catch(() => false);

async function flow(provider: Provider) {
  const label = provider === "codex" ? "Codex" : "Claude";
  const cwd = join(worksDir, provider);
  mkdirSync(cwd, { recursive: true });
  const work = await api<Work>("POST", "/api/works", { title: `${label} 그림`, cwd });
  const engine = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "그림 요청", access: "ask" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on("console", (message) => message.type() === "error" && logs.push(`[${label} error] ${message.text().slice(0, 200)}`));
  page.on("pageerror", (error) => logs.push(`[${label} pageerror] ${error.message.slice(0, 200)}`));
  const shot = (name: string) => page.screenshot({ path: join(outDir, `${provider}-${name}`) });
  const pass = (step: string, ok: boolean, detail = "") => check(`[${label}] ${step}`, ok, detail);
  const idle = (id: string) => until(async () => (await snapshot()).sessions.find((entry) => entry.id === id)?.status === "idle", 20_000);
  try {
    await page.addInitScript((id) => localStorage.setItem("workbench.lastWork", id), work.id);
    await page.goto(`${ready.url}/?token=${ready.token}`);
    await page.waitForSelector(".composer-input");
    await page.waitForTimeout(400);

    // ── the pill: after access and context, in the left slot ──────────────────────────────────
    const order = await page.locator(".work-view .composer-left").evaluate((left) => Array.from(left.querySelectorAll("button.plain-select"), (button) => button.className));
    pass("'그림' 알약이 입력창 왼쪽 권한(·컨텍스트) 다음에 있음", order.length >= 2 && order[0]!.includes("access-select") && order.at(-1)!.includes("draw-pill"), order.join(" | "));

    // ── pick a template: drawing turns on, the chip says how and by whom ─────────────────────
    await page.locator(".draw-pill").click();
    await page.waitForSelector(".draw-menu");
    await page.locator(".draw-menu .draw-template", { hasText: "인포그래픽" }).click();
    await page.locator(".draw-menu .draw-aspect button", { hasText: "가로" }).click();
    await page.waitForTimeout(150);
    await shot("01-menu.png");
    const menu = await page.locator(".draw-menu").innerText();
    const switched = await page.locator(".draw-menu .draw-switch input").isChecked();
    await page.keyboard.press("Escape");
    const chip = await page.locator(".work-view .draw-chip").innerText().catch(() => "");
    const pill = await page.locator(".draw-pill").innerText();
    const placeholder = await page.locator(".work-view .composer-input").getAttribute("placeholder");
    const claudeNote = menu.includes("Claude는 그림을 그리지 못해") && chip.includes("Codex 그림 세션이 그리고") && chip.includes("이 대화에 보입니다");
    pass(
      "템플릿을 고르면 그림이 켜지고 칩·자리표시가 바뀜" + (provider === "claude" ? "(Codex가 그린다는 안내 포함)" : ""),
      switched && chip.includes("그림 · 인포그래픽 · 가로") && pill.includes("인포그래픽") && placeholder === "그릴 그림을 설명하세요" && menu.includes("GPT Image (Codex 전용)") && (provider === "codex" || claudeNote),
      `chip="${chip.replace(/\s+/g, " ")}" pill="${pill}"`,
    );

    // ── draw: the card comes back into this conversation ──────────────────────────────────────
    const input = page.locator(".work-view .composer-input");
    await input.fill("파란 원 하나, 흰 바탕");
    await input.press("Enter");
    await page.waitForSelector(".image-card", { timeout: 8000 });
    await page.waitForTimeout(150);
    await shot("02-drawing.png");
    const drawn = await page.waitForSelector(".image-card.status-done", { timeout: 15_000 }).then(() => true).catch(() => false);
    const loaded = await pictureLoaded(page, ".image-card.status-done .image-card-picture img");
    await page.waitForTimeout(300);
    await shot("03-card.png");
    const offAgain = !(await page.locator(".draw-pill.on").count());
    const [card] = await images(engine.id);
    const file = card?.image.path && existsSync(card.image.path) ? readFileSync(card.image.path) : null;
    pass(
      "그림 카드가 같은 대화에 나오고 작업 폴더 images/에 PNG로 저장됨",
      drawn && loaded && Boolean(file && file.readUInt32BE(0) === 0x89504e47) && card?.image.relPath?.startsWith("images/") === true && card.image.width === 120 && card.image.height === 80,
      `${card?.image.relPath} ${card?.image.width}×${card?.image.height} · images/ ${existsSync(join(cwd, "images")) ? readdirSync(join(cwd, "images")).length : 0}개`,
    );
    pass(
      "프롬프트에 템플릿·요청·비율이 들어가고 보낸 뒤 그림은 꺼짐",
      Boolean(card?.image.prompt.startsWith("Flat infographic") && card.image.prompt.includes("파란 원 하나, 흰 바탕\n\nLandscape composition")) && card?.image.template === "인포그래픽" && offAgain,
      card?.image.prompt.slice(0, 60),
    );
    const after = await snapshot();
    const drawers = after.sessions.filter((entry) => entry.workId === work.id && entry.provider === "codex");
    if (provider === "claude") {
      const helper = drawers.find((entry) => entry.purpose === "그림");
      const helperItems = helper ? await items(helper.id) : [];
      const request = helperItems.find((item) => item.kind === "user");
      const via = await page.locator(".image-card .image-card-via").innerText().catch(() => "");
      const claudeRequests = (await items(engine.id)).filter((item) => item.kind === "user").length;
      pass(
        "Claude 대화: 이 작업의 Codex '그림' 세션이 그리고, 화면은 Claude 대화에 머묾",
        Boolean(helper) && card?.image.drawSessionId === helper?.id && after.works.find((entry) => entry.id === work.id)?.activeSessionId === engine.id && claudeRequests === 0 && via.includes("「그림」 Codex 세션이 그림"),
        `helper=${helper?.purpose} active=${after.works.find((entry) => entry.id === work.id)?.activeSessionId === engine.id ? "Claude" : "다른 세션"} via="${via.replace(/\s+/g, " ")}"`,
      );
      pass(
        "Codex 그림 세션에도 같은 그림과 'Claude 대화에서 온 요청'이 남음",
        request?.kind === "user" && request.from?.sessionId === engine.id && Boolean(request.draw) && helperItems.some((item) => item.kind === "image" && item.image.status === "done"),
        request?.kind === "user" ? request.from?.label : "",
      );
    } else {
      const tag = await page.locator(".turn-request .draw-tag").innerText().catch(() => "");
      pass("Codex 대화: 이 세션이 그리고 요청에 '그림' 표시", drawers.length === 1 && card?.image.drawSessionId === engine.id && tag.includes("그림 · 인포그래픽"), `tag="${tag}"`);
    }
    await idle(card?.image.drawSessionId ?? engine.id);

    // ── the card: full size, copy the path ──────────────────────────────────────────────────────
    await page.locator(".image-card .image-card-picture").first().click();
    const viewer = await page.waitForSelector(".image-viewer img", { timeout: 4000 }).then(() => true).catch(() => false);
    const big = await pictureLoaded(page, ".image-viewer img");
    await shot("04-viewer.png");
    await page.keyboard.press("Escape");
    const closed = await page.waitForSelector(".image-viewer", { state: "detached", timeout: 3000 }).then(() => true).catch(() => false);
    await page.locator(".image-card button", { hasText: "경로 복사" }).first().click();
    const copied = await page.locator(".image-card .image-card-note").first().innerText().catch(() => "");
    pass("카드: 크게 보기(Esc로 닫힘)와 경로 복사", viewer && big && closed && copied.includes("경로를 복사했습니다"), copied);
    await shot("05-chat.png");

    // ── own templates and standing rules (kept in the gateway's data folder) ─────────────────────
    if (provider === "codex") {
      await page.locator(".draw-pill").click();
      await page.locator(".draw-menu .draw-label .link", { hasText: "관리" }).click();
      await page.locator(".draw-manager input[aria-label='템플릿 이름']").fill("수업 슬라이드");
      await page.locator(".draw-manager textarea[aria-label='템플릿 내용']").fill("16:9 slide illustration, calm colors");
      await page.locator(".draw-manager button", { hasText: "템플릿 더하기" }).click();
      await page.waitForSelector(".draw-manager .draw-mine");
      await page.locator(".draw-manager textarea[aria-label='항상 붙일 규칙']").fill("No text inside the image.");
      await page.locator(".draw-manager button", { hasText: "규칙 저장" }).click();
      await page.waitForFunction(() => document.querySelector(".draw-manager .draw-note")?.textContent?.includes("규칙을 저장했습니다"), null, { timeout: 4000 });
      await shot("05b-templates.png");
      await page.locator(".draw-manager .text-button").first().click();
      const mine = await page.locator(".draw-menu .draw-template.mine").innerText().catch(() => "");
      await page.keyboard.press("Escape");
      const stored = JSON.parse(readFileSync(join(dataDir, "image-templates.json"), "utf8")) as { templates: { name: string }[]; rules: string };
      pass("내 템플릿·항상 붙일 규칙이 게이트웨이 데이터 폴더에 저장되고 목록에 나옴", mine === "수업 슬라이드" && stored.templates[0]?.name === "수업 슬라이드" && stored.rules === "No text inside the image.", `${mine} · ${JSON.stringify(stored)}`);
    }

    // ── "여기에 그림 그리기" in a Markdown document ─────────────────────────────────────────────
    await page.locator(`.sidebar [data-row-id="${work.id}"]`).hover();
    await page.locator(`.sidebar [data-row-id="${work.id}"] .row-add`).click();
    await page.waitForSelector(".document-view .md-editor .cm-content", { timeout: 10_000 });
    const doc = (await snapshot()).artifacts.find((entry) => entry.workId === work.id && entry.format === "markdown")!;
    await page.locator(".md-editor .cm-content").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type("수업 도입 그림:");
    await until(async () => readFileSync(doc.path, "utf8").includes("수업 도입 그림:"), 6000);
    // Both ways in: the header's "그림" (Codex run) and Ctrl+Alt+G in the editor (Claude run).
    if (provider === "codex") await page.locator(".draw-here").click();
    else await page.keyboard.press("Control+Alt+g");
    await page.waitForSelector(".inline-draw textarea");
    await page.locator(".inline-draw textarea").fill("천천히 그리는 초록 나무");
    await page.waitForTimeout(150);
    await shot("06-draw-here.png");
    const note = await page.locator(".inline-draw .draw-note").innerText();
    await page.locator(".inline-draw button", { hasText: "그리기" }).click();
    const marker = await page.waitForSelector(".cm-draw-pending", { timeout: 4000 }).then(() => true).catch(() => false);
    await shot("07-inline-drawing.png");
    const linked = await page
      .waitForFunction(() => document.querySelector(".md-editor .cm-content")?.textContent?.includes("](images/"), null, { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    const savedLink = await until(async () => /\]\(images\/[^)]+\.png\)/.test(readFileSync(doc.path, "utf8")), 8000);
    const text = readFileSync(doc.path, "utf8");
    const revision = (await snapshot()).artifacts.find((entry) => entry.id === doc.id)?.revision ?? 0;
    const inlineImage = (await images(engine.id)).find((item) => item.image.brief.includes("초록 나무"))?.image;
    await shot("08-inline-done.png");
    pass(
      "여기에 그림 그리기" + (provider === "codex" ? "(머리줄 '그림')" : "(Ctrl+Alt+G, Codex 그림 세션이 그림)") + ": 그리는 동안 커서 자리에 표시, 끝나면 그 자리에 링크가 들어가 새 판으로 저장",
      marker &&
        linked &&
        savedLink &&
        /수업 도입 그림:\n\n!\[천천히 그리는 초록 나무\]\(images\/[^)]+\.png\)\n/.test(text) &&
        !(await page.locator(".cm-draw-pending").count()) &&
        revision >= 3 &&
        inlineImage?.insertInto === doc.id &&
        Boolean(inlineImage?.prompt.endsWith("Always follow these rules:\nNo text inside the image.")) &&
        (provider === "codex" ? note.includes("그림 요청") : note.includes("Claude는 그림을 그리지 못해")),
      `r${revision} · ${JSON.stringify(text.slice(-90))} · ${note.slice(0, 40)} · 규칙 ${inlineImage?.prompt.includes("Always follow") ? "붙음" : "없음"}`,
    );

    // The preview shows the picture from the work folder.
    await page.locator(".doc-header .segmented button", { hasText: "미리보기" }).click();
    const previewed = await pictureLoaded(page, ".doc-preview img");
    await shot("09-preview.png");
    await page.locator(".doc-header .segmented button", { hasText: "편집" }).click();
    pass("미리보기에 작업 폴더의 그림이 보임", previewed);

    // ── "현재 문서에 넣기" on the card in the conversation ────────────────────────────────────────
    await page.locator(".doc-header .ghost-button", { hasText: "대화" }).click();
    await page.waitForSelector(".work-view .image-card.status-done");
    const cards = await page.locator(".work-view .image-card.status-done").count();
    const insertButton = page.locator(".work-view .image-card.status-done").first().locator("button", { hasText: "현재 문서에 넣기" });
    const hint = await insertButton.getAttribute("title");
    await insertButton.click();
    await page.waitForSelector(".document-view .md-editor", { timeout: 6000 });
    const second = await until(async () => (readFileSync(doc.path, "utf8").match(/\]\(images\//g) ?? []).length === 2, 8000);
    const final = readFileSync(doc.path, "utf8");
    await page.waitForTimeout(300);
    await shot("10-inserted.png");
    pass(
      "카드의 '현재 문서에 넣기'가 그 문서를 열고 커서 자리(앞 그림 뒤)에 링크를 넣어 저장",
      second && cards === 2 && /!\[천천히 그리는 초록 나무\][^\n]*\n\n!\[파란 원 하나, 흰 바탕\]\(images\/[^)]+\.png\)\n/.test(final) && Boolean(hint?.includes(doc.name)),
      `cards=${cards} · ${JSON.stringify(final.slice(-120))}`,
    );
    await shot("11-final.png");

    // The same in the dark look.
    await api("PUT", "/api/prefs", { prefs: { onboarding: "done", startScreen: "last", theme: "dark" } });
    await page.locator(".doc-header .ghost-button", { hasText: "대화" }).click();
    await page.waitForSelector(".work-view .image-card.status-done");
    await page.waitForTimeout(400);
    await page.locator(".draw-pill").click();
    await page.waitForSelector(".draw-menu");
    await shot("12-dark.png");
    await page.keyboard.press("Escape");
    await api("PUT", "/api/prefs", { prefs: { onboarding: "done", startScreen: "last" } });
  } catch (error) {
    pass("실행", false, error instanceof Error ? error.message.split("\n")[0]! : String(error));
    await page.screenshot({ path: join(outDir, `${provider}-99-failure.png`) }).catch(() => undefined);
  } finally {
    await page.close();
  }
}

try {
  for (const provider of providers) await flow(provider);
} finally {
  writeFileSync(join(outDir, "console.log"), logs.join("\n"));
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
  await browser.close();
  child.kill();
  await new Promise((done) => (child.exitCode === null && child.signalCode === null ? child.once("exit", done) : done(null)));
  for (const dir of [dataDir, worksDir]) rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} passed · console: ${logs.length ? logs.slice(0, 6).join(" | ") : "clean"}`);
  process.exitCode = failed ? 1 : 0;
}
