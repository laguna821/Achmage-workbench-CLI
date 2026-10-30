import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { ScmJob, ScmPushPreview, ScmRemoteInventory, ScmRemoteRequest, ScmRemoteResult, ScmStatus } from "@workbench/contracts";
import { HttpError } from "./errors.ts";
import { scmText, type GitOptions } from "./scm-git.ts";
import { scmHash } from "./scm-status.ts";

export const remoteAction = (action: string) => ["fetch", "pull", "push"].includes(action);
/** A configured relative filesystem URL must not become the name of another remote. */
function executionUrl(root: string, url: string) {
  return isAbsolute(url) || /^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^[^/]+::/.test(url) || /^[^/]+:.+/.test(url) ? url : resolve(root, url);
}
/** Keep configured credentials out of durable jobs and the review UI. */
export function redactGit(text: string) {
  return text.replace(/\b(https?|ssh):\/\/[^\s<>"']+/gi, (value) => {
    try { const url = new URL(value); if (url.protocol !== "ssh:" || url.password) { url.username = url.username ? "***" : ""; url.password = ""; } if (url.search) url.search = "?redacted"; return url.toString(); } catch { return value.replace(/\/\/[^/]+@/, "//***@"); }
  });
}
export function validateRemoteRequest(value: ScmRemoteRequest | undefined): ScmRemoteRequest {
  if (!value || typeof value.remote !== "string" || !value.remote || value.remote.startsWith("-") || /[\x00-\x20\x7f]/.test(value.remote) || value.remote.length > 200 || typeof value.branch !== "string" || !value.branch || value.branch.length > 500 || value.branch.startsWith("-") || /[\x00-\x20\x7f]/.test(value.branch) || typeof value.expectedRevision !== "string" || !/^[a-f0-9]{64}$/.test(value.expectedRevision)) throw new HttpError(400, "scm_remote", "원격 저장소·브랜치와 최신 원격 설정이 필요합니다.");
  if (value.strategy !== undefined && !["ff-only", "merge", "rebase"].includes(value.strategy) || value.setUpstream !== undefined && typeof value.setUpstream !== "boolean" || value.forcePreviewId !== undefined && (typeof value.forcePreviewId !== "string" || !/^[a-zA-Z0-9-]{36}$/.test(value.forcePreviewId))) throw new HttpError(400, "scm_remote_options", "원격 작업 옵션을 다시 선택하세요.");
  return { remote: value.remote, branch: value.branch, expectedRevision: value.expectedRevision, ...(value.strategy ? { strategy: value.strategy } : {}), ...(value.setUpstream !== undefined ? { setUpstream: value.setUpstream } : {}), ...(value.forcePreviewId ? { forcePreviewId: value.forcePreviewId } : {}) };
}

