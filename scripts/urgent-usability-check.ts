/// <reference lib="dom" />
// The built web UI + real host + native Fast Find worker, using disposable synthetic records.
// Usage: WORKBENCH_SEARCH_WORKER_BIN=... BROWSER_BIN=... node scripts/urgent-usability-check.ts <evidence>
// Build web + design + office + host first; all profiles, sessions and vault notes are synthetic.
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { chromium, type Browser, type Page } from "playwright-core";
import { Store } from "../apps/host/src/store.ts";
import type { Work, Session } from "@workbench/contracts";
import { put } from "../apps/host/src/vault-fixture.ts";

const out = resolve(process.argv[2]!); mkdirSync(out, { recursive: true });
const dir = mkdtempSync(join(tmpdir(), "wb-fast-find-ui-")), vault = join(dir, "vault");
// Optional fixed synthetic corpus from fast-find-bench. Copy it into this check's private
// fixture so external edit/rename checks never modify the benchmark's originals.
if (process.argv[3]) cpSync(resolve(process.argv[3]), vault, { recursive: true });
const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail?: string) => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); };
const store = new Store(join(dir, "state.sqlite"));
const now = Date.now();
const work: Work = { id: "w-fast-find", title: "검색 검사 프로젝트", titleSource: "user", folderId: null,
  cwd: join(dir, "works"), cwdManaged: false, activeSessionId: "s-fast-find", pinned: false, sort: 0,
  archivedAt: null, createdAt: now, updatedAt: now };
mkdirSync(work.cwd, { recursive: true }); store.saveWork(work);
const session: Session = { id: "s-fast-find", workId: work.id, provider: "codex", hostId: "fixture", nativeSessionId: null,
  purpose: "일반 대화", purposeSource: "user", model: null, effort: null, engineModel: null, engineEffort: null,
  preview: "별빛해설의 첫 번째 답입니다.", previewAt: now - 2000, status: "idle", activity: null, lastError: null,
  pinned: false, sort: 0, archivedAt: null, seenAt: now, unread: false, queued: [], access: null, context: null,
  createdAt: now - 5000, updatedAt: now };
store.saveSession(session);
store.saveItem(session.id, { kind: "user", id: "exact-request", text: "별빛해설을 정리해 줘", at: now - 3000 });
store.saveItem(session.id, { kind: "assistant", id: "exact-answer", text: "별빛해설의 첫 번째 답입니다.", streaming: false, at: now - 2000 });
store.saveItem(session.id, { kind: "turnEnd", id: "end", status: "completed", durationMs: 1000, at: now - 1000 });
const original = '---\ntitle: 가을 연구 메모\naliases: [발표자료]\n"단계:": A\ntags: [연구]\n---\n# 연구 배경\n\n' + Array.from({ length: 80 }, (_, i) => `문단 ${i + 1}의 일반 배경입니다.\n\n`).join("") + '## 📝 해바라기 분석\n\n나비정원 검토를 끝냈습니다.\n';
put(vault, ".obsidian/app.json", "{}");
put(vault, ".obsidian/plugins/notebook-navigator/data.json", JSON.stringify({ vaultProfile: "default", vaultProfiles: [{ id: "default", hiddenFolders: ["비밀"] }] }));
put(vault, "연구/가을.md", original + "\n[[겨울]]\n");
put(vault, "연구/겨울.md", "# 겨울 노트\n겨울고유문장\n[[가을]]\n");
put(vault, "01. Inbox/대기.md", "# 받은 메모\n받은메모고유문장");
put(vault, "연구/가을 사본.md", '---\ntitle: 가을 연구 메모\n"단계:": B\n---\n봄 노트 사본');
put(vault, "비밀/숨김.md", '---\ntitle: 가을 연구 메모\n---\n숨김고유표식');
store.setMeta("pkm.vault", vault);
store.setMeta("ui.prefs", JSON.stringify({ onboarding: "done", startScreen: "last" }));
store.close();

