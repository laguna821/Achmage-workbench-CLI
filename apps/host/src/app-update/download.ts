// Plain HTTPS to github.com only (no login, nothing about the person is sent): the manifest, its signature
// and the installer. Redirects are followed by hand and only to GitHub's own download hosts; every read
// has a size cap and a timeout; the installer is hashed while it streams and kept only when its size and
// SHA-256 equal the signed manifest's.
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, renameSync, rmSync, statfsSync } from "node:fs";
import { dirname } from "node:path";
import { UPDATE_SOURCE, UpdateRefused, type UpdateAsset } from "./manifest.ts";

export const GITHUB_DOWNLOAD_HOSTS = ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "github-releases.githubusercontent.com"];
export type UpdateSource = { base: URL; allowed(url: URL): boolean };
export type Fetch = typeof fetch;

export const NETWORK = "인터넷에 연결되지 않았습니다. 연결을 확인한 뒤 다시 눌러 주세요.";
export const SOURCE = "GitHub가 업데이트 정보를 제대로 주지 않았습니다. 잠시 뒤 다시 눌러 주세요.";
export const MISMATCH = "내려받은 파일이 게시된 것과 다릅니다. 설치하지 않았습니다.";

/**
 * The fixed source. A test may point it elsewhere with WORKBENCH_UPDATE_SOURCE (https, or http on this
 * computer only); then redirects must stay on that origin. The signature rule is not touched by this.
 */
export function updateSource(env: NodeJS.ProcessEnv = process.env): UpdateSource {
  const override = env.WORKBENCH_UPDATE_SOURCE;
  if (!override) return { base: new URL(UPDATE_SOURCE), allowed: url => url.protocol === "https:" && !url.username && !url.password && url.port === "" && GITHUB_DOWNLOAD_HOSTS.includes(url.hostname) };
  const base = new URL(override.endsWith("/") ? override : `${override}/`);
  const local = base.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
  if (base.protocol !== "https:" && !local) throw new UpdateRefused("source", "업데이트 주소는 https만 씁니다.");
  return { base, allowed: url => url.origin === base.origin && !url.username && !url.password };
}

async function follow(source: UpdateSource, start: URL, timeoutMs: number, fetchImpl: Fetch, signal?: AbortSignal): Promise<Response> {
  let url = start;
  for (let hop = 0; hop <= 5; hop++) {
    if (!source.allowed(url)) throw new UpdateRefused("source", SOURCE);
    let response: Response;
    try {
      response = await fetchImpl(url, { redirect: "manual", headers: { accept: "application/octet-stream", "user-agent": "AchmageWorkbench-update" }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new UpdateRefused("network", NETWORK);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new UpdateRefused("source", SOURCE);
      url = new URL(location, url);
      continue;
    }
    if (response.status !== 200) { await response.body?.cancel().catch(() => undefined); throw new UpdateRefused("source", SOURCE); }
    return response;
  }
  throw new UpdateRefused("source", SOURCE);
}

/** A small file (the manifest, the signature), read whole up to `max` bytes. */
export async function fetchSmall(source: UpdateSource, name: string, max: number, fetchImpl: Fetch = fetch, timeoutMs = 15_000): Promise<Buffer> {
  const response = await follow(source, new URL(name, source.base), timeoutMs, fetchImpl);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > max) { await response.body?.cancel().catch(() => undefined); throw new UpdateRefused("size", SOURCE); }
  const chunks: Buffer[] = []; let total = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total > max) throw new UpdateRefused("size", SOURCE);
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) { if (error instanceof UpdateRefused) throw error; throw new UpdateRefused("network", NETWORK); }
  return Buffer.concat(chunks);
}

export function freeBytes(dir: string): number {
  try { const stats = statfsSync(dir); return Number(stats.bavail) * Number(stats.bsize); } catch { return Number.POSITIVE_INFINITY; }
}
export const NO_ROOM = "저장 공간이 부족합니다. 디스크에서 공간을 비운 뒤 다시 눌러 주세요.";

/**
 * The installer, streamed to `<target>.partial`, kept as `target` only when its size and SHA-256 equal the
 * manifest's. Anything else removes the partial file; nothing is installed from it.
 */
export async function downloadAsset(source: UpdateSource, asset: UpdateAsset, target: string, options: { fetch?: Fetch; onProgress?(fraction: number): void; signal?: AbortSignal; idleMs?: number; roomFactor?: number } = {}) {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  if (freeBytes(dirname(target)) < asset.size * (options.roomFactor ?? 2)) throw new UpdateRefused("space", NO_ROOM);
  const partial = `${target}.partial`;
  rmSync(partial, { force: true });
  const response = await follow(source, new URL(asset.name, source.base), 30_000, options.fetch ?? fetch, options.signal);
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) !== asset.size) { await response.body?.cancel().catch(() => undefined); throw new UpdateRefused("size", MISMATCH); }
  const hash = createHash("sha256"), out = createWriteStream(partial, { mode: 0o600 });
  let total = 0, lastReport = -1;
  const failed = (error: unknown) => { out.destroy(); rmSync(partial, { force: true }); return error; };
  try {
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      let idle: NodeJS.Timeout | undefined;
      const next = await Promise.race([reader.read(), new Promise<never>((_, reject) => { idle = setTimeout(() => reject(new UpdateRefused("network", NETWORK)), options.idleMs ?? 60_000); })]).finally(() => clearTimeout(idle));
      if (next.done) break;
      total += next.value.length;
      if (total > asset.size) { await reader.cancel().catch(() => undefined); throw new UpdateRefused("size", MISMATCH); }
      hash.update(next.value);
      if (!out.write(next.value)) await new Promise(resolve => out.once("drain", resolve));
      const percent = Math.floor(total / asset.size * 100);
      if (percent !== lastReport) { lastReport = percent; options.onProgress?.(total / asset.size); }
    }
    await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => error ? reject(error) : resolve()));
  } catch (error) {
    if (error instanceof UpdateRefused) throw failed(error);
    if ((error as NodeJS.ErrnoException)?.code === "ENOSPC") throw failed(new UpdateRefused("space", NO_ROOM));
    if (options.signal?.aborted) throw failed(error);
    throw failed(new UpdateRefused("network", NETWORK));
  }
  if (total !== asset.size || hash.digest("hex") !== asset.sha256) { rmSync(partial, { force: true }); throw new UpdateRefused("checksum", MISMATCH); }
  renameSync(partial, target);
  return target;
}
