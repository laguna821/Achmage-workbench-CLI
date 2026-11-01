// Cross-platform acceptance against an installed app's native worker and bundled host.
// The disposable gateway/work directory is owned by setup-smoke; no user vault is attached.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SearchPage, SearchPreview, TranscriptItem } from "@workbench/contracts";
import { appLayout, client, type Gateway } from "./setup-gateway.ts";

export async function checkFastFindInstalled(gateway: Gateway, app: string, root: string, workId: string,
  check: (step: string, ok: boolean, detail?: string) => void) {
  const { call } = client(gateway);
  const step = async (name: string, run: () => Promise<boolean>) => {
    try { check(`Fast Find: ${name}`, await run(), `${process.platform}/${process.arch}`); }
    catch (error) { check(`Fast Find: ${name}`, false, String(error)); }
  };
  const search = (query: string, extra = "") => call<SearchPage>("GET", `/api/search?q=${encodeURIComponent(query)}&legacy=0${extra}`);
  const wait = async (condition: () => Promise<boolean>) => {
    const end = Date.now() + 15_000;
    do { if (await condition()) return true; await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < end);
    return false;
  };
  await step("설치 실행 파일의 내장 Rust 검색 엔진", async () => {
    const input = [JSON.stringify({ version: 1, id: 1, op: "status" }), JSON.stringify({ version: 1, id: 2, op: "shutdown" }), ""].join("\n");
    const lines = execFileSync(appLayout(app).native, ["--search-worker"], { input, encoding: "utf8", timeout: 30_000, windowsHide: true }).trim().split(/\r?\n/).map(line => JSON.parse(line));
    return lines.some(row => row.id === 1 && row.result?.upstream === "714548efd3e361a7011a5123f4ae928630a01614" && row.result?.protocol === 1);
  });
  await step("메인 세션 검색과 원본 메시지 식별자", async () => {
    const page = await search("안녕하세요", `&scope=session&workId=${encodeURIComponent(workId)}`);
    const hit = page.groups.flatMap(group => group.hits).find(hit => hit.kind === "user");
    if (!hit?.sessionId || !hit.itemId || page.engine !== "fast-find") return false;
    const transcript = await call<{ items: TranscriptItem[] }>("GET", `/api/sessions/${hit.sessionId}/items`);
    return transcript.items.some(item => item.id === hit.itemId && item.kind === "user" && item.text === "안녕하세요");
  });
  const vault = join(root, "search-vault"), path = "한글 연구.md";
  mkdirSync(join(vault, ".obsidian/plugins/notebook-navigator"), { recursive: true });
  mkdirSync(join(vault, "비밀"), { recursive: true });
  writeFileSync(join(vault, ".obsidian/app.json"), "{}");
  writeFileSync(join(vault, ".obsidian/plugins/notebook-navigator/data.json"), JSON.stringify({ vaultProfile: "default", vaultProfiles: [{ id: "default", hiddenFolders: ["비밀"] }] }));
  const raw = '---\ntitle: 한글 연구\naliases: [설치검색별칭]\n"단계:": ["🔵 I"]\ntags: [연구]\n---\n# 📝 검토\n\n설치검색고유표식과 채점 기준을 확인합니다.\n';
  writeFileSync(join(vault, path), raw);
  writeFileSync(join(vault, "비밀/숨김.md"), "설치검색고유표식 숨김비밀표식");
  await call("PUT", "/api/pkm/vault", { path: vault });
  let key = "";
  await step("연결 볼트·별칭·콜론 속성·숨김 범위", async () => {
    const properties = encodeURIComponent(JSON.stringify([{ key: "단계:", value: "🔵 I" }]));
    const page = await search("설치검색별칭", `&scope=vault&properties=${properties}`);
    const hit = page.groups.flatMap(group => group.hits)[0]; key = hit?.key ?? "";
    return page.engine === "fast-find" && page.total === 1 && hit?.path === path && (await search("숨김비밀표식")).total === 0;
  });
  await step("한글 본문 미리보기와 같은 원본 파일 열기", async () => {
    const page = await search("채점 기준", "&scope=vault");
    const hit = page.groups.flatMap(group => group.hits)[0];
    if (!hit) return false;
    const preview = await call<SearchPreview>("GET", `/api/search/preview?key=${encodeURIComponent(hit.key)}&scope=vault&line=${hit.line ?? 1}`);
    const note = await call<{ text: string }>("GET", `/api/pkm/vault/note?path=${encodeURIComponent(hit.path!)}`);
    await call("POST", `/api/search/open?key=${encodeURIComponent(hit.key)}&q=${encodeURIComponent(page.query)}`);
    return preview.found && preview.text?.includes("설치검색고유표식") === true && JSON.stringify(note).includes("설치검색고유표식") && readFileSync(join(vault, path), "utf8") === raw;
  });
  await step("외부 수정·이름 변경·삭제를 실제 파일 감시로 반영", async () => {
    writeFileSync(join(vault, path), raw + "\n외부수정검증표식\n");
    if (!await wait(async () => (await search("외부수정검증표식", "&scope=vault")).total === 1)) return false;
    renameSync(join(vault, path), join(vault, "변경.md"));
    if (!await wait(async () => (await search("외부수정검증표식", "&scope=vault")).groups.flatMap(group => group.hits).some(hit => hit.path === "변경.md"))) return false;
    const old = await call<SearchPreview>("GET", `/api/search/preview?key=${encodeURIComponent(key)}&scope=vault`);
    unlinkSync(join(vault, "변경.md"));
    return !old.found && await wait(async () => (await search("외부수정검증표식", "&scope=vault")).total === 0);
  });
  await call("DELETE", "/api/pkm/vault");
}
