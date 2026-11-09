// Record the bytes CI actually built. Promotion reuses these files; it never rebuilds them.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const suffixes = [".exe", ".msi", ".dmg", ".deb", ".AppImage", ".pkg.tar.zst"] as const;
export type Asset = { name: string; artifactName: string; bytes: number; sha256: string };
type Check = { state: "PASS" | "FAIL" | "NOT_RUN"; checks: number; detail: string };
type Identity = { sourceRun: string; sourceSha: string; acceptanceSha: string; sha256: string; artifactName: string };

export const filesUnder = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? filesUnder(join(dir, entry.name)) : entry.isFile() ? [join(dir, entry.name)] : []) : [];
export async function hashFile(path: string) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: hash.digest("hex") };
}

export function assertAssets(assets: Asset[]) {
  if (assets.length !== suffixes.length || new Set(assets.map(a => a.name)).size !== assets.length) throw Error("Expected six unique installer names");
  for (const suffix of suffixes) if (assets.filter(a => a.name.endsWith(suffix)).length !== 1) throw Error(`Missing or duplicate installer: ${suffix}`);
  for (const asset of assets) if (!Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw Error(`Invalid installer bytes/hash: ${asset.name}`);
}

export function inspectChecks(rows: unknown, minimum: number): Check {
  if (rows === null) return { state: "NOT_RUN", checks: 0, detail: "Acceptance output is absent" };
  if (!Array.isArray(rows) || rows.length < minimum || rows.some(row => !row || typeof row !== "object" || row.ok !== true)) {
    return { state: "FAIL", checks: Array.isArray(rows) ? rows.length : 0, detail: "Acceptance did not complete successfully" };
  }
  return { state: "PASS", checks: rows.length, detail: "Installed application checks passed with stand-in AI engines" };
}

export function bindInstaller(check: Check, identity: Identity | null, asset: Asset | undefined, sourceRun: string, sourceSha: string): Check {
  if (!identity || !asset || identity.sourceRun !== sourceRun || identity.sourceSha !== sourceSha || !/^[a-f0-9]{40}$/.test(identity.acceptanceSha)
    || identity.sha256.replace(/^sha256:/, "") !== asset.sha256 || identity.artifactName.replaceAll(" ", ".") !== asset.name) {
    return { ...check, state: "FAIL", detail: "Acceptance does not identify these installer bytes and source" };
  }
  return check;
}

const readJson = <T>(path: string): T | null => existsSync(path) ? JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as T : null;

export async function collectCandidate(input: { root: string; output: string; sourceRun: string; sourceSha: string; requireChecks?: boolean }) {
  if (!/^\d+$/.test(input.sourceRun) || !/^[a-f0-9]{40}$/.test(input.sourceSha)) throw Error("Exact source run and commit required");
  const paths = filesUnder(input.root).filter(path => suffixes.some(suffix => path.endsWith(suffix))).sort();
  const assets = await Promise.all(paths.map(async path => ({ name: basename(path).replaceAll(" ", "."), artifactName: basename(path), ...await hashFile(path) })));
  assertAssets(assets);
  const acceptance: Record<string, Check> = {};
  const acceptanceShas = new Set<string>();
  for (const [platform, suffix] of [["windows", ".exe"], ["macos", ".dmg"]] as const) {
    const dir = join(input.root, `smoke-${platform}`);
    const identity = readJson<Identity>(join(dir, "installer-source.json"));
    acceptance[`firstRun:${platform}`] = bindInstaller(inspectChecks(readJson(join(dir, "setup-smoke.json")), 20), identity,
      assets.find(a => a.name.endsWith(suffix)), input.sourceRun, input.sourceSha);
    if (identity?.acceptanceSha) acceptanceShas.add(identity.acceptanceSha);
  }
  const upgradeDir = join(input.root, "upgrade-windows");
  const upgradeIdentity = readJson<Identity>(join(upgradeDir, "installer-source.json"));
  let upgrade = bindInstaller(inspectChecks(readJson(join(upgradeDir, "verify-results.json")), 17), upgradeIdentity,
    assets.find(a => a.name.endsWith(".exe")), input.sourceRun, input.sourceSha);
  const after = readJson<{ remainingLegacyFiles?: string[] }>(join(upgradeDir, "after-summary.json"));
  const newInstaller = readJson<{ sha256?: string }>(join(upgradeDir, "new-installer.json"));
  const oldInstaller = readJson<{ tag?: string }>(join(upgradeDir, "old-installer.json"));
  if (!Array.isArray(after?.remainingLegacyFiles) || after.remainingLegacyFiles.length || !oldInstaller?.tag
    || newInstaller?.sha256 !== `sha256:${assets.find(a => a.name.endsWith(".exe"))?.sha256}`) {
    upgrade = { ...upgrade, state: "FAIL", detail: "Upgrade preservation or installed artifact identity is incomplete" };
  }
  acceptance["upgrade:windows"] = upgrade;
  if (upgradeIdentity?.acceptanceSha) acceptanceShas.add(upgradeIdentity.acceptanceSha);
  const scope = readJson<Record<string, unknown>>(fileURLToPath(new URL("../../packaging/release-scope.json", import.meta.url)));
  const manifest = { schemaVersion: 1, sourceRun: input.sourceRun, sourceSha: input.sourceSha, acceptanceShas: [...acceptanceShas],
    createdAt: new Date().toISOString(), scope, upgradeFrom: oldInstaller?.tag ?? null, acceptance, assets };
  mkdirSync(input.output, { recursive: true });
  writeFileSync(join(input.output, "installer-provenance.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(input.output, "SHA256SUMS.txt"), assets.map(a => `${a.sha256}  ${a.name}\n`).join(""));
  writeFileSync(join(input.output, "preview-notes.md"), [
    `# Achmage Workbench ${scope?.applicationVersion ?? "0.4.0"} 설치 파일`, "", String(scope?.label ?? "통합 설치 후보"), "",
    `- 소스: ${input.sourceSha}`, `- 빌드: ${input.sourceRun}`, `- Windows 업데이트 기준: ${manifest.upgradeFrom ?? "미확인"}`,
    ...Object.entries(acceptance).map(([name, check]) => `- ${name}: ${check.state} (${check.checks}개)`),
    "", "## 포함 범위", "", ...((scope?.implemented as string[] | undefined) ?? []).map(s => `- ${s}`),
    "", "## 남은 작업", "", ...[...((scope?.inProgress as string[] | undefined) ?? []), ...((scope?.remaining as string[] | undefined) ?? []),
      ...((scope?.limitations as string[] | undefined) ?? [])].map(s => `- ${s}`), "",
    "| 설치 파일 | 크기 |", "|---|---:|", ...assets.map(a => `| ${a.name} | ${(a.bytes / 1024 ** 2).toFixed(1)} MiB |`), "",
  ].join("\n"));
  if (input.requireChecks && Object.values(acceptance).some(check => check.state !== "PASS")) throw Error("Install checks have not accepted these candidate bytes; see installer-provenance.json");
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await collectCandidate({ root: resolve(process.argv[2] ?? "out"), output: resolve(process.argv[3] ?? "candidate"),
    sourceRun: process.env.SOURCE_RUN ?? process.env.GITHUB_RUN_ID ?? "", sourceSha: process.env.SOURCE_SHA ?? process.env.GITHUB_SHA ?? "",
    requireChecks: process.argv.includes("--require-install-checks") });
}
