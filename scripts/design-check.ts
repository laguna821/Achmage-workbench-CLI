/// <reference lib="dom" />
// Browser check of the design page (vendored doory editor) against a real gateway: open a design,
// edit it, see the save become a revision, render thumbnails, and hit a revision conflict.
// Usage: node scripts/design-check.ts [outDir] [--browser=chromium|webkit]

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Frame, type Page } from "playwright-core";

const outDir = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : join(tmpdir(), "wb-design-check");
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-design-"));
const cwd = mkdtempSync(join(tmpdir(), "workbench-design-cwd-"));

const child = spawn(process.execPath, ["apps/host/src/main.ts"], {
  env: { ...process.env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_WEB_DIR: "apps/web/dist", WORKBENCH_HOST_LABEL: "노트북" },
  stdio: ["ignore", "pipe", "inherit"],
});
const ready = await new Promise<{ url: string; token: string }>((resolve) => {
  createInterface({ input: child.stdout! }).on("line", (line) => {
    if (line.startsWith("WORKBENCH_READY ")) resolve(JSON.parse(line.slice(16)));
  });
});

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${ready.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${json.message}`);
  return json;
}

const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
};

const work = await api<{ id: string }>("POST", "/api/works", { title: "디자인 확인", folderId: null, cwd });
const design = await api<{ id: string; revision: number; name: string }>("POST", `/api/works/${work.id}/designs`, { name: "포스터", preset: "portrait" });
check("새 디자인 파일", design.name === "포스터.design.json" && design.revision === 1, design.name);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const logs: string[] = [];
page.on("console", (message) => logs.push(`[${message.type()}] ${message.text()}`));
page.on("pageerror", (error) => logs.push(`[pageerror] ${error.message}`));
page.on("response", (response) => {
  if (response.status() >= 400) logs.push(`[http ${response.status()}] ${response.request().method()} ${response.url()}`);
});

/** A same-origin parent that answers the design page like the Workbench window does. */
async function host(p: Page) {
  await p.goto(`${ready.url}/fonts/sametone/README.txt`);
  await p.setContent(`<!doctype html><html><body style="margin:0">
    <iframe id="editor" style="border:0;width:100vw;height:100vh"></iframe>
    <iframe id="render" src="/design/?mode=render" style="display:none"></iframe>
    <script>
      window.messages = [];
      window.addEventListener("message", (event) => {
        window.messages.push(event.data);
        if (event.data.type === "design:ready") event.source.postMessage(window.init, location.origin);
        if (event.data.type === "render:ready") event.source.postMessage({ type: "render:init", token: window.init.token }, location.origin);
      });
    </script></body></html>`);
}

async function open(p: Page, revision: number | null, readOnly = false): Promise<Frame> {
  await p.evaluate(
    ([token, artifactId, rev, ro]) => {
      (window as unknown as { init: unknown }).init = { type: "design:init", token, artifactId, revision: rev, readOnly: ro, theme: "light" };
      (document.getElementById("editor") as HTMLIFrameElement).src = `/design/?t=${Date.now()}`;
    },
    [ready.token, design.id, revision, readOnly] as const,
  );
  await p.waitForFunction(() => (window as unknown as { messages: { type: string }[] }).messages.some((m) => m.type === "design:opened" || m.type === "design:error"), null, { timeout: 60_000 });
  const frame = p.frames().find((f) => f.url().includes("/design/?t="))!;
  return frame;
}

const messages = (p: Page) => p.evaluate(() => (window as unknown as { messages: { type: string; [key: string]: unknown }[] }).messages);

try {
  await host(page);
  const frame = await open(page, null);
  const opened = (await messages(page)).find((m) => m.type === "design:opened" || m.type === "design:error");
  check("편집기 열림", opened?.type === "design:opened", JSON.stringify(opened));
  await frame.waitForSelector("canvas", { timeout: 30_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(outDir, "01-open.png") });
  await frame.getByRole("button", { name: "글자", exact: true }).first().click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(outDir, "02-text-panel.png") });

  // An edit in the editor is autosaved as the next revision of the file.
  await frame.getByRole("button", { name: /제목 추가/ }).first().click();
  await page.waitForFunction(() => (window as unknown as { messages: { type: string }[] }).messages.some((m) => m.type === "design:saved"), null, { timeout: 20_000 });
  const afterEdit = await api<{ artifact: { revision: number }; text: string }>("GET", `/api/artifacts/${design.id}/text`);
  const saved = JSON.parse(afterEdit.text) as { pages: { objects: { type: string; text?: string }[] }[] };
  const heading = saved.pages[0].objects.find((object) => typeof object.text === "string");
  check("편집이 r2로 저장", afterEdit.artifact.revision === 2 && Boolean(heading), `r${afterEdit.artifact.revision} ${heading?.type} "${heading?.text}"`);
  writeFileSync(join(outDir, "saved.design.json"), afterEdit.text);
  await page.screenshot({ path: join(outDir, "03-heading.png") });

  // Thumbnails: the hidden render page draws a revision with the editor's engine.
  const rendered = await page.evaluate(
    ([artifactId, documentText]) =>
      new Promise<{ dataUrl: string | null; pages: number; error?: string }>((resolve) => {
        const id = "thumb-1";
        window.addEventListener("message", (event) => {
          if (event.data.type === "render:result" && event.data.id === id) resolve(event.data);
        });
        (document.getElementById("render") as HTMLIFrameElement).contentWindow!.postMessage(
          { type: "render:request", id, artifactId, document: documentText, page: 0, width: 360 },
          location.origin,
        );
      }),
    [design.id, afterEdit.text] as const,
  );
  check("썸네일 렌더", Boolean(rendered.dataUrl?.startsWith("data:image/")), rendered.error ?? `${rendered.dataUrl?.length} bytes, ${rendered.pages}쪽`);
  if (rendered.dataUrl) writeFileSync(join(outDir, "04-thumb.jpg"), Buffer.from(rendered.dataUrl.split(",")[1], "base64"));

  // Someone else writes r3 while the editor still holds r2: the next autosave is refused.
  const other = JSON.parse(afterEdit.text) as { pages: { background: unknown }[] };
  other.pages[0].background = { type: "solid", color: "#ffe1e6" };
  await api("PUT", `/api/artifacts/${design.id}/text`, { expectedRevision: 2, text: JSON.stringify(other, null, 2) });
  await frame.getByRole("button", { name: /부제목 추가/ }).first().click();
  await page.waitForFunction(() => (window as unknown as { messages: { type: string; state?: string }[] }).messages.some((m) => m.type === "design:state" && m.state === "conflict"), null, { timeout: 20_000 });
  const afterConflict = await api<{ artifact: { revision: number }; text: string }>("GET", `/api/artifacts/${design.id}/text`);
  check("충돌 시 덮어쓰지 않음", afterConflict.artifact.revision === 3 && afterConflict.text.includes("#ffe1e6"), `r${afterConflict.artifact.revision}`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(outDir, "05-conflict.png") });
} finally {
  writeFileSync(join(outDir, "console.log"), logs.join("\n"));
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
  await browser.close();
  child.kill();
}
