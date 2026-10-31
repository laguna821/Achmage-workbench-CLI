// Actual official Lightpanda binary, JavaScript-rendered fixture, and the shipped
// gateway/engine spool. No LLM calls, external accounts, or graphical browser.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter, resolve } from "node:path";
import { AgentBrowser } from "../apps/host/src/browse.ts";
import { browserSessionName, type Session, type Work } from "@workbench/contracts";

const binary = resolve(process.argv[2] ?? ""), out = resolve(process.argv[3] ?? "lightpanda-check.json");
const root = mkdtempSync(join(tmpdir(), "wb-panda-check-"));
const checks: string[] = []; const results: Record<string, unknown> = {};
const check = (name: string, value: unknown) => { assert.ok(value, name); checks.push(name); console.log(`PASS ${name}`); };
const html = `<!doctype html><html lang="ko"><head><title>AI 수집 검증</title></head><body><h1>동적 페이지</h1><input id="query" aria-label="검색어"><button id="apply">적용</button><div id="result">초기 값</div><div id="ready"></div><article id="long">${"검증 본문 ".repeat(10000)}</article><script>fetch('/data').then(r=>r.json()).then(v=>{document.querySelector('#ready').textContent=v.text;document.querySelector('#ready').dataset.loaded='yes'});document.querySelector('#apply').onclick=()=>document.querySelector('#result').textContent=document.querySelector('#query').value;</script></body></html>`;
let slowStarted = 0, slowCancelled = 0;
const server = createServer((req, res) => {
  if (req.url === "/slow") {
    slowStarted++; const timer = setTimeout(() => res.end(html), 25000);
    res.once("close", () => { clearTimeout(timer); if (!res.writableEnded) slowCancelled++; }); return;
  }
  res.setHeader("content-type", req.url === "/data" ? "application/json" : "text/html; charset=utf-8"); res.end(req.url === "/data" ? JSON.stringify({ text: "비동기 서버 데이터" }) : html);
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const address = server.address(); assert.ok(address && typeof address !== "string");
const url = `http://127.0.0.1:${address.port}`;
const sessions = ["one", "two"].map(id => ({ id, workId: "work", provider: "claude", status: "running", browser: true, archivedAt: null, purpose: id }) as Session);
let access: "full" | "ask" = "full";
const browser = new AgentBrowser({ dataDir: root, lightpanda: binary });
const items: any[] = [];
browser.bind({ lookup: id => { const session = sessions.find(s => s.id === id); return session ? { session, work: { id: "work", cwd: root } as Work, access } : null; }, sessions: () => sessions, upsertItem: (_id, item) => items.push(item), updateSession: () => {}, publish: () => {} });
const cli = (id: string, args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
  const child = spawn("workbench-browser", [`-s=${browserSessionName(id)}`, ...args], { env: { ...process.env, PATH: `${browser.paths.bin}${delimiter}${process.env.PATH}` }, cwd: root });
  let stdout = "", stderr = "";
  child.stdout.on("data", v => stdout += v); child.stderr.on("data", v => stderr += v); child.once("error", reject);
  child.once("exit", code => done({ code, stdout, stderr }));
});
const run = async (id: string, args: string[]) => { const result = await cli(id, args); assert.equal(result.code, 0, result.stderr); return result.stdout; };
const until = async (predicate: () => boolean, timeout = 2000) => { const deadline = Date.now() + timeout; while (!predicate() && Date.now() < deadline) await new Promise(done => setTimeout(done, 20)); assert.ok(predicate()); };
try {
  check("기본 Lightpanda, Chromium 설치·창 없이 시작", browser.status().engine === "lightpanda" && browser.status().install.state === "ready" && browser.status().window.kind === "closed");
  await run("one", ["open", url]); await run("one", ["wait", '#ready[data-loaded="yes"]']);
  check("실제 JavaScript·fetch 렌더링 본문 수집", (await run("one", ["read", "#ready"])).includes("비동기 서버 데이터"));
  check("페이지 구조에서 조작 대상 발견", (await run("one", ["find", "적용"])).includes("apply"));
  await run("one", ["fill", "#query", "워크벤치 자동화"]); await run("one", ["click", "#apply"]);
  check("입력·클릭 후 구조화 추출", (await run("one", ["extract", JSON.stringify({ result: "#result" })])).includes("워크벤치 자동화"));
  await run("two", ["open", url]);
  check("두 작업 세션의 페이지 상태 격리", (await run("two", ["extract", JSON.stringify({ result: "#result" })])).includes("초기 값") && (await run("one", ["extract", JSON.stringify({ result: "#result" })])).includes("워크벤치 자동화"));
  const first = await run("one", ["read", "#long", "--limit=1000"]), second = await run("one", ["read", "#long", "--offset=1000", "--limit=1000"]);
  results.htmlBytes = Buffer.byteLength(html); results.firstReadBytes = Buffer.byteLength(first);
  check("큰 본문을 제한하고 저장된 결과 이어 읽기", first.length < 1300 && first.includes("--offset=1000") && second.includes("--offset=2000"));
  const denied = await cli("one", ["cookies"]); check("기존 쿠키 접근 차단 유지", denied.code !== 0);
  const slow = cli("one", ["open", `${url}/slow`]); await until(() => slowStarted === 1); const stopAt = Date.now(); browser.setPaused("one", true);
  check("중지 버튼이 진행 중인 결과 수락을 즉시 중지", (await slow).code !== 0);
  await until(() => slowCancelled === 1, 16000); results.networkCloseAfterStopMs = Date.now() - stopAt;
  check("원본 엔진의 정상 종료가 HTTP 제한 안에 실제 연결 정리", slowCancelled === 1); browser.setPaused("one", false);
  browser.setPaused("one", true); check("사용자 중지 상태에서 실행 거절", (await cli("one", ["click", "#apply"])).code !== 0); browser.setPaused("one", false);
  access = "ask";
  const pending = cli("one", ["click", "#apply"]); await until(() => items.some(i => i.kind === "approval" && !i.decision));
  const item = items.find(i => i.kind === "approval" && !i.decision); browser.answer("one", item.id, "decline");
  check("같은 권한 확인 게이트에서 거절한 클릭 미실행", (await pending).code !== 0); access = "full";
  await run("one", ["close"]); check("한 세션 종료가 다른 세션을 닫지 않음", (await run("two", ["read", "#result"])).includes("초기 값"));
  mkdirSync(join(browser.paths.profile, "Default"), { recursive: true }); const preserved = join(browser.paths.profile, "Default", "fixture.txt"); writeFileSync(preserved, "existing-profile");
  await browser.selectEngine("chromium"); check("호환 모드 전환 시 기존 Chromium 프로필 보존", browser.status().engine === "chromium" && readFileSync(preserved, "utf8") === "existing-profile");
  await browser.selectEngine("lightpanda"); check("Lightpanda 재선택·실행", (await run("two", ["open", url])).includes("Lightpanda"));
} finally {
  await browser.shutdown(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
  writeFileSync(out, JSON.stringify({ checks, results, binary, graphicalBrowser: false, paidModelCalls: 0 }, null, 2));
  rmSync(root, { recursive: true, force: true });
}
