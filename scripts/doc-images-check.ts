/// <reference lib="dom" />
// Browser check of pictures in documents, in the real Workbench UI against a real gateway (stand-in
// engines, no model) and a stand-in for Cloudflare R2 (a small S3 server here that checks each
// request's SigV4 signature with the secret it knows, keeps the objects and serves them at a
// public address). The same steps run in a Codex work and in a Claude work:
//   - "그림 올리기 · Cloudflare R2": fill the keys, "연결 확인" (put, public read, delete), save; the
//     secret never comes back to the screen; the settings file is 0600.
//   - Markdown: a pasted picture shows a placeholder while it uploads, then `![image](public url)`;
//     the preview shows it. R2 refusing: a toast and the picture in the work folder's assets/,
//     linked relatively and shown in the preview. A dropped picture; a text copy that also carries a
//     picture still pastes the text. The Hangul text view says it cannot take pictures.
// Usage: node scripts/doc-images-check.ts [outDir] [codex|claude]

import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { deflateSync } from "node:zlib";
import { chromium, type Page } from "playwright-core";
import type { Artifact, Provider, Session, Work } from "@workbench/contracts";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-doc-images");
const providers: Provider[] = process.argv[3] === "codex" || process.argv[3] === "claude" ? [process.argv[3]] : ["codex", "claude"];
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-doc-images-"));
const worksDir = mkdtempSync(join(tmpdir(), "workbench-doc-images-works-"));
const scratch = mkdtempSync(join(tmpdir(), "workbench-doc-images-tmp-"));
const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
};
const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

// ── pictures ───────────────────────────────────────────────────────────
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (data: Buffer) => {
  let c = 0xffffffff;
  for (const byte of data) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([length, body, sum]);
};
/** A small gradient PNG; `seed` makes different pictures (different bytes, different names). */
function makePng(width: number, height: number, seed: number) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = y * (width * 3 + 1) + 1 + x * 3;
      raw[at] = (x * 255) / width + seed * 40;
      raw[at + 1] = (y * 255) / height;
      raw[at + 2] = 160 - seed * 30;
    }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// ── a stand-in for R2 ──────────────────────────────────────────────────
