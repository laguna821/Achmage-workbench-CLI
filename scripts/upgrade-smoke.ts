// Run on a disposable Windows runner, around two real NSIS installations. Uses the installed
// gateways and their real default data directory; never synthesizes or edits database rows.
// Usage: node scripts/upgrade-smoke.ts seed|verify <installed app> <fixture root> <report folder>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { Artifact, Folder, ProjectPage, ProjectStage, Session, Snapshot, TranscriptItem, Work } from "@workbench/contracts";
import { appLayout, client, installStandIns, type Gateway, type Result } from "./setup-smoke.ts";
import legacyManifest from "../packaging/windows-legacy-v0.2.2.json" with { type: "json" };

const here = dirname(fileURLToPath(import.meta.url));
const legacyPaths = ["hop", "pdfcraft", "kordoc", "ieumoffice/IeumOffice.exe", "ieumoffice/resources/app.asar", "ieumoffice/resources/modules"];
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const fileBytes = (path: string): number => {
  const s = lstatSync(path);
  return s.isDirectory() ? readdirSync(path).reduce((sum, name) => sum + fileBytes(join(path, name)), 0) : s.size;
};
const pick = (value: object, keys: string[]) => Object.fromEntries(keys.map(key => [key, (value as Record<string, unknown>)[key]]));
const workFields = ["id", "title", "titleSource", "folderId", "cwd", "cwdManaged", "activeSessionId", "pinned", "sort", "archivedAt", "createdAt", "tags"];
const sessionFields = ["id", "workId", "provider", "hostId", "nativeSessionId", "purpose", "purposeSource", "model", "effort", "pinned", "sort", "archivedAt", "createdAt"];
const artifactFields = ["id", "workId", "path", "name", "format", "revision", "sha256", "size", "readBy", "role", "createdAt"];

type Baseline = {
  standIns: ReturnType<typeof installStandIns>;
  dataDir: string;
  origin: string;
  installedBytes: number;
  nativeSha256: string;
  legacyPaths: string[];
  work: Work;
  folders: Folder[];
  sessions: Session[];
  items: Record<string, TranscriptItem[]>;
  prefs: Record<string, unknown>;
  stages: ProjectStage[];
  artifacts: Artifact[];
  files: { path: string; sha256: string }[];
  userBundleFiles: { path: string; sha256: string }[];
  markdown: { id: string; original: string; saved: string };
  docxId: string;
};

async function until(test: () => Promise<boolean>, description: string) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await test()) return;
    await new Promise(done => setTimeout(done, 150));
  }
  throw new Error(`Timed out: ${description}`);
}

async function launch(app: string, fixture: Baseline["standIns"], out: string, phase: string): Promise<Gateway> {
  const layout = appLayout(app);
  assert.ok(existsSync(layout.host) && existsSync(layout.native), "Installed host and native executable exist");
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("WORKBENCH_") || key === "GH_TOKEN" || key === "GITHUB_TOKEN" || key === "XDG_DATA_HOME") delete env[key];
  Object.assign(env, fixture.env, { WORKBENCH_WEB_DIR: layout.web, WORKBENCH_RESOURCES_DIR: app,
    WORKBENCH_APP_BIN: layout.native, WORKBENCH_EXIT_ON_STDIN_CLOSE: "1", WORKBENCH_HOST_LABEL: "업그레이드 확인" });
  // Deliberately no WORKBENCH_DATA_DIR/PORT: exercise the installed app's defaults and saved ports.
  const child = spawn(layout.node, [layout.host], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  child.stderr.on("data", data => appendFileSync(join(out, `${phase}-stderr.log`), data));
  const ready = await new Promise<{ url: string; token: string; dataDir: string }>((done, fail) => {
    const timer = setTimeout(() => fail(new Error("Installed gateway did not become ready")), 60_000);
    const reject = (error: Error) => { clearTimeout(timer); fail(error); };
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`Installed gateway exited before ready: ${code}`)));
    createInterface({ input: child.stdout }).on("line", line => {
      if (line.startsWith("WORKBENCH_READY ")) { clearTimeout(timer); done(JSON.parse(line.slice(16))); }
      else appendFileSync(join(out, `${phase}-stdout.log`), line + "\n"); // Never publish the ready token.
    });
  });
  return { ...ready, child, stop: async () => {
    if (child.exitCode !== null) { assert.equal(child.exitCode, 0); return; }
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error("Gateway did not stop after closing desktop stdin")), 15_000);
      child.once("exit", code => { clearTimeout(timer); code === 0 ? done() : fail(new Error(`Gateway shutdown: ${code}`)); });
      child.stdin.end();
    });
  } };
}

