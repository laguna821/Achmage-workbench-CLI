// Built host + actual Ieum HTTP protocol, with a local fixture endpoint and fake CLI discovery.
// No real model, credential, existing profile or native window is used.
// Usage: node scripts/smoke-office-ai.ts <evidence-directory>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const repo = fileURLToPath(new URL("../", import.meta.url));
const outDir = resolve(process.argv[2] ?? join(tmpdir(), "wb-office-ai-bundle"));
mkdirSync(outDir, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), "wb-office-ai-bundle-"));
const checks: string[] = [];
const requests: { authorized: boolean; model: unknown }[] = [];
const provider = createServer(async (req, res) => {
  let input = ""; for await (const part of req) input += String(part);
  const request = JSON.parse(input) as { model?: unknown };
  requests.push({ authorized: req.headers.authorization === "Bearer fixture-only-key", model: request.model });
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "공통 AI 연결" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
mkdirSync(join(profile, "office")); mkdirSync(join(profile, "project"));
const settingsPath = join(profile, "office", "ai-settings.json");
writeFileSync(settingsPath, JSON.stringify({ provider: "custom", providers: { custom: { model: "fixture-model", apiKey: "fixture-only-key", baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1` } } }), { mode: 0o600 });
const originalSettings = readFileSync(settingsPath);
const file = join(profile, "project", "문서.md"); writeFileSync(file, "원본은 유지합니다.\n");
const child = spawn(process.execPath, [join(repo, "apps/host/dist/host.mjs")], {
  cwd: repo,
  env: { ...process.env, WORKBENCH_DATA_DIR: profile, WORKBENCH_PORT: "0", WORKBENCH_EDITORS_PORT: "0", WORKBENCH_EXIT_ON_STDIN_CLOSE: "1", WORKBENCH_CODEX_BIN: join(repo, "scripts/fixtures/fake-codex.mjs"), WORKBENCH_CLAUDE_BIN: join(repo, "scripts/fixtures/fake-claude.mjs") },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = ""; child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
const exited = new Promise<number | null>((done) => child.once("exit", (code) => done(code)));
const ready = new Promise<{ url: string; token: string }>((done, reject) => {
  const timer = setTimeout(() => reject(new Error("Bundled host did not become ready")), 15_000);
  child.once("error", (error) => { clearTimeout(timer); reject(error); });
  child.once("exit", () => { clearTimeout(timer); reject(new Error("Bundled host exited before ready")); });
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.startsWith("WORKBENCH_READY ")) return;
    clearTimeout(timer); done(JSON.parse(line.slice("WORKBENCH_READY ".length)));
  });
});
let failure: unknown;
try {
  const host = await ready;
  const api = async (path: string, body: unknown) => {
    const response = await fetch(`${host.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.ok, true, `API ${path}: ${response.status}`); return response.json();
  };
  const work = await api("/api/works", { title: "Office AI bundle", cwd: join(profile, "project") });
  const artifact = await api(`/api/works/${work.id}/artifacts`, { path: file });
  const editor = await api(`/api/artifacts/${artifact.id}/editor`, {});
  const endpoint = `${editor.origin}/api/artifacts/${artifact.id}/ai`;
  assert.equal((await fetch(`${endpoint}/settings`)).status, 401); checks.push("document grant required");
  const headers = { authorization: `Bearer ${editor.token}` };
  const settings = await (await fetch(`${endpoint}/settings`, { headers })).json();
  assert.equal(JSON.stringify(settings).includes("fixture-only-key"), false); checks.push("saved key remains in host");
  const request = { settings, requestId: "bundle-turn", sessionId: "bundle-session", system: "Fixture", messages: [{ role: "user", text: "hello" }] };
  const response = await fetch(`${endpoint}/stream`, { method: "POST", headers, body: JSON.stringify(request) });
  const chunks = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(chunks.filter((chunk) => chunk.type === "delta").map((chunk) => chunk.text).join(""), "공통 AI 연결");
  assert.equal(chunks.at(-1).type, "done"); assert.deepEqual(requests, [{ authorized: true, model: "fixture-model" }]); checks.push("bundled original provider streams Korean answer");
  assert.deepEqual(readFileSync(settingsPath), originalSettings); assert.equal(readFileSync(file, "utf8"), "원본은 유지합니다.\n"); checks.push("settings and document unchanged");
  writeFileSync(settingsPath, JSON.stringify({ provider: "auto", providers: {} }));
  const refused = await fetch(`${endpoint}/stream`, { method: "POST", headers, body: JSON.stringify(request) });
  assert.equal(JSON.parse((await refused.text()).trim()).type, "error"); assert.equal(requests.length, 1); checks.push("changed selection refused before provider call");
} catch (error) { failure = error; }
finally {
  child.stdin.end();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([exited, new Promise<never>((_done, reject) => { timer = setTimeout(() => reject(new Error("Bundled host did not stop normally")), 10_000); })]);
    assert.equal(code, 0); checks.push("owned host exits normally on stdin close");
  } catch (error) { failure ??= error; }
  finally { clearTimeout(timer); }
  provider.closeAllConnections(); await new Promise<void>((done) => provider.close(() => done()));
  writeFileSync(join(outDir, "host.stderr.log"), stderr, { mode: 0o600 });
  writeFileSync(join(outDir, "results.json"), JSON.stringify({ checks, passed: checks.length, failure: failure instanceof Error ? failure.message : failure ? String(failure) : null, realModels: false }, null, 2));
  rmSync(profile, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(`${checks.length}/6 Office AI bundle checks passed`);