const KEYS = { accountId: "0123456789abcdef0123456789abcdef", accessKeyId: "7f3c1e9a2b4d6f8091a3c5e7f9b1d3e5", secretAccessKey: "c0ffee".repeat(10) + "abcd", bucket: "notes-img" };
const awsEncode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();
/** SigV4 as the server reconstructs it from the request it got (written apart from the gateway's). */
function expectedSignature(req: IncomingMessage, path: string, signed: string[], date: string) {
  const canonical = [
    req.method,
    path.split("/").map((part) => awsEncode(decodeURIComponent(part))).join("/"),
    "",
    signed.map((name) => `${name}:${String(req.headers[name] ?? "").trim()}\n`).join(""),
    signed.join(";"),
    String(req.headers["x-amz-content-sha256"]),
  ].join("\n");
  const scope = `${date.slice(0, 8)}/auto/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", date, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${KEYS.secretAccessKey}`, date.slice(0, 8)), "auto"), "s3"), "aws4_request");
  return createHmac("sha256", key).update(toSign).digest("hex");
}
const r2 = {
  objects: new Map<string, { body: Buffer; type: string; cache: string }>(),
  requests: [] as { method: string; path: string; shape: boolean; signature: boolean; payload: boolean }[],
  refuse: false,
  delay: 900,
};
const fake = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const part of req) chunks.push(part as Buffer);
  const body = Buffer.concat(chunks);
  const url = new URL(req.url ?? "/", "http://r2");
  if (url.pathname.startsWith("/public/")) {
    const object = r2.objects.get(decodeURIComponent(url.pathname.slice("/public/".length)));
    res.writeHead(object ? 200 : 404, { "content-type": object?.type ?? "text/plain", "access-control-allow-origin": "*" });
    return res.end(object?.body ?? "no such object");
  }
  const authorization = String(req.headers.authorization ?? "");
  const shape = /^AWS4-HMAC-SHA256 Credential=([0-9a-f]{32})\/(\d{8})\/auto\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(authorization);
  const date = String(req.headers["x-amz-date"] ?? "");
  const signed = shape?.[3]?.split(";") ?? [];
  const shapeOk = Boolean(shape && shape[1] === KEYS.accessKeyId && date.startsWith(shape[2]!) && ["host", "x-amz-content-sha256", "x-amz-date"].every((name) => signed.includes(name)));
  const signatureOk = Boolean(shape && expectedSignature(req, url.pathname, signed, date) === shape[4]);
  const payloadOk = sha256(body) === req.headers["x-amz-content-sha256"];
  r2.requests.push({ method: req.method ?? "", path: decodeURIComponent(url.pathname), shape: shapeOk, signature: signatureOk, payload: payloadOk });
  if (req.method === "PUT") await new Promise((done) => setTimeout(done, r2.delay));
  const fail = (status: number, code: string) => {
    res.writeHead(status, { "content-type": "application/xml" });
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`);
  };
  if (!shapeOk || !signatureOk || !payloadOk) return fail(403, "SignatureDoesNotMatch");
  if (r2.refuse) return fail(403, "AccessDenied");
  const key = decodeURIComponent(url.pathname).replace(`/${KEYS.bucket}/`, "");
  if (req.method === "PUT") r2.objects.set(key, { body, type: String(req.headers["content-type"] ?? ""), cache: String(req.headers["cache-control"] ?? "") });
  else if (req.method === "DELETE") r2.objects.delete(key);
  res.writeHead(200);
  res.end();
});
await new Promise<void>((done) => fake.listen(0, "127.0.0.1", done));
const r2Url = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

// A stand-in Hangul engine: the text view of any HWPX is one heading and a line.
const kordocRunner = join(scratch, "kordoc-runner.mjs");
writeFileSync(
  kordocRunner,
  `import { mkdirSync, readFileSync } from "node:fs";
const request = JSON.parse(readFileSync(process.argv[2], "utf8"));
mkdirSync(request.outputDir, { recursive: true });
const markdown = "# 신청서\\n\\n성명: 홍길동\\n";
process.stdout.write(JSON.stringify({ status: "success", success: true, data: { markdown, pages: [] } }));
`,
);

// ── the gateway ────────────────────────────────────────────────────────
const child = spawn(process.execPath, ["apps/host/src/main.ts"], {
  env: {
    ...process.env,
    WORKBENCH_DATA_DIR: dataDir,
    WORKBENCH_WEB_DIR: "apps/web/dist",
    WORKBENCH_HOST_LABEL: "노트북",
    WORKBENCH_CODEX_BIN: resolve("scripts/fixtures/fake-codex.mjs"),
    WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs"),
    WORKBENCH_R2_ENDPOINT: r2Url,
    WORKBENCH_KORDOC_RUNNER: kordocRunner,
  },
  stdio: ["ignore", "pipe", "inherit"],
});
const ready = await new Promise<{ url: string; token: string }>((done) => {
  createInterface({ input: child.stdout! }).on("line", (line) => {
    if (line.startsWith("WORKBENCH_READY ")) done(JSON.parse(line.slice(16)));
  });
});
const auth = { authorization: `Bearer ${ready.token}` };
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${ready.url}${path}`, { method, headers: { ...auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(`${method} ${path}: ${json.message}`);
  return json;
};
const until = async (what: () => Promise<boolean>, timeout = 15_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await what().catch(() => false)) return true;
    await new Promise((done) => setTimeout(done, 150));
  }
  return false;
};
await api("PUT", "/api/prefs", { prefs: { onboarding: "done", startScreen: "last" } });

const browser = await chromium.launch();
const logs: string[] = [];

