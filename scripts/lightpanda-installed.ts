// Exercise the real browser through an installed app's bundled host and Node.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { browserSessionName, type AgentBrowserStatus, type Session } from "@workbench/contracts";
import type { NativeLightpandaBuild } from "../apps/host/src/browse-lightpanda.ts";
import { appLayout, client, type Gateway } from "./setup-gateway.ts";

export async function checkLightpandaInstalled(gateway: Gateway, app: string, workId: string,
  check: (step: string, ok: boolean, detail?: string) => void) {
  if (process.platform !== "win32") return;
  const { call } = client(gateway);
  const manifest = JSON.parse(readFileSync(new URL("../packaging/lightpanda-windows.json", import.meta.url), "utf8")) as NativeLightpandaBuild;
  const step = async (name: string, run: () => Promise<void>) => {
    try { await run(); check(`Lightpanda: ${name}`, true, `${process.platform}/${process.arch}`); }
    catch (error) { check(`Lightpanda: ${name}`, false, String(error)); }
  };
  await step("설치본의 네이티브 엔진·DLL 해시와 기본 준비 상태", async () => {
    for (const [name, hash] of Object.entries(manifest.files)) {
      assert.equal(createHash("sha256").update(readFileSync(join(app, "lightpanda", name))).digest("hex"), hash, name);
    }
    const status = await call<AgentBrowserStatus>("GET", "/api/agent-browser");
    assert.equal(status.engine, "lightpanda");
    assert.equal(status.install.state, "ready");
    assert.equal(status.install.browserVersion, manifest.version);
  });
  await step("설치된 게이트웨이에서 WSL 없이 JavaScript·입력·본문 수집", async () => {
    const server = createServer((req, res) => {
      res.setHeader("content-type", req.url === "/data" ? "application/json" : "text/html; charset=utf-8");
      res.end(req.url === "/data" ? JSON.stringify({ text: "설치본 네이티브 브라우징" }) :
        '<html><body><div id="loaded"></div><input id="query"><button id="go">적용</button><div id="result"></div><script>fetch("/data").then(r=>r.json()).then(v=>{document.querySelector("#loaded").textContent=v.text;document.querySelector("#loaded").dataset.ready="yes"});document.querySelector("#go").onclick=()=>document.querySelector("#result").textContent=document.querySelector("#query").value;</script></body></html>');
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    let session: Session | null = null;
    const run = async (...args: string[]) => (await promisify(execFile)(appLayout(app).node,
      [join(gateway.dataDir, "agent-browser/bin/playwright-cli.mjs"), `-s=${browserSessionName(session!.id)}`, ...args],
      { timeout: 40000, windowsHide: true })).stdout;
    try {
      session = await call<Session>("POST", `/api/works/${workId}/sessions`, { provider: "codex", purpose: "네이티브 브라우저 설치 확인", browser: true, access: "full" });
      await run("open", `http://127.0.0.1:${address.port}`);
      await run("wait", '#loaded[data-ready="yes"]');
      assert.match(await run("read", "#loaded"), /설치본 네이티브 브라우징/);
      await run("fill", "#query", "한글 자동화 확인");
      await run("click", "#go");
      assert.match(await run("read", "#result"), /한글 자동화 확인/);
    } finally {
      try { if (session) await run("close"); }
      finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
    }
  });
}