export async function readRemotes(state: ScmStatus) {
  const raw = await scmText(state.root, ["config", "--null", "--get-regexp", "^(remote\\.|branch\\.|url\\.|push\\.|pull\\.|rebase\\.|merge\\.|submodule\\.|protocol\\.)"], { accepted: [0, 1] });
  const config = new Map<string, string[]>();
  for (const entry of raw.split("\0").filter(Boolean)) { const at = entry.indexOf("\n"), key = entry.slice(0, at), value = entry.slice(at + 1); if (at < 0) throw new Error("Git 원격 설정을 읽지 못했습니다."); if (/^remote\..*\.(?:url|pushurl)$/.test(key) && /[\r\n]/.test(value)) throw new HttpError(400, "scm_remote_urls", "개행이 들어 있는 원격 주소는 사용할 수 없습니다."); config.set(key, [...config.get(key) ?? [], value]); }
  const get = (key: string) => config.get(key)?.at(-1);
  const names = [...new Set([...config.keys()].flatMap((key) => { const match = key.match(/^remote\.(.+)\.(?:url|pushurl)$/); return match ? [match[1]!] : []; }))].sort();
  if (names.length > 100) throw new HttpError(413, "scm_remotes", "원격 저장소가 100개를 넘습니다.");
  const remotes: { name: string; fetchUrls: string[]; pushUrls: string[]; uploadPack?: string; receivePack?: string; proxy?: string; proxyAuthMethod?: string; serverOptions: string[] }[] = [];
  for (const name of names) {
    if (/[\x00-\x20\x7f]/.test(name) || name.startsWith("-")) continue;
    const [fetch, push] = await Promise.all([scmText(state.root, ["remote", "get-url", "--all", "--", name]), scmText(state.root, ["remote", "get-url", "--push", "--all", "--", name])]);
    const fetchUrls = [...new Set(fetch.replace(/\n$/, "").split("\n").filter(Boolean).map((url) => executionUrl(state.root, url)))], pushUrls = [...new Set(push.replace(/\n$/, "").split("\n").filter(Boolean).map((url) => executionUrl(state.root, url)))];
    if ([...fetchUrls, ...pushUrls].some((url) => /[\r\n\0]/.test(url)) || pushUrls.length > 20) throw new HttpError(400, "scm_remote_urls", "원격 URL 형식이나 개수를 확인하세요.");
    remotes.push({ name, fetchUrls, pushUrls, uploadPack: get(`remote.${name}.uploadpack`), receivePack: get(`remote.${name}.receivepack`), proxy: get(`remote.${name}.proxy`), proxyAuthMethod: get(`remote.${name}.proxyauthmethod`), serverOptions: config.get(`remote.${name}.serveroption`) ?? [] });
  }
  const branch = state.branch, pullRemote = branch ? get(`branch.${branch}.remote`) : undefined, mergeRef = branch ? get(`branch.${branch}.merge`) : undefined;
  const pullTarget = pullRemote && remotes.some((r) => r.name === pullRemote) && mergeRef?.startsWith("refs/heads/") ? { remote: pullRemote, branch: mergeRef.slice(11) } : null;
  const preferred = branch ? get(`branch.${branch}.pushremote`) ?? get("remote.pushdefault") ?? pullTarget?.remote : null;
  const chosen = preferred && remotes.some((r) => r.name === preferred) ? preferred : remotes.find((r) => r.name === "origin")?.name ?? remotes[0]?.name;
  const pushTarget = branch && chosen ? { remote: chosen, branch: pullTarget?.remote === chosen ? pullTarget.branch : branch } : null;
  const revision = scmHash(JSON.stringify([raw, remotes, branch, pullTarget, pushTarget]));
  const inventory: ScmRemoteInventory = { revision, remotes: remotes.map((remote) => ({ name: remote.name, fetchUrls: remote.fetchUrls.map(redactGit), pushUrls: remote.pushUrls.map(redactGit) })), pullTarget, pushTarget };
  return { inventory, remotes };
}

