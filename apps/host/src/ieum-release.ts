import { parseDocument } from "yaml";

export const IEUM_RELEASE_ROOT = "https://github.com/pblsketch/openoffice/releases";
export type DesktopRelease = { tag_name: string; assets: { name: string; browser_download_url: string; digest: string | null; size: number }[] };
const tagPattern = /^v?\d+\.\d+\.\d+(?:[-.][\w.-]+)?$/;
export const updaterName = (platform: NodeJS.Platform) => platform === "win32" ? "latest.yml" : platform === "darwin" ? "latest-mac.yml" : platform === "linux" ? "latest-linux.yml" : null;
export function installerName(version: string, platform: NodeJS.Platform, arch: string) {
  return platform === "win32" && ["x64", "arm64"].includes(arch) ? `IeumOffice-Setup-${version}.exe`
    : platform === "darwin" && ["x64", "arm64"].includes(arch) ? `IeumOffice-${version}${arch === "arm64" ? "-arm64" : ""}-mac.zip`
    : platform === "linux" && arch === "x64" ? `IeumOffice-${version}.AppImage` : null;
}
export const validSha512 = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9+/]{86}==$/.test(value) && Buffer.from(value, "base64").length === 64;

/** The official updater manifest is an independent published checksum source, not an
 * unchecked download fallback. Resolve latest to a tag first so version and bytes stay pinned. */
export function releaseFromManifest(tag: string, text: string, platform: NodeJS.Platform, arch: string): DesktopRelease {
  if (!tagPattern.test(tag) || text.length > 256_000) throw new Error("공식 배포 정보가 올바르지 않습니다.");
  const document = parseDocument(text, { uniqueKeys: true, logLevel: "silent" });
  if (document.errors.length || document.warnings.length) throw new Error("공식 체크섬 정보를 읽지 못했습니다.");
  const manifest = document.toJS({ maxAliasCount: 0 }) as { version?: unknown; files?: { url?: unknown; sha512?: unknown; size?: unknown }[] };
  const version = tag.replace(/^v/, ""), name = installerName(version, platform, arch), updater = updaterName(platform);
  if (manifest?.version !== version || !name || !updater || !Array.isArray(manifest.files)) throw new Error("이 OS의 공식 설치 정보를 확인하지 못했습니다.");
  const matches = manifest.files.filter(file => file?.url === name);
  const file = matches[0];
  if (matches.length !== 1 || !file || !validSha512(file.sha512) || !Number.isSafeInteger(file.size) || Number(file.size) < 1 || Number(file.size) > 1_500_000_000) throw new Error("공식 설치 파일의 크기·체크섬이 없습니다.");
  return { tag_name: tag, assets: [
    { name, browser_download_url: `${IEUM_RELEASE_ROOT}/download/${tag}/${name}`, digest: `sha512:${file.sha512}`, size: Number(file.size) },
    { name: updater, browser_download_url: `${IEUM_RELEASE_ROOT}/download/${tag}/${updater}`, digest: null, size: Buffer.byteLength(text) },
  ] };
}

export async function latestDesktopRelease(platform: NodeJS.Platform = process.platform, arch = process.arch, request: typeof fetch = fetch): Promise<DesktopRelease> {
  try {
    const response = await request("https://api.github.com/repos/pblsketch/openoffice/releases/latest", { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`GitHub API ${response.status}`);
    const release = await response.json() as DesktopRelease;
    if (!tagPattern.test(release.tag_name) || !Array.isArray(release.assets)) throw new Error("Invalid release metadata");
    return release;
  } catch {
    // Shared networks/CI can exhaust GitHub's anonymous API quota. The official release
    // page and updater assets remain public; no account token is requested or forwarded.
    const page = await request(`${IEUM_RELEASE_ROOT}/latest`, { method: "HEAD", signal: AbortSignal.timeout(30_000) });
    const prefix = `${IEUM_RELEASE_ROOT}/tag/`, tag = page.url.startsWith(prefix) ? page.url.slice(prefix.length) : "";
    const updater = updaterName(platform);
    if (!page.ok || !tagPattern.test(tag) || !updater) throw new Error("공식 이음오피스 최신 배포를 확인하지 못했습니다.");
    const response = await request(`${IEUM_RELEASE_ROOT}/download/${tag}/${updater}`, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`공식 체크섬 정보를 받지 못했습니다 (${response.status}).`);
    return releaseFromManifest(tag, await response.text(), platform, arch);
  }
}