/** The text of a revision. */
const revisionText = async (id: string, revision: number) => (await api<{ text: string }>("GET", `/api/artifacts/${id}/text?revision=${revision}`)).text;

/** Paste or drop files into an element, as the browser hands them to the page. */
const transfer = (target: Page, selector: string, kind: "paste" | "drop", files: { b64: string; name: string; type: string }[], extra: Record<string, string> = {}, point?: { x: number; y: number }) =>
  target.evaluate(
    ({ selector, kind, files, extra, point }) => {
      const element = (selector === ":focus" ? document.activeElement : document.querySelector(selector)) as HTMLElement | null;
      if (!element) return `no ${selector}`;
      const data = new DataTransfer();
      for (const file of files) data.items.add(new File([Uint8Array.from(atob(file.b64), (c) => c.charCodeAt(0))], file.name, { type: file.type }));
      for (const [type, value] of Object.entries(extra)) data.setData(type, value);
      const rect = element.getBoundingClientRect();
      const x = point?.x ?? rect.left + rect.width / 2;
      const y = point?.y ?? rect.top + Math.min(rect.height / 2, 160);
      if (kind === "paste") {
        const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
        element.dispatchEvent(event);
        return event.defaultPrevented ? "handled" : "ignored";
      }
      const init = { dataTransfer: data, bubbles: true, cancelable: true, clientX: x, clientY: y };
      element.dispatchEvent(new DragEvent("dragenter", init));
      element.dispatchEvent(new DragEvent("dragover", init));
      const drop = new DragEvent("drop", init);
      element.dispatchEvent(drop);
      return drop.defaultPrevented ? "handled" : "ignored";
    },
    { selector, kind, files, extra, point },
  );
const png = (seed: number, name = "image.png") => ({ b64: makePng(180 + seed * 10, 110, seed).toString("base64"), name, type: "image/png" });

async function openDoc(page: Page, name: string) {
  // The documents menu is in the conversation view.
  if (await page.locator(".doc-tab.conversation").count()) await page.locator(".doc-tab.conversation").click();
  await page.locator(".docs-button").click();
  await page.locator(".docs-menu").getByText(name, { exact: true }).click();
}
const saveState = (page: Page) => page.locator(".save-state").innerText().catch(() => "");
const waitSaved = (page: Page, revision: number, timeout = 25_000) => until(async () => (await saveState(page)).includes(`r${revision} 저장됨`), timeout);

