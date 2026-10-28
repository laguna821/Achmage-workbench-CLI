/// <reference lib="dom" />
// Screen check of Word/PowerPoint/Excel documents (rendered by IeumOffice) in the real UI.
// Needs IeumOffice installed (connection screen → 이음오피스 설치). Usage: node scripts/office-ui-check.ts [outDir]

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { chromium } from "playwright-core";
import { findIeumCli } from "../apps/host/src/ieumoffice.ts";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-office-ui");
mkdirSync(outDir, { recursive: true });
const cli = findIeumCli();
if (!cli) throw new Error("IeumOffice is not installed");
const dataDir = mkdtempSync(join(tmpdir(), "workbench-office-ui-"));
const cwd = mkdtempSync(join(tmpdir(), "workbench-office-cwd-"));
const ieum = (...args: string[]) => execFileSync(cli, [...args, "--json"], { cwd, env: { ...process.env, GENOFFICE_AUDIT_LOG: "off" } });

writeFileSync(join(cwd, "강의 계획.md"), "# 가을 특강 계획\n\n질문에서 시작하는 글쓰기\n\n## 일정\n\n- 10월 28일 (화) 오후 3시\n- 미디어스쿨 302호\n\n| 주차 | 내용 |\n|---|---|\n| 1 | 질문 만들기 |\n| 2 | 자료 읽기 |\n");
ieum("convert", "강의 계획.md", "--to", "docx");
writeFileSync(
  join(cwd, "ops.json"),
  JSON.stringify([
    { op: "addElement", target: { slide: 0 }, kind: "textbox", offset: { x: 914400, y: 1600000, cx: 10363200, cy: 1371600 }, paragraphs: [{ runs: [{ text: "가을 특강", bold: true, fontSize: 54 }], align: "center" }] },
    { op: "addElement", target: { slide: 0 }, kind: "textbox", offset: { x: 914400, y: 3300000, cx: 10363200, cy: 914400 }, paragraphs: [{ runs: [{ text: "질문에서 시작하는 글쓰기", fontSize: 28 }], align: "center" }] },
  ]),
);
ieum("create", "--type", "pptx", "--ops", "ops.json", "--out", "특강 표지.pptx");
writeFileSync(join(cwd, "비품.csv"), "항목,수량,단가,합계\n노트,3,1200,3600\n펜,10,500,5000\n");
ieum("convert", "비품.csv", "--to", "xlsx");

const child = spawn(process.execPath, ["apps/host/src/main.ts"], {
  env: { ...process.env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_WEB_DIR: "apps/web/dist", WORKBENCH_HOST_LABEL: "노트북" },
  stdio: ["ignore", "pipe", "inherit"],
});
const ready = await new Promise<{ url: string; token: string }>((resolve) => {
  createInterface({ input: child.stdout! }).on("line", (line) => {
    if (line.startsWith("WORKBENCH_READY ")) resolve(JSON.parse(line.slice(16)));
  });
});
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${ready.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(`${method} ${path}: ${json.message}`);
  return json;
};

const work = await api<{ id: string }>("POST", "/api/works", { title: "가을 특강 준비", folderId: null, cwd });
for (const name of ["강의 계획.docx", "특강 표지.pptx", "비품.xlsx"]) await api("POST", `/api/works/${work.id}/artifacts`, { path: name });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.addInitScript((id) => localStorage.setItem("workbench.lastWork", id), work.id);
await page.goto(`${ready.url}/?token=${ready.token}`);
await page.waitForSelector(".docs-button");

const open = async (name: string, shot: string) => {
  await page.locator(".docs-button").click();
  await page.locator(".docs-menu").getByText(name, { exact: true }).click();
  await page.waitForSelector(".office-page img", { timeout: 60_000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(outDir, shot) });
};
await open("강의 계획.docx", "01-docx-pages.png");
await page.getByRole("radio", { name: "글 보기" }).click();
await page.waitForSelector(".office-text .markdown", { timeout: 30_000 });
await page.screenshot({ path: join(outDir, "02-docx-text.png") });
await page.locator(".doc-header .ghost-button").first().click();
await open("특강 표지.pptx", "03-pptx-pages.png");
await page.locator(".doc-header .ghost-button").first().click();
await open("비품.xlsx", "04-xlsx-pages.png");
await page.locator(".doc-header .ghost-button").first().click();
await page.locator(".topbar-right button[aria-label='더 보기'], .topbar-right .icon-button").last().click().catch(() => undefined);
await page.waitForTimeout(600);
await page.screenshot({ path: join(outDir, "05-menu.png") });
writeFileSync(join(outDir, "errors.log"), errors.join("\n"));
console.log(errors.length ? `page errors: ${errors.join(" / ")}` : "no page errors");
await browser.close();
child.kill();
