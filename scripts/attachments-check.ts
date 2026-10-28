/// <reference lib="dom" />
// Browser check of files in the input, for Codex and Claude alike, against a real gateway driving
// stand-in engines (no model): a picture pasted with Ctrl+V becomes a chip with its thumbnail and
// reaches the engine as a picture (the stand-in reports its size); the request shows it and opens
// it whole (Esc closes); a PDF and a text file dropped on the box go without any text; a picture
// pasted while the engine works is steered into the turn; copying text that also carries a
// picture of itself (Word, web pages) pastes the text, not a file; and the input under a document
// takes pictures too; and pictures the engine takes or looks at while working (a browser
// screenshot, an image it opens) show in the conversation under the folded steps, as in the Codex app.
// Usage: node scripts/attachments-check.ts [outDir] [codex|claude]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Page } from "playwright-core";
import type { Provider, Session, TranscriptItem, Work } from "@workbench/contracts";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-attachments");
const providers: Provider[] = process.argv[3] === "codex" || process.argv[3] === "claude" ? [process.argv[3]] : ["codex", "claude"];
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-attach-"));
const worksDir = mkdtempSync(join(tmpdir(), "workbench-attach-works-"));
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
const session = async (id: string) => (await api<{ sessions: Session[] }>("GET", "/api/snapshot")).sessions.find((entry) => entry.id === id)!;
const items = async (id: string) => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${id}/items`)).items;
const until = async (what: () => Promise<boolean>, timeout = 15_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await what()) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return false;
};
await api("PUT", "/api/prefs", { prefs: { onboarding: "done", startScreen: "last" } });

/** A real picture made in the page (a canvas), pasted as the clipboard would carry it. */
async function pastePicture(page: Page, text = "", selector = ".composer-input") {
  return page.evaluate(async ({ plain, selector }) => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 40;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#2f6fdf";
    context.fillRect(0, 0, 64, 40);
    context.fillStyle = "#ffd23f";
    context.fillRect(8, 8, 24, 24);
    const blob = await new Promise<Blob>((done) => canvas.toBlob((value) => done(value!), "image/png"));
    const data = new DataTransfer();
    data.items.add(new File([blob], "image.png", { type: "image/png" }));
    if (plain) data.setData("text/plain", plain);
    const input = document.querySelector<HTMLTextAreaElement>(selector)!;
    input.focus();
    input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    return blob.size;
  }, { plain: text, selector });
}

/** Files dropped on the input box from the desktop. */
async function dropFiles(page: Page, files: { name: string; type: string; body: string }[]) {
  await page.evaluate((list) => {
    const data = new DataTransfer();
    for (const file of list) data.items.add(new File([file.body], file.name, { type: file.type }));
    const box = document.querySelector<HTMLElement>(".composer")!;
    box.dispatchEvent(new DragEvent("dragenter", { dataTransfer: data, bubbles: true, cancelable: true }));
    box.dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true }));
    box.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
  }, files);
}

const browser = await chromium.launch();
const logs: string[] = [];

async function flow(provider: Provider) {
  const label = provider === "codex" ? "Codex" : "Claude";
  // A folder the user picked exists (Claude Code starts in it).
  mkdirSync(join(worksDir, provider), { recursive: true });
  const work = await api<Work>("POST", "/api/works", { title: `${label} 첨부`, cwd: join(worksDir, provider) });
  const engine = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "첨부", access: "auto" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on("console", (message) => message.type() === "error" && logs.push(`[${label} error] ${message.text().slice(0, 200)}`));
  page.on("pageerror", (error) => logs.push(`[${label} pageerror] ${error.message.slice(0, 200)}`));
  const shot = (name: string) => page.screenshot({ path: join(outDir, `${provider}-${name}`) });
  const pass = (step: string, ok: boolean, detail = "") => check(`[${label}] ${step}`, ok, detail);
  const idle = () => until(async () => (await session(engine.id)).status === "idle", 20_000);
  const lastAnswer = async () => (await items(engine.id)).filter((item) => item.kind === "assistant").map((item) => (item.kind === "assistant" ? item.text : "")).join("\n");
  const uploaded = (count: number) => page.waitForFunction((n) => document.querySelectorAll(".composer .attach-chip").length === n && !document.querySelector(".composer .attach-chip .spinner"), count, { timeout: 10_000 });
  try {
    await page.addInitScript((id) => localStorage.setItem("workbench.lastWork", id), work.id);
    await page.goto(`${ready.url}/?token=${ready.token}`);
    await page.waitForSelector(".composer-input");

    // ── a picture pasted with Ctrl+V: a chip with its thumbnail, then the engine gets the picture ──
    const size = await pastePicture(page);
    await uploaded(1);
    const thumb = await page.locator(".composer .attach-chip img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0);
    await page.locator(".composer-input").fill("이 그림 봐 줘");
    await shot("01-pasted.png");
    pass("붙여넣은 그림이 입력창 위에 썸네일 칩으로 붙음", thumb, `${size}바이트`);
    await page.locator(".composer-input").press("Enter");
    await idle();
    const answer = await lastAnswer();
    pass("엔진이 그림을 그림으로 받음", answer.includes(`받은 그림 1장 · ${size}바이트`), answer.split("\n")[0]!.slice(0, 80));
    const chipsLeft = await page.locator(".composer .attach-chip").count();
    await page.waitForFunction(() => {
      const image = document.querySelector<HTMLImageElement>(".turn-request .attach-thumb img");
      return Boolean(image && image.complete && image.naturalWidth > 0);
    }, undefined, { timeout: 5000 });
    await shot("02-sent.png");
    pass("보낸 요청에 그림이 보이고 입력창 칩은 비워짐", chipsLeft === 0);

    // ── the picture whole, over everything; Esc closes it ──────────────────────────────────────
    await page.locator(".turn-request .attach-thumb").first().click();
    await page.waitForSelector(".attach-lightbox img");
    await shot("03-whole.png");
    await page.keyboard.press("Escape");
    const closed = await page.waitForSelector(".attach-lightbox", { state: "detached", timeout: 3000 }).then(() => true).catch(() => false);
    pass("그림을 누르면 크게 보이고 Esc로 닫힘", closed);

    // ── a PDF and a text file dropped on the box, sent without any text ────────────────────────
    await dropFiles(page, [
      { name: "자료.pdf", type: "application/pdf", body: "%PDF-1.4\n% 점검용\n" },
      { name: "메모.txt", type: "text/plain", body: "점검용 메모\n" },
    ]);
    await uploaded(2);
    await shot("04-dropped.png");
    await page.locator(".composer .icon-button.primary").click();
    await idle();
    const files = await lastAnswer();
    const expected = provider === "claude" ? files.includes("받은 PDF 1개") && files.includes(`받은 파일 경로 1개 · ${Buffer.byteLength("점검용 메모\n")}바이트`) : files.includes("받은 파일 경로 2개");
    const request = (await items(engine.id)).filter((item) => item.kind === "user").at(-1);
    pass(
      "끌어 놓은 PDF·글 파일을 글 없이 보냄 (Claude는 PDF를 문서로, 나머지는 경로로)",
      expected && request?.kind === "user" && request.attachments?.length === 2,
      files.split("\n").filter((line) => line.includes("받은")).at(-1)?.slice(0, 100) ?? "",
    );

    // ── a picture pasted while the engine works goes into the running turn ─────────────────────
    await page.locator(".composer-input").fill("길게 설명해줘");
    await page.locator(".composer-input").press("Enter");
    await until(async () => (await session(engine.id)).status === "running", 5000);
    await page.waitForTimeout(300);
    await pastePicture(page);
    await uploaded(1);
    await page.locator(".composer-input").fill("이 그림도 반영해 줘");
    await page.locator(".composer-input").press("Enter");
    // Claude Code may go idle for a moment between the turn and the request it runs right after.
    await until(async () => (await lastAnswer()).includes("이어서 받은 요청을 반영합니다: 이 그림도 반영해 줘"), 20_000);
    await idle();
    // Codex folds it into the turn; Claude Code runs it right after a turn with no further tool step.
    const steered = (await items(engine.id)).find((item) => item.kind === "user" && item.text === "이 그림도 반영해 줘");
    const after = await lastAnswer();
    await shot("05-steered.png");
    pass(
      "작업 중에 붙인 그림이 하던 작업에 전해짐",
      steered?.kind === "user" && steered.attachments?.length === 1 && after.includes("이어서 받은 요청을 반영합니다: 이 그림도 반영해 줘") && after.includes("받은 그림 1장"),
      steered?.kind === "user" ? `요청 첨부 ${steered.attachments?.length ?? 0} · ${steered.steered ? "끼어듦" : "다음 차례"}` : "요청 없음",
    );

    // ── copying text that also carries a picture of itself pastes the text ────────────────────
    const before = await page.locator(".composer .attach-chip").count();
    await pastePicture(page, "워드에서 복사한 글");
    await page.waitForTimeout(300);
    pass("글과 그림이 함께 복사된 경우(워드 등)는 글로 붙여넣음", (await page.locator(".composer .attach-chip").count()) === before);

    // ── pictures the engine takes or opens while working show under the folded steps ───────────
    await page.locator(".composer-input").fill("스크린샷 찍어서 보여줘");
    await page.locator(".composer-input").press("Enter");
    await idle();
    await page.waitForFunction(() => {
      const shown = Array.from(document.querySelectorAll<HTMLImageElement>(".work-block + .attach-strip .attach-thumb img"));
      return shown.length === 2 && shown.every((image) => image.complete && image.naturalWidth > 0);
    }, undefined, { timeout: 8000 }).catch(() => undefined);
    const shots = await page.locator(".work-block + .attach-strip .attach-thumb img").count();
    const folded = (await page.locator(".work-block .work-list").count()) === 0;
    const stepImages = (await items(engine.id)).filter((item) => item.kind === "tool" && item.images?.length).length;
    await page.locator(".work-block + .attach-strip").last().scrollIntoViewIfNeeded();
    await shot("06-engine-shots.png");
    pass("엔진이 찍은 스크린숏·열어 본 그림이 접힌 작업 단계 아래 대화에 미리보기로 보임", shots === 2 && folded && stepImages === 2, `그림 ${shots}장 · 단계 ${stepImages}개`);

    // ── the input under a document takes pictures too ─────────────────────────────────────────
    await page.locator(`.sidebar [data-row-id="${work.id}"]`).hover();
    await page.locator(`.sidebar [data-row-id="${work.id}"] .row-add`).click();
    await page.waitForSelector(".document-view .doc-composer .composer-input", { timeout: 10_000 });
    const docSize = await pastePicture(page, "", ".doc-composer .composer-input");
    await page.waitForFunction(() => document.querySelectorAll(".doc-composer .attach-chip").length === 1 && !document.querySelector(".doc-composer .attach-chip .spinner"), undefined, { timeout: 10_000 });
    await page.locator(".doc-composer .composer-input").fill("이 그림처럼 정리해 줘");
    await shot("07-document.png");
    await page.locator(".doc-composer .composer-input").press("Enter");
    await until(async () => (await lastAnswer()).includes(`(받은 그림 1장 · ${docSize}바이트)`) && (await session(engine.id)).status === "idle", 20_000);
    const asked = (await items(engine.id)).filter((item) => item.kind === "user").at(-1);
    pass("문서 아래 입력창에 붙인 그림도 엔진에 전해짐", asked?.kind === "user" && asked.attachments?.length === 1 && (asked.refs?.length ?? 0) === 1, asked?.kind === "user" ? asked.text.slice(0, 40) : "");
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
