/// <reference lib="dom" />
// The sealed Mini App form (apps/host/src/channels/seal-v1.html) in a real browser engine
// (Playwright's Chromium, headless), served from 127.0.0.1 only: it shows masked fields from the
// address after "#", seals what is typed for the PC's one-time key, hands the sealed block to the
// Telegram bridge (a stand-in here), and makes no request of its own. The PC's side
// (apps/host/src/channels/seal.ts) then opens the block. Nothing here contacts Telegram or any
// other host. Values are random and are not printed.
//
// Usage (through ux/run-isolated.sh): node scripts/seal-page-check.ts [--shots=<dir>]

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { SealKeys } from "../apps/host/src/channels/seal.ts";

const shots = process.argv.find((arg) => arg.startsWith("--shots="))?.split("=")[1];
const page = readFileSync(resolve("apps/host/src/channels/seal-v1.html"));
const served: string[] = [];
const server = createServer((req, res) => {
  served.push(req.url ?? "");
  if (req.url !== "/seal-v1.html") { res.writeHead(404); return void res.end(); }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(page);
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const failures: string[] = [];
const check = (ok: boolean, what: string) => { console.log(`${ok ? "PASS" : "FAIL"} ${what}`); if (!ok) failures.push(what); };

const seals = new SealKeys();
const request = seals.create({ userId: "555", handoffId: "h1", fields: ["아이디", "비밀번호"] });
const values = { 아이디: `zz-${randomBytes(9).toString("base64url")}`, 비밀번호: `zz-${randomBytes(9).toString("base64url")}` };

const browser = await chromium.launch();
try {
  for (const scheme of ["light", "dark"] as const) {
    const context = await browser.newContext({ viewport: { width: 390, height: 640 }, colorScheme: scheme });
    const tab = await context.newPage();
    const outside: string[] = [];
    tab.on("request", (sent) => { if (!sent.url().startsWith(origin)) outside.push(sent.url()); });
    // The Telegram client's bridge, as the page finds it inside the app (a stand-in that keeps what it was given).
    await tab.addInitScript(() => {
      (window as unknown as { __sent: string[] }).__sent = [];
      (window as unknown as { TelegramWebviewProxy: unknown }).TelegramWebviewProxy = { postEvent: (type: string, data: string) => { (window as unknown as { __sent: string[] }).__sent.push(`${type} ${data}`); } };
    });
    await tab.goto(SealKeys.address(`${origin}/seal-v1.html`, request, "학술정보원", ["아이디", "비밀번호"]));
    const inputs = tab.locator("input");
    check(await inputs.count() === 2, `${scheme}: two fields from the address`);
    check((await inputs.evaluateAll((all) => all.map((input) => (input as HTMLInputElement).type))).every((type) => type === "password"), `${scheme}: the fields are masked`);
    check(await tab.locator("h1").textContent() === "학술정보원", `${scheme}: the title from the address`);
    await tab.getByLabel("아이디").fill(values.아이디);
    await tab.getByLabel("비밀번호").fill(values.비밀번호);
    if (shots) await tab.screenshot({ path: join(shots, `seal-page-${scheme}-filled.png`) });
    if (scheme === "dark") {
      // The other run opens the same request once; this one shows the form only.
      check(outside.length === 0, `${scheme}: no request leaves 127.0.0.1`);
      await context.close();
      continue;
    }
    await tab.getByRole("button", { name: "봉인해서 보내기" }).click();
    await tab.waitForFunction(() => (window as unknown as { __sent: string[] }).__sent.length === 1);
    const sent = await tab.evaluate(() => (window as unknown as { __sent: string[] }).__sent[0]!);
    if (shots) await tab.screenshot({ path: join(shots, `seal-page-${scheme}-sent.png`) });
    const [type, ...rest] = sent.split(" ");
    const data = (JSON.parse(rest.join(" ")) as { data: string }).data;
    check(type === "web_app_data_send", "the sealed block goes to Telegram's web_app_data_send");
    check(Buffer.byteLength(data) <= 4096, `the block is ${Buffer.byteLength(data)} bytes (at most 4096)`);
    check(!Object.values(values).some((value) => data.includes(value)), "the block does not carry a value in the clear");
    check((await inputs.evaluateAll((all) => all.map((input) => (input as HTMLInputElement).value))).every((value) => value === ""), "the fields are emptied after sending");
    const opened = seals.open(data, "555");
    check(opened.handoffId === "h1" && opened.values.아이디 === values.아이디 && opened.values.비밀번호 === values.비밀번호, "the PC opens the block to the typed values");
    let reused = false;
    try { seals.open(data, "555"); } catch { reused = true; }
    check(reused, "the same block does not open twice");
    check(outside.length === 0, `${scheme}: no request leaves 127.0.0.1`);
    await context.close();
  }
  // Opened outside Telegram (no bridge): it says so, sends nothing, and keeps what was typed.
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 640 } });
    const tab = await context.newPage();
    const spare = seals.create({ userId: "555", handoffId: "h2", fields: ["키"] });
    await tab.goto(SealKeys.address(`${origin}/seal-v1.html`, spare, "노션 키", ["키"]));
    await tab.getByLabel("키").fill(values.비밀번호);
    await tab.getByRole("button", { name: "봉인해서 보내기" }).click();
    await tab.waitForFunction(() => document.getElementById("status")!.textContent !== "");
    check((await tab.locator("#status").textContent())!.includes("텔레그램 밖에서"), "without a bridge it says it cannot send, and does not say 보냈습니다");
    check(await tab.getByLabel("키").inputValue() === values.비밀번호, "without a bridge what was typed stays");
    await context.close();
  }
  check(served.every((url) => url === "/seal-v1.html"), "the page asked its server for nothing but itself");
} finally {
  await browser.close();
  server.close();
}
console.log(failures.length ? `${failures.length} failed` : "all passed");
process.exit(failures.length ? 1 : 0);