async function flow(provider: Provider, index: number) {
  const label = provider === "codex" ? "Codex" : "Claude";
  const cwd = join(worksDir, provider);
  mkdirSync(join(cwd, "강의"), { recursive: true });
  writeFileSync(join(cwd, "노트.md"), "# 가을 특강 노트\n\n도식은 아래에.\n");
  writeFileSync(join(cwd, "양식.hwpx"), "PK\u0003\u0004 stand-in");
  const work = await api<Work>("POST", "/api/works", { title: `${label} 그림 넣기`, cwd });
  await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider, purpose: "그림" });
  const note = await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: "노트.md" });

  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await context.newPage();
  const watch = (where: string) => (message: { type(): string; text(): string }) => message.type() === "error" && logs.push(`[${label} ${where}] ${message.text().slice(0, 200)}`);
  page.on("console", watch("page"));
  page.on("pageerror", (error) => logs.push(`[${label} pageerror] ${error.message.slice(0, 200)}`));
  page.on("response", (response) => response.status() >= 500 && logs.push(`[${label} HTTP ${response.status()}] ${response.url().replace(/token=[^&]+/, "token=…").slice(0, 160)}`));
  const shot = (name: string) => page.screenshot({ path: join(outDir, `${provider}-${name}`) });
  const pass = (step: string, ok: boolean, detail = "") => check(`[${label}] ${step}`, ok, detail);
  const toast = async () => (await page.locator(".toast").innerText().catch(() => "")).replace(/\s+/g, " ");
  try {
    await page.addInitScript((id) => localStorage.setItem("workbench.lastWork", id), work.id);
    await page.goto(`${ready.url}/?token=${ready.token}`);
    await page.waitForSelector(".docs-button");

    // ── R2 settings ─────────────────────────────────────────────────────
    await page.locator('button[aria-label="연결과 설정"]').click();
    await page.getByText("그림 올리기 · Cloudflare R2…").waitFor();
    const row = (await page.locator(".connections").innerText()).replace(/\s+/g, " ");
    await page.getByText("그림 올리기 · Cloudflare R2…").click();
    await page.waitForSelector(".image-upload-sheet");
    if (index === 0) {
      pass("⋯ 메뉴에 R2 줄(설정 전: 작업 폴더 저장)", /설정 안 됨/.test(row) && /assets/.test(row), row.slice(row.indexOf("문서에 붙여"), row.indexOf("문서에 붙여") + 90));
      const fill = (key: string, value: string) => page.locator(`.image-upload-sheet input[name="r2-${key}"]`).fill(value);
      await fill("accountId", `https://${KEYS.accountId}.r2.cloudflarestorage.com/${KEYS.bucket}`);
      await fill("accessKeyId", KEYS.accessKeyId);
      await fill("secretAccessKey", KEYS.secretAccessKey);
      await fill("publicBaseUrl", `${r2Url}/public/`);
      await fill("keyPrefix", "workbench");
      await page.getByRole("button", { name: "연결 확인" }).click();
      await page.waitForSelector(".image-upload-check li.summary, .image-upload-check li.failed", { timeout: 15_000 });
      const steps = await page.locator(".image-upload-check li").allInnerTexts();
      await shot("01-r2-check.png");
      pass("'연결 확인': 키로 올리고 공개 주소에서 읽고 지움", steps.length === 4 && steps[3]!.includes("올릴 수 있습니다") && r2.objects.size === 0, steps.join(" / "));
      await page.getByRole("button", { name: "저장", exact: true }).click();
      await until(async () => (await toast()).includes("저장했습니다"), 5000);
      const view = await api<Record<string, unknown>>("GET", "/api/image-upload");
      const fileMode = statSync(join(dataDir, "image-upload.json")).mode & 0o777;
      const secretShown = (await page.locator(".image-upload-sheet").innerHTML()).includes(KEYS.secretAccessKey) || JSON.stringify(view).includes(KEYS.secretAccessKey);
      pass(
        "저장: 버킷은 S3 API 주소에서 채움, 비밀 키는 화면·응답에 없음, 파일 0600",
        view.configured === true && view.bucket === KEYS.bucket && view.accessKeyHint === "7f3c…d3e5" && !secretShown && fileMode === 0o600,
        `bucket=${String(view.bucket)} hint=${String(view.accessKeyHint)} mode=${fileMode.toString(8)} secretShown=${secretShown}`,
      );
      await shot("02-r2-saved.png");
    } else {
      // The sheet reads the saved settings when it opens.
      await page.waitForSelector(".image-upload-sheet .image-upload-state.ok", { timeout: 5000 }).catch(() => undefined);
      const secretValue = await page.locator('.image-upload-sheet input[name="r2-secretAccessKey"]').inputValue();
      const placeholder = await page.locator('.image-upload-sheet input[name="r2-secretAccessKey"]').getAttribute("placeholder");
      pass("다시 연 설정: 연결됨, 비밀 키 칸은 비어 있고 '저장됨'", /연결됨/.test(row) && secretValue === "" && (placeholder ?? "").includes("저장됨"), `${row.slice(row.indexOf("Cloudflare R2"), row.indexOf("Cloudflare R2") + 30)} · ${placeholder}`);
    }
    await page.locator('.image-upload-sheet button[aria-label="닫기"]').click();

    // ── Markdown: paste → placeholder → R2 link → preview ────────────────
    await openDoc(page, "노트.md");
    await page.waitForSelector(".md-editor .cm-content");
    await page.locator(".md-editor .cm-content").click();
    await page.keyboard.press("Control+End");
    const before = r2.requests.length;
    const first = png(index * 3 + 1);
    const firstKey = `workbench/${sha256(Buffer.from(first.b64, "base64")).slice(0, 16)}.png`;
    const pasted = await transfer(page, ".md-editor .cm-content", "paste", [first]);
    const placeholder = await page.waitForSelector(".cm-image-pending", { timeout: 3000 }).then(() => page.locator(".cm-image-pending").innerText()).catch(() => "");
    await shot("03-md-uploading.png");
    pass("마크다운에 붙여 넣은 그림: 올리는 동안 자리 표시", pasted === "handled" && placeholder.includes("그림 넣는 중"), placeholder);
    const link = `![image](${r2Url}/public/${firstKey})`;
    await until(async () => (await page.locator(".md-editor .cm-content").innerText()).includes(link), 10_000);
    await waitSaved(page, 2);
    const put = r2.requests.slice(before).find((request) => request.method === "PUT");
    const object = r2.objects.get(firstKey);
    const saved2 = await revisionText(note.id, 2).catch(() => "");
    pass(
      "R2에 서명된 PUT(SigV4 확인) → `![image](공개 주소)` → 자동 저장 r2",
      Boolean(put?.shape && put.signature && put.payload) && object?.type === "image/png" && object.cache.includes("immutable") && saved2.includes(link) && (await page.locator(".cm-image-pending").count()) === 0,
      `${put?.path} sig=${put?.signature} · ${saved2.split("\n").at(-2) ?? ""}`,
    );
    await shot("04-md-r2-link.png");

    // ── R2 refuses: toast, the work folder's assets/, a relative link ────
    r2.refuse = true;
    const second = png(index * 3 + 2);
    const secondName = `${sha256(Buffer.from(second.b64, "base64")).slice(0, 16)}.png`;
    await page.locator(".md-editor .cm-content").click();
    await page.keyboard.press("Control+End");
    await transfer(page, ".md-editor .cm-content", "paste", [second]);
    await until(async () => (await page.locator(".md-editor .cm-content").innerText()).includes(`![image](assets/${secondName})`), 10_000);
    const refusedToast = await toast();
    await waitSaved(page, 3);
    const localFile = join(cwd, "assets", secondName);
    pass(
      "R2가 거절하면 알림 + 작업 폴더 assets/에 저장하고 상대 링크",
      refusedToast.includes("R2에 올리지 못해") && refusedToast.includes("권한") && existsSync(localFile) && readFileSync(localFile).equals(Buffer.from(second.b64, "base64")),
      refusedToast.slice(0, 90),
    );
    await shot("05-md-fallback.png");
    r2.refuse = false;

    // ── a dropped picture; a text copy that also carries a picture ───────
    const third = png(index * 3 + 3, "강의 도식.png");
    const thirdKey = `workbench/${sha256(Buffer.from(third.b64, "base64")).slice(0, 16)}.png`;
    const lastLine = page.locator(".md-editor .cm-line").last();
    const box = (await lastLine.boundingBox())!;
    const dropped = await transfer(page, ".md-editor .cm-content", "drop", [third], {}, { x: box.x + box.width - 4, y: box.y + box.height / 2 });
    await until(async () => (await page.locator(".md-editor .cm-content").innerText()).includes(`![강의 도식](${r2Url}/public/${thirdKey})`), 10_000);
    pass("끌어 놓은 그림도 R2 링크로(이름이 대체 글)", dropped === "handled" && r2.objects.has(thirdKey));
    await page.locator(".md-editor .cm-content").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    const textPaste = await transfer(page, ".md-editor .cm-content", "paste", [png(9)], { "text/plain": "표에서 복사한 글", "text/html": "<table><tr><td>표에서 복사한 글</td></tr></table>" });
    await page.waitForTimeout(400);
    const afterText = await page.locator(".md-editor .cm-content").innerText();
    pass("글과 그림이 함께 복사된 경우는 글을 붙임", afterText.includes("표에서 복사한 글") && (afterText.match(/!\[/g) ?? []).length === 3 && (await page.locator(".cm-image-pending").count()) === 0, `paste=${textPaste}`);
    await waitSaved(page, 4);

    // ── the preview shows both kinds of pictures ─────────────────────────
    await page.locator(".document-view .segmented").getByRole("radio", { name: "미리보기" }).click();
    await page.waitForSelector(".doc-preview .markdown img");
    await until(async () => (await page.locator(".doc-preview .markdown img").count()) === 3, 8000);
    const shown = await page.locator(".doc-preview .markdown img").evaluateAll((images) =>
      (images as HTMLImageElement[]).map((image) => ({ src: image.getAttribute("src") ?? "", local: image.dataset.src ?? "", width: image.naturalWidth, complete: image.complete })),
    );
    await until(async () => (await page.locator(".doc-preview .markdown img").evaluateAll((images) => (images as HTMLImageElement[]).every((image) => image.complete && image.naturalWidth > 0))), 8000);
    const loaded = await page.locator(".doc-preview .markdown img").evaluateAll((images) => (images as HTMLImageElement[]).map((image) => image.naturalWidth));
    await page.waitForTimeout(300);
    await shot("06-md-preview.png");
    pass(
      "미리보기: R2 그림과 작업 폴더 그림(상대 경로) 모두 보임",
      loaded.length === 3 && loaded.every((width) => width > 0) && shown.some((image) => image.src.startsWith(r2Url)) && shown.some((image) => image.local === `assets/${secondName}` && image.src.startsWith("blob:")),
      shown.map((image) => `${image.local || image.src.slice(0, 40)}:${image.width}`).join(" · "),
    );
    const outside = (await fetch(`${ready.url}/api/artifacts/${note.id}/asset?src=${encodeURIComponent("../../../etc/passwd")}`, { headers: auth })).status;
    pass("작업 폴더 밖 경로는 미리보기 경로에서 거절", outside === 403 || outside === 415, `HTTP ${outside}`);

    await page.locator(".document-view .segmented").getByRole("radio", { name: "편집" }).click();

    // ── Hangul: the text view says it cannot take pictures ───────────────
    await api<Artifact>("POST", `/api/works/${work.id}/artifacts`, { path: "양식.hwpx" });
    await openDoc(page, "양식.hwpx");
    await page.locator(".document-view .segmented").getByRole("radio", { name: "글 편집" }).click();
    await page.waitForSelector(".doc-hangul-text .cm-content", { timeout: 10_000 });
    const hangulPaste = await transfer(page, ".doc-hangul-text .cm-content", "paste", [png(41)]);
    await until(async () => (await toast()).includes("HOP"), 3000);
    const hangulText = await page.locator(".doc-hangul-text .cm-content").innerText();
    await shot("10-hwpx.png");
    pass("한글(HWPX) 글 보기에 그림을 붙이면 넣지 않고 HOP에서 넣으라고 알림", hangulPaste === "handled" && (await toast()).includes("HOP") && !hangulText.includes("!["), await toast());
  } catch (error) {
    pass("실행", false, error instanceof Error ? error.message.split("\n")[0]! : String(error));
    await page.screenshot({ path: join(outDir, `${provider}-99-failure.png`) }).catch(() => undefined);
  } finally {
    await context.close();
  }
}

try {
  for (const [index, provider] of providers.entries()) await flow(provider, index);
} finally {
  writeFileSync(join(outDir, "console.log"), logs.join("\n"));
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
  await browser.close();
  child.kill();
  await new Promise((done) => (child.exitCode === null && child.signalCode === null ? child.once("exit", done) : done(null)));
  fake.close();
  for (const dir of [dataDir, worksDir, scratch]) rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} passed · console: ${logs.length ? logs.slice(0, 6).join(" | ") : "clean"}`);
  process.exitCode = failed ? 1 : 0;
}
