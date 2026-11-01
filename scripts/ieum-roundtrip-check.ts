// Actual official Ieum GUI save through Workbench's external-open API. Only use on a
// disposable/isolated account; documents and evidence belong to this acceptance run.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { _electron, type ElectronApplication, type Page } from "playwright-core";
import type { Artifact, Session, Snapshot, TranscriptItem, Work } from "@workbench/contracts";
import { client, startGateway, type Gateway } from "./setup-smoke.ts";

const app = resolve(process.argv[2]!), output = resolve(process.argv[3]!);
if (process.env.WORKBENCH_IEUM_ACCEPTANCE !== "1") throw new Error("Use only an isolated test account with WORKBENCH_IEUM_ACCEPTANCE=1");
mkdirSync(output, { recursive: true });
const dataDir = process.env.WORKBENCH_DATA_DIR ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "achmage-workbench");
const checks: { step: string; ok: boolean; detail?: string }[] = [];
const check = (step: string, ok: boolean, detail?: string) => { checks.push({ step, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`); };
const until = async (predicate: () => Promise<boolean>, timeout = 30_000) => {
  const end = Date.now() + timeout;
  do { if (await predicate()) return true; await new Promise(resolve => setTimeout(resolve, 300)); } while (Date.now() < end);
  return false;
};
let gateway: Gateway | null = null, office: ElectronApplication | null = null;
try {
  gateway = await startGateway(app, { WORKBENCH_IEUM_BOOTSTRAP: "0", WORKBENCH_SHELL_PATH: "0", WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"), WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs") }, dataDir);
  const { call } = client(gateway), snapshot = () => call<Snapshot>("GET", "/api/snapshot");
  const linked = (await snapshot()).tools?.ieumApp;
  if (!linked?.path || !linked.available || !linked.registered) throw new Error("Run automatic standalone setup acceptance first");
  const work = await call<Work>("POST", "/api/works", { title: `실제 이음 왕복 ${Date.now()}`, cwd: null });
  const main = await call<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "codex", purpose: "외부 편집 후 메인 맥락" });
  const other = await call<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "claude", purpose: "같은 프로젝트의 다른 채팅" });
  const artifact = await call<Artifact>("POST", `/api/works/${work.id}/office-documents`, { format: "docx", name: "외부 앱 왕복 문서", sessionId: main.id });
  const child = await call<Session>("POST", `/api/artifacts/${artifact.id}/document-session`, { parentSessionId: main.id });
  const before = createHash("sha256").update(readFileSync(artifact.path)).digest("hex");
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  for (const key of ["ELECTRON_RUN_AS_NODE", "GENOFFICE_USER_DATA", "GENOFFICE_AI_SETTINGS", "WAYLAND_DISPLAY"]) delete env[key];
  // The normal profile belongs to the isolated account. The later Workbench launch must
  // reach this same instance through the official app's ordinary single-instance routing.
  office = await _electron.launch({ executablePath: linked.path, args: ["--no-sandbox", "--disable-dev-shm-usage", ...(process.platform === "linux" ? ["--ozone-platform=x11"] : [])], env, timeout: 60_000 });
  const shell = await office.firstWindow({ timeout: 60_000 });
  await shell.waitForFunction(() => (document.body?.innerText.length ?? 0) > 30);
  const skip = shell.getByRole("button", { name: /^(Skip|건너뛰기)$/ });
  if (await skip.isVisible()) await skip.click();
  const opened = await call<{ app: string }>("POST", `/api/artifacts/${artifact.id}/open-external`, { target: "ieum" });
  let editor: Page | undefined;
  const editorReady = await until(async () => {
    for (const page of office!.context().pages()) if (await page.locator('.tiptap[contenteditable="true"]').count()) { editor = page; return true; }
    return false;
  }, 45_000);
  writeFileSync(join(output, "external-pages.json"), JSON.stringify(await Promise.all(office.context().pages().map(async page => ({ url: page.url(), title: await page.title(), text: (await page.locator("body").innerText()).slice(0, 5000) }))), null, 2));
  check("앱으로 열기가 공식 이음의 실제 Word 편집기를 엶", opened.app === "이음오피스" && editorReady, artifact.path);
  if (!editor) throw new Error("Official Word editor did not open");
  const marker = `외부 이음에서 저장한 확인 문장 ${randomUUID()}`;
  const body = editor.locator('.tiptap[contenteditable="true"]').first();
  await body.fill(marker);
  await editor.keyboard.press(process.platform === "darwin" ? "Meta+s" : "Control+s");
  await editor.screenshot({ path: join(output, "external-word-saved.png") });
  const changed = await until(async () => (await snapshot()).artifacts.some(row => row.id === artifact.id && row.revision > artifact.revision), 30_000);
  const current = (await snapshot()).artifacts.find(row => row.id === artifact.id)!;
  const text = await call<{ text: string }>("GET", `/api/artifacts/${artifact.id}/text`);
  check("실제 GUI 저장을 같은 파일의 새 판으로 자동 수집", changed && current.path === artifact.path && createHash("sha256").update(readFileSync(artifact.path)).digest("hex") !== before && text.text.includes(marker), `r${artifact.revision} → r${current.revision}`);
  await office.close(); office = null;
  const items = async (id: string) => (await call<{ items: TranscriptItem[] }>("GET", `/api/sessions/${id}/items`)).items;
  const mainItems = await items(main.id), otherItems = await items(other.id);
  check("외부 저장 완료가 문서의 메인 채팅과 프로젝트 활성 채팅에 전달", mainItems.some(item => item.kind === "notice" && item.text.includes("이음오피스에서 저장")) && otherItems.some(item => item.kind === "notice" && item.text.includes("이음오피스에서 저장")));
  check("문서 AI 대화는 두 메인 채팅과 별도 ID 유지", child.id !== main.id && child.id !== other.id && child.documentAgent?.parentSessionId === main.id);
  writeFileSync(join(output, "roundtrip.json"), JSON.stringify({ work, main, other, child, original: artifact, current, marker, text, mainItems, otherItems }, null, 2));
} catch (error) {
  check("실제 외부 편집 왕복 완료", false, String(error));
  if (office) for (const [index, page] of office.context().pages().entries()) await page.screenshot({ path: join(output, `failure-${index}.png`) }).catch(() => {});
  console.error(error);
} finally {
  await office?.close(); await gateway?.stop();
  writeFileSync(join(output, "roundtrip-results.json"), JSON.stringify(checks, null, 2));
  process.exitCode = checks.every(row => row.ok) ? 0 : 1;
}
