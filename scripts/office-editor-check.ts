/// <reference lib="dom" />
// Browser check of the in-app Word editor (IeumOffice's editor built into Workbench, apps/office)
// in the real Workbench UI against a real gateway: open a .docx, edit and save revisions (Ctrl+S,
// leaving the tab, switching the view), open a revision made elsewhere, resolve a conflict by
// keeping my edits, keep unsaved edits across a visit and drop them on request, AI hidden.
// Needs no IeumOffice install: the documents are made and read with Python's zipfile.
// Usage: node scripts/office-editor-check.ts [outDir]

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Page } from "playwright-core";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-office-editor");
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-office-editor-"));
const cwd = mkdtempSync(join(tmpdir(), "workbench-office-editor-cwd-"));
const scratch = mkdtempSync(join(tmpdir(), "workbench-office-editor-tmp-"));
const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
};

// Minimal .docx files: make one, read its paragraphs, add a paragraph (an edit made "elsewhere").
const DOCX_PY = String.raw`
import sys, zipfile, re
from xml.sax.saxutils import escape
W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
para = lambda text: '<w:p><w:r><w:t xml:space="preserve">%s</w:t></w:r></w:p>' % escape(text)
cmd = sys.argv[1]
if cmd == 'make':
    out, texts = sys.argv[2], sys.argv[3:]
    ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
    rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
    doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document %s><w:body>%s<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>' % (W, ''.join(para(t) for t in texts))
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', ct)
        z.writestr('_rels/.rels', rels)
        z.writestr('word/document.xml', doc)
elif cmd == 'read':
    with zipfile.ZipFile(sys.argv[2]) as z:
        xml = z.read('word/document.xml').decode('utf-8')
    paras = re.findall(r'<w:p[ >].*?</w:p>', xml, re.S)
    print('\n'.join(''.join(re.findall(r'<w:t(?: [^>]*)?>([^<]*)</w:t>', p)) for p in paras))
elif cmd == 'append':
    src, out, text = sys.argv[2:5]
    with zipfile.ZipFile(src) as z:
        items = [(info, z.read(info.filename)) for info in z.infolist()]
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as w:
        for info, data in items:
            if info.filename == 'word/document.xml':
                xml = data.decode('utf-8')
                at = xml.rfind('<w:sectPr')
                at = at if at >= 0 else xml.rfind('</w:body>')
                data = (xml[:at] + para(text) + xml[at:]).encode('utf-8')
            w.writestr(info, data)
`;
const docx = (...args: string[]) => execFileSync("python3", ["-I", "-c", DOCX_PY, ...args]).toString();

docx("make", join(cwd, "계획.docx"), "가을 특강 계획", "질문에서 시작하는 글쓰기", "10월 28일 오후 3시");