type PreviewEntry = { preview: ScmPushPreview; urls: string[] };
export class ScmRemotes {
  private readonly previews = new Map<string, PreviewEntry>();
  private readonly probes = new Map<string, { abort: AbortController; done: Promise<ScmPushPreview> }>();
  private stopped = false;
  async inspect(state: ScmStatus) { return (await readRemotes(state)).inventory; }
  private async target(state: ScmStatus, request: ScmRemoteRequest) {
    const read = await readRemotes(state);
    if (read.inventory.revision !== request.expectedRevision) throw new HttpError(409, "scm_remote_changed", "원격 주소나 브랜치 설정이 바뀌었습니다. 대상을 다시 확인하세요.");
    const remote = read.remotes.find((entry) => entry.name === request.remote);
    if (!remote) throw new HttpError(404, "scm_remote_missing", "선택한 원격 저장소가 없습니다.");
    await scmText(state.root, ["check-ref-format", `refs/heads/${request.branch}`]);
    await scmText(state.root, ["check-ref-format", `refs/remotes/${request.remote}/${request.branch}`]);
    return remote;
  }
  preview(state: ScmStatus, value: ScmRemoteRequest): Promise<ScmPushPreview> {
    if (this.stopped) return Promise.reject(new Error("앱이 종료 중입니다."));
    const id = randomUUID(), abort = new AbortController();
    const done = this.probe(state, value, AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)])).finally(() => this.probes.delete(id));
    this.probes.set(id, { abort, done }); return done;
  }
  private async probe(state: ScmStatus, value: ScmRemoteRequest, signal: AbortSignal): Promise<ScmPushPreview> {
    const request = validateRemoteRequest(value), remote = await this.target(state, request);
    if (!state.head || !state.branch || state.operation) throw new HttpError(409, "scm_push_state", "정상 브랜치의 커밋을 확인한 뒤 보내세요.");
    const destinations: ScmPushPreview["destinations"] = [];
    for (const url of remote.pushUrls) {
      const result = await scmText(state.root, ["-c", "protocol.ext.allow=never", ...(remote.proxy !== undefined ? ["-c", `http.proxy=${remote.proxy}`] : []), ...(remote.proxyAuthMethod !== undefined ? ["-c", `http.proxyAuthMethod=${remote.proxyAuthMethod}`] : []), "ls-remote", "--heads", ...(remote.uploadPack ? [`--upload-pack=${remote.uploadPack}`] : []), ...remote.serverOptions.map((value) => `--server-option=${value}`), "--", url, `refs/heads/${request.branch}`], { signal }).catch((error: unknown) => { throw new HttpError(409, "scm_remote_probe", redactGit(error instanceof Error ? error.message : String(error))); });
      const head = result.split("\n").map((line) => line.split("\t")).find((entry) => entry[1] === `refs/heads/${request.branch}`)?.[0] ?? null;
      if (head && !/^[a-f0-9]{40,64}$/.test(head)) throw new Error("원격 커밋을 확인하지 못했습니다.");
      destinations.push({ url: redactGit(url), head });
    }
    await this.target(state, request);
    const preview = { id: randomUUID(), workspaceId: state.workspaceId, remote: request.remote, branch: request.branch, head: state.head, remoteRevision: request.expectedRevision, destinations, expiresAt: Date.now() + 10 * 60_000 };
    for (const [id, saved] of this.previews) if (saved.preview.expiresAt < Date.now()) this.previews.delete(id);
    if (this.previews.size >= 100) this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(preview.id, { preview, urls: remote.pushUrls }); return preview;
  }
  async shutdown() { this.stopped = true; for (const probe of this.probes.values()) probe.abort.abort(); await Promise.allSettled([...this.probes.values()].map((probe) => probe.done)); this.previews.clear(); }
  async validate(state: ScmStatus, job: Pick<ScmJob, "request">) {
    const request = job.request.remote!, remote = await this.target(state, request);
    if (job.request.action !== "fetch" && (!state.head || !state.branch || state.operation)) throw new HttpError(409, "scm_remote_state", "진행 중인 Git 작업을 마무리하고 브랜치를 확인한 뒤 동기화하세요.");
    if (job.request.action === "pull" && state.files.some((file) => file.index !== "?")) throw new HttpError(409, "scm_pull_dirty", "추적 중인 파일의 변경을 먼저 커밋하거나 직접 보관한 뒤 받으세요. 자동 stash는 만들지 않습니다.");
    if (request.forcePreviewId) {
      const entry = this.previews.get(request.forcePreviewId), preview = entry?.preview;
      if (job.request.action !== "push" || !preview || preview.expiresAt < Date.now() || preview.workspaceId !== state.workspaceId || preview.remote !== request.remote || preview.branch !== request.branch || preview.head !== state.head || preview.remoteRevision !== request.expectedRevision || JSON.stringify(entry.urls) !== JSON.stringify(remote.pushUrls)) throw new HttpError(409, "scm_force_preview", "강제 보내기 대상 확인이 만료되거나 바뀌었습니다. 원격을 다시 확인하세요.");
    }
    return remote;
  }
  async run(job: ScmJob, state: ScmStatus, options: GitOptions, status: () => Promise<ScmStatus>, onResults: (results: ScmRemoteResult[]) => void) {
    const request = job.request.remote!, remote = await this.validate(state, job);
    const run = (args: string[], extra: GitOptions = {}) => scmText(state.root, ["-c", "protocol.ext.allow=never", ...(remote.proxy !== undefined ? ["-c", `http.proxy=${remote.proxy}`] : []), ...(remote.proxyAuthMethod !== undefined ? ["-c", `http.proxyAuthMethod=${remote.proxyAuthMethod}`] : []), ...args], { ...options, ...extra });
    const fetchOptions = ["fetch", "--progress", "--no-tags", "--no-prune", "--no-prune-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--no-auto-maintenance", "--refmap=", ...(remote.uploadPack ? [`--upload-pack=${remote.uploadPack}`] : []), ...remote.serverOptions.map((value) => `--server-option=${value}`)];
    if (job.request.action === "fetch") {
      await run([...fetchOptions, "--", remote.fetchUrls[0]!, `+refs/heads/*:refs/remotes/${remote.name}/*`]); return;
    }
    if (job.request.action === "pull") {
      const ref = `refs/workbench/fetch/${job.id}`;
      try {
        await run([...fetchOptions, "--", remote.fetchUrls[0]!, `+refs/heads/${request.branch}:${ref}`, `+refs/heads/${request.branch}:refs/remotes/${remote.name}/${request.branch}`]);
        const target = (await run(["rev-parse", "--verify", `${ref}^{commit}`])).trim();
        if ((await status()).localRevision !== state.localRevision) throw new HttpError(409, "scm_changed", "가져오는 동안 로컬 파일이나 브랜치가 바뀌었습니다. 가져온 커밋은 남기고 병합은 실행하지 않았습니다.");
        await this.target(state, request);
        if (request.strategy === "rebase") await run(["-c", "rebase.updateRefs=false", "rebase", "--no-autostash", target]);
        else await run(["merge", request.strategy === "merge" ? "--ff" : "--ff-only", "--no-autostash", "--no-edit", target]);
      } finally { await scmText(state.root, ["update-ref", "-d", ref]).catch((error: unknown) => options.onOutput?.(`\n가져오기 참조 정리 실패: ${redactGit(String(error))}\n`)); }
      return;
    }
    const expected = request.forcePreviewId ? this.previews.get(request.forcePreviewId)!.preview.destinations : null;
    const tracking = `refs/remotes/${remote.name}/${request.branch}`;
    const prior = (await scmText(state.root, ["rev-parse", "--verify", "--quiet", tracking], { accepted: [0, 1] })).trim();
    const results: ScmRemoteResult[] = remote.pushUrls.map((url) => ({ url: redactGit(url), phase: "pending" })); onResults(results);
    for (let i = 0; i < remote.pushUrls.length; i++) {
      const url = remote.pushUrls[i]!; await this.target(state, request);
      options.onOutput?.(`\n보내는 대상 ${i + 1}/${remote.pushUrls.length}: ${redactGit(url)} · ${request.branch}\n`);
      try {
        await run(["push", "--porcelain", "--progress", "--no-follow-tags", "--recurse-submodules=check", ...(remote.receivePack ? [`--receive-pack=${remote.receivePack}`] : []), ...(expected ? [`--force-with-lease=refs/heads/${request.branch}:${expected[i]!.head ?? ""}`] : []), "--", url, `${state.head}:refs/heads/${request.branch}`]);
        results[i] = { url: redactGit(url), phase: "complete", head: state.head! }; onResults([...results]);
      } catch (error) { results[i] = { url: redactGit(url), phase: "failed", error: redactGit(error instanceof Error ? error.message : String(error)) }; onResults([...results]); throw error; }
    }
    // Only the fetch repository's ref can be updated from a successful push to that URL.
    if (remote.pushUrls.includes(remote.fetchUrls[0]!)) {
      await run(["update-ref", tracking, state.head!, prior || "0".repeat(state.head!.length)]);
    }
    if (request.setUpstream) {
      const current = await status();
      if (current.branch !== state.branch) throw new Error("보내기는 완료했지만 로컬 브랜치가 바뀌어 추적 설정은 유지했습니다.");
      await run(["config", "--local", `branch.${state.branch}.remote`, remote.name]);
      await run(["config", "--local", `branch.${state.branch}.merge`, `refs/heads/${request.branch}`]);
    }
  }
}