async function main() {
  assert.equal(process.platform, "win32", "Run only in the disposable Windows upgrade job");
  const [phase, appArg, rootArg, outArg] = process.argv.slice(2);
  assert.ok(phase === "seed" || phase === "verify");
  assert.ok(appArg && rootArg && outArg);
  const app = resolve(appArg), root = resolve(rootArg), out = resolve(outArg);
  const defaultData = join(homedir(), ".local", "share", "achmage-workbench");
  const stateFile = join(root, "baseline.json");
  mkdirSync(out, { recursive: true });
  const results: Result[] = [];
  const check = (step: string, action: () => void) => {
    try { action(); results.push({ step, ok: true, detail: "" }); console.log(`PASS ${step}`); }
    catch (error) { results.push({ step, ok: false, detail: String(error) }); throw error; }
  };
  let gateway: Gateway | null = null;
  try {
    let before: Baseline | null = null;
    let standIns: Baseline["standIns"];
    if (phase === "seed") {
      assert.ok(!existsSync(root) && !existsSync(defaultData), "Fresh disposable runner: no previous fixture or application data");
      mkdirSync(root, { recursive: true });
      standIns = installStandIns(root);
    } else {
      before = JSON.parse(readFileSync(stateFile, "utf8")) as Baseline;
      standIns = before.standIns;
    }
    gateway = await launch(app, standIns, out, phase);
    const { call, bytes } = client(gateway);
    check("실제 설치본이 기본 데이터 폴더를 사용", () => assert.equal(resolve(gateway!.dataDir), resolve(defaultData)));
    await until(async () => {
      const providers = (await call<Snapshot>("GET", "/api/snapshot")).providers;
      return (["codex", "claude"] as const).every(name => providers.some(p => p.provider === name && p.installed && p.loggedIn === true
        && p.binary?.toLowerCase() === standIns.expect[name].path.toLowerCase()));
    }, "only the installed stand-in engines may answer fixture requests");
    if (phase === "seed") {
      const workDir = join(root, "기존 프로젝트"); mkdirSync(workDir);
      const folder = await call<Folder>("POST", "/api/folders", { name: "기존 분류" });
      const nested = await call<Folder>("POST", "/api/folders", { name: "하위 분류", parentId: folder.id });
      const work = await call<Work>("POST", "/api/works", { title: "기존 프로젝트", cwd: workDir, folderId: nested.id });
      await call("PATCH", `/api/works/${work.id}`, { pinned: true, tags: ["기존", "한글"] });
      const original = "---\r\nDIKM_단계:: '🔵 I'\r\ntags: [한글, 보존]\r\nempty: ''\r\nunknown:\r\n---\r\n기존 원문 🌊\r\n";
      const saved = original + "구형 앱에서 저장한 내용\r\n";
      const markdownPath = join(workDir, "원문.md"); writeFileSync(markdownPath, original);
      const markdown = await call<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: markdownPath });
      await call("PUT", `/api/artifacts/${markdown.id}/text`, { expectedRevision: markdown.revision, text: saved });
      const external = join(root, "외부 원문.md"); writeFileSync(external, original);
      await call("POST", `/api/works/${work.id}/artifacts`, { path: external });
      const docxPath = join(workDir, "기존 문서.docx"); copyFileSync(join(here, "fixtures", "hello.docx"), docxPath);
      const docx = await call<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: docxPath });
      await call("PUT", `/api/projects/${work.id}/body`, { body: "# 기존 프로젝트 노트\n\n업그레이드 뒤에도 남는 본문.\n", baseRevision: null });
      const stages = (await call<ProjectStage[]>("GET", "/api/projects/stages")).map((s, i) => i === 0 ? { ...s, name: "기존 대기", color: "#123456" } : s);
      await call("PUT", "/api/projects/stages", { stages });
      await call("PUT", `/api/projects/${work.id}/stage`, { stage: "기존 대기" });
      const prefs = { theme: "dark", upgradeFixture: { empty: "", values: [1, null, "한글"], collapsed: true } };
      await call("PUT", "/api/prefs", { prefs });
      const items: Baseline["items"] = {};
      for (const provider of ["codex", "claude"] as const) {
        const session = await call<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose: `${provider} 기존 대화` });
        await call("POST", `/api/sessions/${session.id}/messages`, { requestId: `upgrade-seed-${provider}`, text: "기존 대화 보존 확인" });
        await until(async () => {
          items[session.id] = (await call<{ items: TranscriptItem[] }>("GET", `/api/sessions/${session.id}/items`)).items;
          return items[session.id]!.some(item => item.kind === "turnEnd") && items[session.id]!.some(item => item.kind === "assistant");
        }, `${provider} old reply`);
      }
      const snapshot = await call<Snapshot>("GET", "/api/snapshot");
      const project = await call<ProjectPage>("GET", `/api/projects/${work.id}`);
      const artifacts = snapshot.artifacts.filter(a => a.workId === work.id);
      const files = [...new Set([...artifacts.map(a => a.path), project.note.path])].map(path => ({ path, sha256: digest(readFileSync(path)) }));
      // Prove the installer does not recursively remove former bundle folders or changed resources.
      const userPaths = ["hop/사용자 메모.md", "pdfcraft/사용자 메모.md", "kordoc/사용자 양식.hwpx", "ieumoffice/resources/modules/사용자 메모.md", "kordoc/SKILL.md"];
      const userBundleFiles = userPaths.map(path => {
        const full = join(app, path);
        assert.ok(existsSync(dirname(full)));
        if (path !== "kordoc/SKILL.md") assert.ok(!existsSync(full));
        writeFileSync(full, "사용자가 직접 추가하거나 수정한 파일\r\n");
        return { path, sha256: digest(readFileSync(full)) };
      });
      const baseline: Baseline = { standIns, dataDir: gateway.dataDir, origin: gateway.url, installedBytes: fileBytes(app),
        nativeSha256: digest(readFileSync(appLayout(app).native)), legacyPaths: legacyPaths.filter(p => existsSync(join(app, p))),
        work: snapshot.works.find(w => w.id === work.id)!, folders: [folder, nested], sessions: snapshot.sessions.filter(s => s.workId === work.id),
        items, prefs, stages, artifacts, files, userBundleFiles, markdown: { id: markdown.id, original, saved }, docxId: docx.id };
      check("공개 0.2.2에 예전 앱 번들이 실제 존재", () => assert.ok(baseline.legacyPaths.includes("hop") && baseline.legacyPaths.includes("pdfcraft")));
      check("두 엔진의 원래 대화 식별자 생성", () => assert.ok(baseline.sessions.every(s => s.nativeSessionId)));
      check("구형 앱이 저장한 원문과 이전 판 확인", () => assert.equal(readFileSync(markdownPath, "utf8"), saved));
      assert.equal((await bytes(`/api/artifacts/${markdown.id}/raw?revision=1`)).toString(), original);
      writeFileSync(stateFile, JSON.stringify(baseline, null, 2));
      writeFileSync(join(out, "before-summary.json"), JSON.stringify({ installedBytes: baseline.installedBytes, legacyPaths: baseline.legacyPaths,
        nativeSha256: baseline.nativeSha256, workId: work.id, sessionIds: baseline.sessions.map(s => s.id), files }, null, 2));
    } else {
      assert.ok(before);
      const snapshot = await call<Snapshot>("GET", "/api/snapshot");
      check("같은 데이터 위치와 창 origin 유지", () => { assert.equal(gateway!.dataDir, before.dataDir); assert.equal(gateway!.url, before.origin); });
      check("분류 폴더와 하위 구조 유지", () => { for (const f of before.folders) assert.deepEqual(pick(snapshot.folders.find(x => x.id === f.id)!, Object.keys(f)), f); });
      const work = snapshot.works.find(w => w.id === before.work.id)!;
      check("프로젝트 ID·폴더·고정·태그·작업 위치 유지", () => assert.deepEqual(pick(work, workFields), pick(before.work, workFields)));
      check("사용자 설정과 값의 형태 유지", () => assert.deepEqual(snapshot.prefs, before.prefs));
      assert.deepEqual(await call("GET", "/api/projects/stages"), before.stages);
      for (const session of before.sessions) {
        check(`${session.provider} 대화와 원래 엔진 ID 유지`, () => assert.deepEqual(pick(snapshot.sessions.find(s => s.id === session.id)!, sessionFields), pick(session, sessionFields)));
        const items = (await call<{ items: TranscriptItem[] }>("GET", `/api/sessions/${session.id}/items`)).items;
        check(`${session.provider} 대화 전체 내용 유지`, () => assert.deepEqual(items, before.items[session.id]));
      }
      check("등록 문서 ID·판·읽기 이력 유지", () => { for (const a of before.artifacts) assert.deepEqual(pick(snapshot.artifacts.find(x => x.id === a.id)!, artifactFields), pick(a, artifactFields)); });
      check("원문·외부 파일·DOCX·프로젝트 노트 바이트 유지", () => { for (const f of before.files) assert.equal(digest(readFileSync(f.path)), f.sha256, f.path); });
      check("기존 프로젝트와 문서에 작업공간 연결 추가", () => {
        assert.ok(work.defaultWorkspaceId && snapshot.workspaces?.some(w => w.id === work.defaultWorkspaceId));
        assert.ok(snapshot.sessions.filter(s => s.workId === work.id).every(s => s.workspaceId));
        assert.ok(snapshot.artifacts.filter(a => a.workId === work.id).every(a => a.workspaceId && a.relativePath !== undefined));
      });
      assert.equal((await bytes(`/api/artifacts/${before.markdown.id}/raw?revision=1`)).toString(), before.markdown.original);
      assert.equal((await bytes(`/api/artifacts/${before.markdown.id}/raw?revision=2`)).toString(), before.markdown.saved);
      const artifact = snapshot.artifacts.find(a => a.id === before.markdown.id)!;
      await call("PUT", `/api/artifacts/${artifact.id}/text`, { expectedRevision: artifact.revision, text: before.markdown.saved + "새 앱 수정\r\n" });
      await call("POST", `/api/artifacts/${artifact.id}/revert`, { toRevision: 2 });
      check("새 앱에서 수정하고 구형 앱의 판으로 복원", () => assert.equal(readFileSync(artifact.path, "utf8"), before.markdown.saved));
      const docx = await call<{ text: string }>("GET", `/api/artifacts/${before.docxId}/text`);
      check("보존된 DOCX를 새 내부 엔진으로 읽음", () => assert.ok(docx.text.includes("안녕하세요")));
      check("번들 안에 추가·수정한 사용자 파일 보존", () => {
        for (const f of before.userBundleFiles) assert.equal(digest(readFileSync(join(app, f.path))), f.sha256, f.path);
      });
      const protectedPaths = new Set(before.userBundleFiles.map(f => f.path));
      const remainingLegacyFiles = legacyManifest.files.filter(f => !protectedPaths.has(f.path) && existsSync(join(app, f.path))).map(f => f.path);
      check("예전 Electron·HOP·PDFCraft·kordoc 배포 파일 제거", () => assert.deepEqual(remainingLegacyFiles, []));
      const installedBytes = fileBytes(app);
      check("업그레이드 뒤에도 설치 크기가 실제로 감소", () => assert.ok(installedBytes < before.installedBytes * 0.6));
      writeFileSync(join(out, "after-summary.json"), JSON.stringify({ installedBytes, beforeInstalledBytes: before.installedBytes,
        nativeSha256: digest(readFileSync(appLayout(app).native)), remainingLegacyFiles, preservedUserBundleFiles: before.userBundleFiles,
        preservedWorkId: work.id, workspaceId: work.defaultWorkspaceId, sameDefaultDataDir: gateway.dataDir === before.dataDir, sameOrigin: gateway.url === before.origin }, null, 2));
    }
  } catch (error) {
    results.push({ step: `${phase} completed`, ok: false, detail: String(error) });
    throw error;
  } finally {
    try { await gateway?.stop(); }
    finally { writeFileSync(join(out, `${phase}-results.json`), JSON.stringify(results, null, 2)); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