let child: ChildProcess | null = null, browser: Browser | null = null, page: Page | null = null;
const errors: string[] = [], requests: string[] = [];
try {
  child = spawn(process.execPath, ["apps/host/dist/host.mjs"], { env: { ...process.env, WORKBENCH_DATA_DIR: dir,
    WORKBENCH_HOST_ID: "fixture", WORKBENCH_IEUM_BOOTSTRAP: "0",
    WORKBENCH_WEB_DIR: resolve("apps/web/dist"), WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"),
    WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"), WORKBENCH_VAULT_SUGGEST: "" }, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr!.on("data", data => writeFileSync(join(out, "host.log"), data, { flag: "a" }));
  const ready = await new Promise<{ url: string; token: string }>((done, fail) => {
    const timeout = setTimeout(() => fail(Error("gateway start timeout")), 30_000);
    child!.once("exit", code => { clearTimeout(timeout); fail(Error(`gateway exited: ${code}`)); });
    createInterface({ input: child!.stdout! }).on("line", line => { if (line.startsWith("WORKBENCH_READY ")) { clearTimeout(timeout); done(JSON.parse(line.slice(16))); } });
  });
  const api = async (path: string, method = "GET", body?: unknown) => { const r = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); if (!r.ok) throw Error(`${path}: ${r.status}`); return r.json(); };
  browser = await chromium.launch({ ...(process.env.BROWSER_BIN ? { executablePath: process.env.BROWSER_BIN } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", async response => { if (response.status() >= 400 && response.url().includes('/api/')) console.log('HTTP', response.status(), new URL(response.url()).pathname, (await response.text()).slice(0, 500)); });
  page.on("request", request => { if (request.url().includes("/api/search")) requests.push(request.url().split("/api/")[1]!); });
  await page.goto(`${ready.url}/?token=${ready.token}`);
  await page.waitForSelector(".sidebar", { timeout: 30_000 });
  const palette = async (query: string) => {
    if (!(await page!.locator(".palette").count())) await page!.keyboard.press("Control+k");
    await page!.getByRole("textbox", { name: "찾을 말" }).fill(query);
    await page!.waitForFunction(q => document.querySelector<HTMLInputElement>('.palette-input input')?.value === q && document.querySelector<HTMLElement>(".search-summary")?.dataset.searchQuery === q && document.querySelector('.palette-list')?.getAttribute('aria-busy') === 'false', query);
  };
  const until = async (what: () => Promise<boolean>, timeout = 20_000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await what()) return; await new Promise(done => setTimeout(done, 80)); }
    throw Error('condition timed out');
  };
  await palette('별빛해설');
  await page.locator('.palette-entry.kind-hit').first().click();
  const prompt = '긴급요청초롱 내가 입력한 프롬프트 원문입니다. Ctrl K에서 AI와 PDF를 찾아 ppt로 만들 계획을 길게 설명해줘';
  await page.locator('.composer-input:visible').fill(prompt);
  await page.getByRole('button', { name: '보내기', exact: true }).click();
  console.log('CHECKPOINT send clicked');
  await until(async () => (await api(`/api/sessions/${session.id}/items`)).items.some((item: any) => item.kind === 'user' && item.text === prompt));
  const submitted = (await api(`/api/sessions/${session.id}/items`)).items.find((item: any) => item.kind === 'user' && item.text === prompt);
  console.log('CHECKPOINT prompt persisted', submitted.id);
  await palette('긴급요청초롱');
  await until(async () => (await page!.locator('.palette-entry.kind-hit').allTextContents()).some(text => text.includes('긴급요청초롱')));
  const running = await api('/api/search?q=긴급요청초롱&legacy=0');
  check('composer-submitted prompt searchable while AI is running', running.groups.some((group: any) => group.hits.some((hit: any) => hit.kind === 'user' && hit.itemId === submitted.id)));
  await page.getByRole('textbox', { name: '찾을 말' }).press('Escape');
  await page.locator('.palette').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '새 문서 또는 세션 만들기' }).click();
  for (const label of ['새 워드 문서', '새 한글 문서', '새 디자인 (doory)', 'Claude 새 세션', 'Codex 새 세션']) check(`tab + exposes ${label}`, await page.getByRole('menuitem', { name: label, exact: true }).count() === 1);
  await page.getByRole('menuitem', { name: '새 Markdown 문서', exact: true }).click();
  check('new document defaults to the current project', await page.locator('.new-document-dialog select').first().inputValue() === work.id);
  await page.locator('.new-document-dialog input[placeholder]').fill('병렬 수작업');
  await page.getByRole('button', { name: '만들고 열기', exact: true }).click();
  await page.locator('.new-document-dialog').waitFor({ state: 'detached' });
  await until(async () => (await api('/api/snapshot')).artifacts.some((a: any) => a.name === '병렬 수작업.md'));
  check('manual creation adds a file without another main session', (await api('/api/snapshot')).sessions.filter((s: any) => !s.documentAgent).length === 1);
  await page.frameLocator('iframe[title^="Markdown 편집기"]').locator('[contenteditable="true"]').first().waitFor();
  await page.screenshot({ path: join(out, 'editor-new-menu.png') });
  await page.getByRole('button', { name: '새 문서 또는 세션 만들기' }).click();
  check('creation menu remains available inside the full-screen editor', await page.getByRole('menuitem', { name: '새 디자인 (doory)', exact: true }).isVisible());
  await page.getByRole('menuitem', { name: '새 디자인 (doory)', exact: true }).click();
  await page.locator('.new-document-dialog input[placeholder]').fill('손으로 만드는 디자인');
  await page.getByRole('button', { name: '만들고 열기', exact: true }).click();
  await page.locator('.new-document-dialog').waitFor({ state: 'detached' });
  await page.frameLocator('.design-frame:not(.office-frame)').locator('canvas').first().waitFor();
  const designState = await api('/api/snapshot');
  const documentMessages = await Promise.all(designState.sessions.filter((s: any) => s.documentAgent).map((s: any) => api(`/api/sessions/${s.id}/items`)));
  check('doory creation opens a real canvas with no AI request', designState.artifacts.some((a: any) => a.format === 'design' && a.name.includes('손으로')) && documentMessages.every((result: any) => !result.items.some((i: any) => i.kind === 'user')));
  await page.getByRole('button', { name: '새 문서 또는 세션 만들기' }).click();
  await page.getByRole('menuitem', { name: 'Codex 새 세션', exact: true }).click();
  await until(async () => (await api('/api/snapshot')).sessions.filter((s: any) => !s.documentAgent).length === 2);
  check('new session belongs to the existing project', (await api('/api/snapshot')).sessions.every((s: any) => s.workId === work.id));
  await page.locator('.sidebar').waitFor();
  const projectArea = page.locator('.list-pane,.side-tree-section').first();
  await projectArea.dispatchEvent('contextmenu', { button: 2, clientX: 150, clientY: 400 });
  check('blank project space opens app creation menu', await page.getByRole('menuitem', { name: '새 워드 문서', exact: true }).isVisible() && await page.getByRole('menuitem', { name: 'Claude 새 세션', exact: true }).isVisible());
  await page.keyboard.press('Escape');
  const reportedPrompt = '방금 이 앱을 새로 설치했는데 간단한 마크다운 문서를 하나 만들어봐 mermaid 그림이랑 테이블도 같이 포함해서';
  await page.locator('.composer-input:visible').fill(reportedPrompt);
  await page.getByRole('button', { name: '보내기', exact: true }).click();
  const newMain = (await api('/api/snapshot')).sessions.find((s: any) => !s.documentAgent && s.id !== session.id);
  await until(async () => (await api(`/api/sessions/${newMain.id}/items`)).items.some((i: any) => i.kind === 'user' && i.text === reportedPrompt));
  for (const query of ['마크다운 문서', 'mermaid', '테이블', reportedPrompt]) {
    await palette(query);
    await page.getByRole('textbox', { name: '찾을 말' }).focus();
    await until(async () => (await page!.locator('.palette-entry.kind-hit').allTextContents()).some(text => text.includes('내 요청')));
    const found = await api(`/api/search?q=${encodeURIComponent(query)}&legacy=0&per=20`);
    const own = found.groups.flatMap((g: any) => g.hits).find((h: any) => h.kind === 'user');
    const originalItems = own ? (await api(`/api/sessions/${own.sessionId}/items`)).items : [];
    check(`reported prompt searchable in Ctrl+K: ${query === reportedPrompt ? 'entire sentence' : query}`, originalItems.some((i: any) => i.id === own.itemId && i.text === reportedPrompt));
  }
  for (const query of ['긴급요청초롱', 'ppt로', 'K에서', 'AI와', prompt]) {
    await palette(query);
    const found = await api(`/api/search?q=${encodeURIComponent(query)}&legacy=0&per=20`);
    check(`submitted prompt found for ${query === prompt ? 'full original prompt' : query}`, found.groups.some((g: any) => g.hits.some((h: any) => h.kind === 'user' && h.itemId === submitted.id)));
  }
  await palette('나비정원');
  // Ctrl+click the note into the right pane, leaving the current session on the left.
  await page.keyboard.press('Alt+Enter');
  await page.locator('.vault-browser').waitFor();
  const left = page.locator('.pane:visible:not(:has(.vault-browser))');
  const leftTab = await left.getAttribute('data-tab');
  await page.locator('.vault-browser').getByRole('link', { name: '겨울', exact: true }).click();
  await page.locator('.vault-browser .pkm-note-body').getByText('겨울고유문장').waitFor();
  await page.getByRole('button', { name: '볼트 뒤로', exact: true }).click();
  await page.locator('.vault-browser .pkm-note-body').getByText('나비정원 검토를 끝냈습니다.').waitFor();
  await page.getByRole('button', { name: '볼트 앞으로', exact: true }).click();
  await page.locator('.vault-browser .pkm-note-body').getByText('겨울고유문장').waitFor();
  check('vault links and back/forward navigate within the right pane', await left.getAttribute('data-tab') === leftTab && await left.locator('.composer-input:visible').count() === 1);
  await page.locator('.vault-breadcrumbs').getByRole('button', { name: '연구', exact: true }).click();
  await page.locator('.vault-browser .pkm-cards').waitFor();
  check('folder breadcrumb opens a browsable folder', await page.locator('.vault-browser .pkm-card').count() >= 2);
  await page.getByRole('button', { name: '상위 폴더로 이동', exact: true }).click();
  await page.locator('.vault-subfolders').getByRole('button', { name: '01. Inbox', exact: true }).click();
  await page.locator('.vault-browser .pkm-card[data-card-id="01. Inbox/대기.md"]').click();
  await page.locator('.vault-browser .pkm-note-body').getByText('받은메모고유문장').waitFor();
  await page.keyboard.press('Alt+ArrowLeft');
  await page.locator('.vault-browser .pkm-cards').waitFor();
  await page.keyboard.press('Alt+ArrowRight');
  await page.locator('.vault-browser .pkm-note-body').getByText('받은메모고유문장').waitFor();
  await page.locator('.vault-browser').dispatchEvent('mouseup', { button: 3 });
  await page.locator('.vault-browser .pkm-cards').waitFor();
  await page.locator('.vault-browser').dispatchEvent('mouseup', { button: 4 });
  await page.locator('.vault-browser .pkm-note-body').getByText('받은메모고유문장').waitFor();
  check('keyboard and mouse back/forward work in vault pane', true);
  await page.screenshot({ path: join(out, 'vault-browsing.png') });
  check('vault source was not changed by browsing', readFileSync(join(vault, '연구/가을.md'), 'utf8') === original + '\n[[겨울]]\n');
  check('no browser exceptions', errors.length === 0, errors.join('; '));
} catch (error) {
  check('urgent usability scenario', false, String(error));
  await page?.screenshot({ path: join(out, 'failure.png') }).catch(() => undefined);
} finally {
  await browser?.close();
  if (child && child.exitCode === null) { const exited = new Promise<void>(done => child!.once('exit', () => done())); child.kill('SIGTERM'); await exited; }
  writeFileSync(join(out, 'results.json'), JSON.stringify({ dir, results, errors }, null, 2));
  console.log(`${results.filter(r => r.ok).length}/${results.length} passed`);
  if (results.some(r => !r.ok)) process.exitCode = 1;
}