const child = spawn(process.execPath, ["apps/host/src/main.ts"], {
  env: { ...process.env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_WEB_DIR: "apps/web/dist", WORKBENCH_HOST_LABEL: "노트북" },
  stdio: ["ignore", "pipe", "inherit"],
});
const ready = await new Promise<{ url: string; token: string }>((resolve) => {
  createInterface({ input: child.stdout! }).on("line", (line) => {
    if (line.startsWith("WORKBENCH_READY ")) resolve(JSON.parse(line.slice(16)));
  });
});
const auth = { authorization: `Bearer ${ready.token}` };
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${ready.url}${path}`, { method, headers: { ...auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(`${method} ${path}: ${json.message}`);
  return json;
};

await api("PUT", "/api/prefs", { prefs: { onboarding: "done" } });
const work = await api<{ id: string }>("POST", "/api/works", { title: "워드 편집", folderId: null, cwd });
const artifact = await api<{ id: string; name: string; path: string; revision: number }>("POST", `/api/works/${work.id}/artifacts`, { path: "계획.docx" });
const revisions = () => api<{ revision: number }[]>("GET", `/api/artifacts/${artifact.id}/revisions`);
/** The paragraphs of one revision, as stored by the gateway. */
async function textOf(revision: number) {
  const bytes = Buffer.from(await (await fetch(`${ready.url}/api/artifacts/${artifact.id}/raw?revision=${revision}`, { headers: auth })).arrayBuffer());
  const file = join(scratch, `r${revision}.docx`);
  writeFileSync(file, bytes);
  return docx("read", file);
}
/** Someone else makes the next revision: the latest one plus a paragraph. */
async function editElsewhere(text: string) {
  const latest = (await revisions()).at(-1)!.revision;
  await textOf(latest);
  const out = join(scratch, `elsewhere-${latest}.docx`);
  docx("append", join(scratch, `r${latest}.docx`), out, text);
  const response = await fetch(`${ready.url}/api/artifacts/${artifact.id}/bytes?expectedRevision=${latest}`, { method: "PUT", headers: auth, body: readFileSync(out) });
  if (!response.ok) throw new Error(`edit elsewhere: ${response.status}`);
  return ((await response.json()) as { revision: number }).revision;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
const logs: string[] = [];
page.on("console", (message) => {
  if (message.type() === "error" || message.text().startsWith("[workbench office]")) logs.push(`[${message.type()}] ${message.text().slice(0, 200)}`);
});
page.on("pageerror", (error) => logs.push(`[pageerror] ${error.message.slice(0, 200)}`));

const editor = (p: Page) => p.frameLocator("iframe.office-frame").locator(".ProseMirror");
const status = (p: Page) => p.locator(".save-state").innerText();
const waitStatus = (p: Page, text: string, timeout = 20_000) =>
  p.waitForFunction((t) => document.querySelector(".save-state")?.textContent?.includes(t) ?? false, text, { timeout });
/** The editor page is on another origin: read it through Playwright's frame, not the parent's DOM. */
async function waitEditorText(p: Page, text: string, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const frame = p.frames().find((candidate) => candidate.url().includes("/office/docs.html"));
    const content = frame ? await frame.locator(".ProseMirror").first().textContent({ timeout: 1000 }).catch(() => null) : null;
    if (content?.includes(text)) return;
    if (Date.now() > deadline) throw new Error(`editor does not show "${text}"`);
    await p.waitForTimeout(250);
  }
}
/** Type at the end of the first paragraph. */
async function typeAtStart(p: Page, text: string) {
  await editor(p).locator("p").first().click();
  await p.keyboard.press("End");
  await p.keyboard.type(text);
}

try {
  await page.addInitScript((id) => localStorage.setItem("workbench.lastWork", id), work.id);
  await page.goto(`${ready.url}/?token=${ready.token}`);
  await page.waitForSelector(".docs-button");
  await page.locator(".docs-button").click();
  await page.locator(".docs-menu").getByText("계획.docx", { exact: true }).click();
  await editor(page).waitFor({ timeout: 60_000 });
  await waitEditorText(page, "질문에서 시작하는 글쓰기");
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(outDir, "01-open.png") });
  check("문서 화면 안에서 워드 편집기로 열림", (await status(page)).includes("r1 저장됨"), await status(page));

  // The editor runs on its own origin with a token for this document only.
  const frameUrl = new URL(page.frames().find((candidate) => candidate.url().includes("/office/docs.html"))!.url());
  const grant = await api<{ token: string; origin: string }>("POST", `/api/artifacts/${artifact.id}/editor`);
  docx("make", join(cwd, "다른 문서.docx"), "다른 문서");
  const other = await api<{ id: string }>("POST", `/api/works/${work.id}/artifacts`, { path: "다른 문서.docx" });
  const statusOf = async (url: string, token: string) => (await fetch(url, { headers: { authorization: `Bearer ${token}` } })).status;
  const isolation = {
    ownOrigin: frameUrl.origin === grant.origin && frameUrl.origin !== new URL(ready.url).origin,
    notOnApp: (await fetch(`${ready.url}/office/docs.html`)).status === 404,
    ownDoc: await statusOf(`${grant.origin}/api/artifacts/${artifact.id}/raw`, grant.token),
    otherDoc: await statusOf(`${grant.origin}/api/artifacts/${other.id}/raw`, grant.token),
    appApi: await statusOf(`${ready.url}/api/snapshot`, grant.token),
    editorsApi: await statusOf(`${grant.origin}/api/snapshot`, grant.token),
  };
  check(
    "편집기는 다른 출처·이 문서 전용 토큰으로만 동작",
    isolation.ownOrigin && isolation.notOnApp && isolation.ownDoc === 200 && isolation.otherDoc === 401 && isolation.appApi === 401 && isolation.editorsApi === 404,
    JSON.stringify(isolation),
  );

  // AI stays in Workbench's conversation: none of the editor's AI entry points are visible.
  const visibleAi = await page.frameLocator("iframe.office-frame").locator("body").evaluate(() => {
    const shown = (el: Element) => el.getClientRects().length > 0;
    return Array.from(document.querySelectorAll(".rb-big.ai-entry, .rb-big .ai-feature-icon, .ai-dock")).filter(shown).length;
  });
  const reviewTab = page.frameLocator("iframe.office-frame").getByText("검토", { exact: true }).first();
  let visibleAiReview = -1;
  if (await reviewTab.count()) {
    await reviewTab.click();
    await page.waitForTimeout(400);
    visibleAiReview = await page.frameLocator("iframe.office-frame").locator("body").evaluate(() =>
      Array.from(document.querySelectorAll(".rb-big .ai-feature-icon, .rb-big.ai-entry")).filter((el) => el.getClientRects().length > 0).length,
    );
    await page.screenshot({ path: join(outDir, "02-review-tab.png") });
    await page.frameLocator("iframe.office-frame").getByText("홈", { exact: true }).first().click();
  }
  check("편집기 자체 AI 버튼 숨김(홈·검토 탭)", visibleAi === 0 && visibleAiReview <= 0, `home=${visibleAi} review=${visibleAiReview}`);

  // Ctrl+S → the next revision.
  await typeAtStart(page, " — 워크벤치에서 고침");
  await waitStatus(page, "저장 안 됨");
  await page.keyboard.press("Control+s");
  await waitStatus(page, "r2 저장됨");
  check("Ctrl+S → r2, 파일에 반영", (await textOf(2)).includes("워크벤치에서 고침"), (await textOf(2)).split("\n")[0]);
  await page.screenshot({ path: join(outDir, "03-saved.png") });

  // Leaving for the conversation tab saves first.
  await typeAtStart(page, " (탭 이동 전)");
  await page.waitForTimeout(300);
  await page.locator(".doc-tab.conversation").click();
  await page.waitForFunction(() => !document.querySelector("iframe.office-frame"), undefined, { timeout: 20_000 });
  const afterLeave = await revisions();
  check("대화 탭으로 옮기면 먼저 저장(r3)", afterLeave.length === 3 && (await textOf(3)).includes("(탭 이동 전)"), `revisions=${afterLeave.length}`);

  // Back to the document: it opens at r3.
  await page.locator(".doc-tab-open", { hasText: "계획.docx" }).click();
  await waitEditorText(page, "(탭 이동 전)");
  await waitStatus(page, "r3 저장됨");
  check("다시 열면 r3 내용", true);

  // A revision made elsewhere while I have unsaved edits: refused, then "keep my edits".
  await typeAtStart(page, " 또 고침");
  await waitStatus(page, "저장 안 됨");
  const r4 = await editElsewhere("밖에서 고침");
  await page.waitForSelector(".doc-conflict", { timeout: 20_000 });
  await page.screenshot({ path: join(outDir, "04-conflict.png") });
  check("편집 중 다른 곳에서 r4 → 충돌 안내", r4 === 4, (await page.locator(".doc-conflict").innerText()).replace(/\s+/g, " ").slice(0, 120));
  await page.getByRole("button", { name: "내 편집을 새 판으로" }).click();
  await waitStatus(page, "r5 저장됨");
  const r5 = await textOf(5);
  check("내 편집을 새 판으로 → r5(내 편집), r4는 기록에 남음", r5.includes("또 고침") && !r5.includes("밖에서 고침") && (await textOf(4)).includes("밖에서 고침"), r5.split("\n")[0]);

  // A revision made elsewhere with nothing unsaved here (an applied AI proposal): the editor shows it.
  await editElsewhere("밖에서 두 번째");
  await waitEditorText(page, "밖에서 두 번째");
  await waitStatus(page, "r6 저장됨");
  check("저장 안 된 편집이 없으면 새 판(r6)을 바로 보여 줌", (await page.locator(".doc-conflict").count()) === 0);

  // Unsaved edits that cannot be saved (a conflict) are kept when leaving, and come back on the next visit.
  await typeAtStart(page, " 남겨 둘 편집");
  await waitStatus(page, "저장 안 됨");
  await editElsewhere("밖에서 세 번째");
  await page.waitForSelector(".doc-conflict", { timeout: 20_000 });
  await page.locator(".doc-tab.conversation").click();
  await page.waitForFunction(() => !document.querySelector("iframe.office-frame"), undefined, { timeout: 20_000 });
  await page.locator(".doc-tab-open", { hasText: "계획.docx" }).click();
  await waitEditorText(page, "남겨 둘 편집");
  await page.waitForSelector(".doc-conflict", { timeout: 20_000 });
  const keptNotice = (await page.locator(".doc-conflict").innerText()).replace(/\s+/g, " ");
  await page.screenshot({ path: join(outDir, "05-kept.png") });
  check("충돌 중 떠난 편집은 다음에 되살아남(r6 기준, 지금 r7)", keptNotice.includes("r6") && keptNotice.includes("r7"), keptNotice.slice(0, 120));

  // "Open the latest revision" drops them (after a second click).
  await page.getByRole("button", { name: "최신 판 열기" }).click();
  await page.getByRole("button", { name: "버리고 열기" }).click();
  await waitEditorText(page, "밖에서 세 번째");
  await waitStatus(page, "r7 저장됨");
  const dropped = !(await editor(page).innerText()).includes("남겨 둘 편집");
  check("최신 판 열기 → 내 편집 버리고 r7", dropped && (await revisions()).length === 7);

  // Switching the view saves first, too.
  await typeAtStart(page, " 보기 전");
  await page.waitForTimeout(300);
  await page.getByRole("radio", { name: "글 보기" }).click();
  await page.waitForFunction(() => !document.querySelector("iframe.office-frame"), undefined, { timeout: 20_000 });
  check("글 보기로 바꾸면 먼저 저장(r8)", (await revisions()).length === 8 && (await textOf(8)).includes("보기 전"));
  await page.getByRole("radio", { name: "편집" }).click();
  await waitEditorText(page, "보기 전");
  await page.screenshot({ path: join(outDir, "06-back-to-edit.png") });
} catch (error) {
  check("실행", false, error instanceof Error ? error.message.split("\n")[0] : String(error));
  await page.screenshot({ path: join(outDir, "99-failure.png") }).catch(() => undefined);
} finally {
  writeFileSync(join(outDir, "console.log"), logs.join("\n"));
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
  await browser.close();
  child.kill();
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} passed · console: ${logs.length ? logs.slice(0, 6).join(" | ") : "clean"}`);
  process.exitCode = failed ? 1 : 0;
}
