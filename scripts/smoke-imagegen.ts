// One real drawing through the real Codex (uses the user's ChatGPT image quota: one small picture
// and one short turn). Claude is the stand-in: only Codex's image tool is under test. Checks that
// the picture comes back as an image item, lands in the work folder as a real image, and that
// Codex neither ran a command nor asked for anything while drawing.
// Usage: node scripts/smoke-imagegen.ts [outDir]

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { ImageInfo, ProviderStatus, Session, TranscriptItem, Work } from "@workbench/contracts";

const outDir = process.argv[2] ?? join(tmpdir(), "wb-smoke-imagegen");
mkdirSync(outDir, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "workbench-smoke-imagegen-"));
const worksDir = mkdtempSync(join(tmpdir(), "workbench-smoke-imagegen-works-"));
const results: { step: string; ok: boolean; detail: string }[] = [];
const check = (step: string, ok: boolean, detail = "") => {
  results.push({ step, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
};

const child = spawn(process.execPath, ["apps/host/src/main.ts"], {
  env: { ...process.env, WORKBENCH_DATA_DIR: dataDir, WORKBENCH_HOST_LABEL: "노트북", WORKBENCH_CLAUDE_BIN: resolve("scripts/fixtures/fake-claude.mjs") },
  stdio: ["ignore", "pipe", "inherit"],
});
const ready = await new Promise<{ url: string; token: string }>((done) => {
  createInterface({ input: child.stdout! }).on("line", (line) => {
    if (line.startsWith("WORKBENCH_READY ")) done(JSON.parse(line.slice(16)));
  });
});
const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${ready.url}${path}`, { method, headers: { authorization: `Bearer ${ready.token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await response.json()) as T & { message?: string };
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${json.message ?? ""}`);
  return json;
};
const items = async (id: string) => (await api<{ items: TranscriptItem[] }>("GET", `/api/sessions/${id}/items`)).items;

try {
  await api("POST", "/api/providers/refresh");
  const codex = (await api<{ providers: ProviderStatus[] }>("GET", "/api/snapshot")).providers.find((status) => status.provider === "codex");
  check("실제 Codex 로그인과 그림 기능", Boolean(codex?.loggedIn) && codex?.imageGeneration !== false, `${codex?.binary} ${codex?.version} · ${codex?.loginMethod}/${codex?.plan} · imageGeneration=${codex?.imageGeneration}`);

  const work = await api<Work>("POST", "/api/works", { title: "그림 확인", cwd: worksDir });
  // "묻기": anything beyond the image tool would have to ask first.
  const session = await api<Session>("POST", `/api/works/${work.id}/sessions`, { provider: "codex", purpose: "그림 확인", access: "ask" });
  const started = Date.now();
  const sent = await api<{ image: ImageInfo }>("POST", `/api/sessions/${session.id}/images`, {
    requestId: `smoke-${started}`,
    brief: "흰 바탕 가운데에 파란 원 하나. 글자 없는 단순한 평면 아이콘.",
    aspect: "square",
  });
  let image = sent.image;
  const declined: string[] = [];
  while (image.status === "drawing" && Date.now() - started < 6 * 60_000) {
    await new Promise((done) => setTimeout(done, 2000));
    image = await api<ImageInfo>("GET", `/api/images/${encodeURIComponent(image.id)}`);
    for (const item of await items(session.id)) {
      if (item.kind === "approval" && item.decision === null) {
        declined.push(`${item.title} ${item.detail ?? ""}`);
        await api("POST", `/api/sessions/${session.id}/approvals/${encodeURIComponent(item.id)}`, { decision: "decline" }).catch(() => undefined);
      }
    }
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  check("그림이 끝남", image.status === "done", `${image.status} · ${seconds}초${image.error ? ` · ${image.error}` : ""}`);
  const file = image.path && existsSync(image.path) ? readFileSync(image.path) : null;
  const magic = file ? file.subarray(0, 4).toString("hex") : "";
  check("작업 폴더 images/에 진짜 그림 파일", Boolean(file && (magic === "89504e47" || magic.startsWith("ffd8ff") || magic === "52494646")), `${image.relPath} · ${image.width}×${image.height} · ${image.bytes} bytes · magic ${magic}`);

  // Wait for the turn to end, then look at what Codex did in it.
  const end = Date.now() + 60_000;
  while (Date.now() < end && (await api<{ sessions: Session[] }>("GET", "/api/snapshot")).sessions.find((entry) => entry.id === session.id)?.status !== "idle") {
    await new Promise((done) => setTimeout(done, 1000));
  }
  const all = await items(session.id);
  const tools = all.filter((item): item is Extract<TranscriptItem, { kind: "tool" }> => item.kind === "tool");
  check("명령 실행·파일 복사·승인 요청 없이 그림만", tools.length === 0 && declined.length === 0, `tools=${tools.map((tool) => `${tool.tool}:${tool.title}`).join(", ") || "없음"} · approvals=${declined.join(" | ") || "없음"}`);
  const answer = all.filter((item) => item.kind === "assistant").map((item) => (item.kind === "assistant" ? item.text : "")).join(" ");
  const cards = all.filter((item) => item.kind === "image").length;
  check("대화에 그림 카드 하나와 짧은 설명", cards === 1, `cards=${cards} · 답: ${answer.slice(0, 120)}`);
  const native = (await api<{ sessions: Session[] }>("GET", "/api/snapshot")).sessions.find((entry) => entry.id === session.id)?.nativeSessionId;
  const codexFolder = native ? join(homedir(), ".codex", "generated_images", native) : "";
  const leftovers = readdirSync(worksDir).filter((name) => name !== "images");
  check("작업 폴더에는 images/ 말고 새 파일 없음", leftovers.length === 0, `작업 폴더: ${readdirSync(worksDir).join(", ")} · Codex 보관 폴더 ${codexFolder && existsSync(codexFolder) ? readdirSync(codexFolder).join(", ") : "(없음)"}`);
  writeFileSync(join(outDir, "image.json"), JSON.stringify({ ...image, prompt: image.prompt }, null, 2));
  if (file && image.relPath) writeFileSync(join(outDir, `real-${image.relPath.split("/").pop()}`), file);
} catch (error) {
  check("실행", false, error instanceof Error ? error.message : String(error));
} finally {
  writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
  child.kill();
  await new Promise((done) => (child.exitCode === null && child.signalCode === null ? child.once("exit", done) : done(null)));
  for (const dir of [dataDir, worksDir]) rmSync(dir, { recursive: true, force: true });
  const failed = results.filter((result) => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
