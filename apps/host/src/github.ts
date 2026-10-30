import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { scmPatchRows, type GitHubBinding, type GitHubCheckDetails, type GitHubJob, type GitHubLog, type GitHubSelection, type GitHubTarget, type GitHubTemplate, type GitHubView } from "@workbench/contracts";
import { HttpError } from "./errors.ts";
import { array, checkData, checksQuery, githubRemote, integer, object, pullData, repoName, sameRepo, string, type CheckIdentity } from "./github-data.ts";
import { GhReader, githubLogText, githubRedact, type GitHubReader } from "./github-reader.ts";
import { readRemotes } from "./scm-remote.ts";
import { scmHash } from "./scm-status.ts";
import { scmGit } from "./scm-git.ts";
import type { SourceControl } from "./source-control.ts";

type Binding = { data: GitHubBinding; stamp: string; at: number };
type View = { data: GitHubView; key: string; at: number; checks: Map<string, CheckIdentity>; mergeOid: string | null };
type JobIdentity = { view: string; repo: string; id: number; run: number; attempt: number; check: number; sha: string; name: string };
const expired = () => new HttpError(409, "github_expired", "PR 검토 정보가 만료되었습니다. 새로고침한 뒤 다시 확인하세요.");
const changed = () => new HttpError(409, "github_binding_changed", "작업공간의 브랜치·커밋·원격 설정이 바뀌었습니다. 저장소 연결을 새로고침하세요.");
const message = (error: unknown) => githubRedact(error instanceof Error ? error.message : String(error)).slice(0, 2000);
const segment = encodeURIComponent;
const target = (repo: string, remote: string, branch?: string): GitHubTarget => ({ id: scmHash(JSON.stringify([repo.toLowerCase(), branch ?? ""])).slice(0, 24), repo, remote, ...(branch ? { branch } : {}) });

export class GitHubReviews {
  private readonly scm: SourceControl; readonly reader: GitHubReader;
  private stopped = false;
  private readonly bindings = new Map<string, Binding>(); private readonly views = new Map<string, View>();
  private readonly jobs = new Map<string, JobIdentity>(); private readonly loading = new Map<string, Promise<GitHubView>>();
  constructor(scm: SourceControl, reader: GitHubReader = new GhReader()) { this.scm = scm; this.reader = reader; }
  private async local(workspaceId: string) {
    if (this.stopped) throw expired();
    const state = await this.scm.status(workspaceId), remotes = await readRemotes(state), stat = statSync(state.commonDir);
    const stamp = scmHash(JSON.stringify([workspaceId, state.root, state.commonDir, stat.dev, stat.ino, state.branch, state.head, remotes.inventory.revision]));
    return { state, remotes, stamp };
  }
  async binding(workspaceId: string): Promise<GitHubBinding> {
    const { state, remotes, stamp } = await this.local(workspaceId), heads: GitHubTarget[] = [], bases: GitHubTarget[] = [], warnings: string[] = [];
    for (const remote of remotes.remotes.slice(0, 20)) {
      const fetch = [...new Set(remote.fetchUrls.map(githubRemote))], push = [...new Set(remote.pushUrls.map(githubRemote))];
      if (fetch.length === 1 && fetch[0]) bases.push(target(fetch[0], remote.name));
      if (push.length === 1 && push[0] && state.branch) {
        heads.push(target(push[0], remote.name, state.branch));
        const mapped = remotes.inventory.pushTarget;
        if (mapped?.remote === remote.name && mapped.branch !== state.branch) heads.push(target(push[0], remote.name, mapped.branch));
      }
      if (fetch.length !== 1 || !fetch[0] || push.length !== 1 || !push[0]) warnings.push(`${remote.name}: 단일 GitHub.com 주소로 확인되지 않은 대상은 자동 연결하지 않습니다.`);
    }
    if (remotes.remotes.length > 20) warnings.push("원격 저장소가 20개를 넘어 앞 20개만 연결 후보로 표시합니다.");
    const preferredPush = remotes.inventory.pushTarget;
    const defaultHead = heads.find((item) => item.remote === preferredPush?.remote && item.branch === preferredPush.branch) ?? heads.find((item) => item.remote === "origin") ?? heads[0];
    let parent: GitHubTarget | undefined;
    if (defaultHead) {
      try { const meta = object(await this.reader.json(`repos/${defaultHead.repo}`)), name = repoName(meta.full_name), parentName = repoName(object(meta.parent).full_name);
        if (!name || !sameRepo(name, defaultHead.repo)) throw new Error("GitHub에서 저장소 이름이 바뀌었습니다. 원격 주소를 확인하세요.");
        if (meta.fork === true && parentName) { parent = bases.find((item) => sameRepo(item.repo, parentName)) ?? target(parentName, "포크 원본"); if (!bases.some((item) => item.id === parent!.id)) bases.push(parent); }
      } catch (error) {
        warnings.push(`포크 원본 확인: ${message(error)}`);
        const previous = [...this.bindings.values()].reverse().find((item) => item.stamp === stamp && item.data.defaultHead === defaultHead.id);
        const known = previous?.data.bases.find((item) => item.remote === "포크 원본");
        if (known) { parent = known; bases.push(known); warnings.push("같은 원격 설정에서 마지막으로 확인한 포크 원본을 유지합니다."); }
      }
    }
    if (!state.branch) warnings.push("분리된 HEAD에서는 브랜치를 선택한 뒤 PR을 연결하세요.");
    const defaultBase = bases.find((item) => item.remote === "upstream") ?? parent ?? bases.find((item) => item.remote === remotes.inventory.pullTarget?.remote) ?? bases.find((item) => item.remote === "origin") ?? bases[0];
    const unique = (list: GitHubTarget[]) => [...new Map(list.map((item) => [item.id, item])).values()];
    const revision = scmHash(JSON.stringify([stamp, unique(heads), unique(bases)]));
    const data: GitHubBinding = { workspaceId, revision, branch: state.branch, localHead: state.head, heads: unique(heads), bases: unique(bases), defaultHead: defaultHead?.id ?? null, defaultBase: defaultBase?.id ?? null, warnings };
    this.bindings.delete(revision); this.bindings.set(revision, { data, stamp, at: Date.now() }); while (this.bindings.size > 32) this.bindings.delete(this.bindings.keys().next().value!);
    return data;
  }
  private async bound(workspaceId: string, revision: string) {
    const saved = this.bindings.get(revision); if (!saved || saved.data.workspaceId !== workspaceId || Date.now() - saved.at > 30 * 60000) throw expired();
    if ((await this.local(workspaceId)).stamp !== saved.stamp) throw changed(); return saved;
  }
  private store(view: View) {
    this.views.set(view.data.id, view);
    while (this.views.size > 16 || [...this.views.values()].reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item.data)), 0) > 24 * 1024 * 1024) this.views.delete(this.views.keys().next().value!);
    for (const [id, job] of this.jobs) if (!this.views.has(job.view)) this.jobs.delete(id);
  }
  async load(workspaceId: string, selection: GitHubSelection): Promise<GitHubView> {
    if (!selection || typeof selection.binding !== "string" || typeof selection.head !== "string" || typeof selection.base !== "string" || (selection.number !== undefined && !integer(selection.number))) throw new HttpError(400, "github_selection", "PR 저장소와 올바른 번호를 선택하세요.");
    const binding = await this.bound(workspaceId, selection.binding), head = binding.data.heads.find((item) => item.id === selection.head), base = binding.data.bases.find((item) => item.id === selection.base);
    if (!head?.branch || !base) throw changed();
    const key = JSON.stringify([workspaceId, selection.binding, head.id, base.id, selection.number ?? null]);
    const previous = [...this.views.values()].reverse().find((view) => view.key === key);
    if (!selection.fresh && previous && Date.now() - previous.at < 30000) return previous.data;
    const pending = this.loading.get(key); if (pending) return pending;
    const done = this.loadFresh(workspaceId, selection, head, base, key).catch(async (error) => {
      if (previous && !this.stopped && !(error instanceof HttpError && ["github_binding_changed", "github_expired"].includes(error.code))) {
        await this.bound(workspaceId, selection.binding);
        return { ...previous.data, stale: true, error: message(error) };
      }
      throw error;
    });
    this.loading.set(key, done); try { return await done; } finally { this.loading.delete(key); }
  }
  private async loadFresh(workspaceId: string, selection: GitHubSelection, head: GitHubTarget, base: GitHubTarget, key: string): Promise<GitHubView> {
    const notices: string[] = [], headRepo = object(await this.reader.json(`repos/${head.repo}`, undefined, selection.fresh));
    const baseRepo = sameRepo(head.repo, base.repo) ? headRepo : object(await this.reader.json(`repos/${base.repo}`, undefined, selection.fresh));
    if (!integer(headRepo.id) || !integer(baseRepo.id) || !sameRepo(string(headRepo.full_name), head.repo) || !sameRepo(string(baseRepo.full_name), base.repo)) throw new HttpError(409, "github_repo_changed", "GitHub 저장소가 이동했거나 다른 저장소로 바뀌었습니다. 원격 주소를 확인하세요.");
    const belongs = (raw: unknown) => { const p = object(raw), h = object(p.head), b = object(p.base); return object(h.repo).id === headRepo.id && object(b.repo).id === baseRepo.id && h.ref === head.branch; };
    let number = selection.number;
    const candidates: GitHubView["candidates"] = [];
    if (!number) {
      const endpoint = `repos/${base.repo}/pulls?state=open&head=${segment(`${head.repo.split("/")[0]}:${head.branch}`)}&per_page=100`;
      const raw = await this.reader.json(endpoint, undefined, selection.fresh); if (!Array.isArray(raw)) throw new HttpError(502, "github_pull_list", "PR 목록 응답을 읽지 못했습니다.");
      for (const item of raw) if (belongs(item)) { const p = pullData(item); candidates.push({ number: p.number, title: p.title, headOid: p.headOid }); }
      if (raw.length >= 100) notices.push("PR 후보를 앞 100개에서 찾았습니다. 빠진 PR은 번호로 여세요.");
      if (candidates.length === 1) number = candidates[0]!.number;
    }
    const data: GitHubView = { id: randomUUID(), revision: "", workspaceId, binding: selection.binding, head, base, localHead: (await this.bound(workspaceId, selection.binding)).data.localHead, pull: null, candidates, files: [], checks: [], notices, checkedAt: Date.now(), stale: false, error: null };
    let checks = new Map<string, CheckIdentity>(), mergeOid: string | null = null;
    if (number) {
      const endpoint = `repos/${base.repo}/pulls/${number}`, initial = await this.reader.json(endpoint, undefined, true);
      if (!belongs(initial)) throw new HttpError(409, "github_pull_scope", "선택한 PR이 이 저장소·작업 브랜치에 속하지 않습니다.");
      const pull = pullData(initial); data.pull = pull;
      let totalPatch = 0, seen = 0;
      for (let page = 1; page <= 3; page++) {
        const list = await this.reader.json(`${endpoint}/files?per_page=100&page=${page}`, undefined, true); if (!Array.isArray(list)) throw new HttpError(502, "github_files", "PR 파일 목록을 읽지 못했습니다.");
        for (const raw of list) {
          const file = object(raw), path = string(file.filename, 8192); if (!path) throw new HttpError(502, "github_files", "PR 파일 이름이 없습니다.");
          let patch = string(file.patch, 128 * 1024), notice: string | null = null;
          if (typeof file.patch !== "string") notice = "GitHub가 텍스트 차이를 제공하지 않았습니다. 바이너리 또는 큰 파일일 수 있습니다.";
          else if (file.patch.length > patch.length) notice = "파일 차이가 커서 앞부분만 표시합니다.";
          if (patch && !notice) { const parsed = scmPatchRows(patch); if (!parsed.valid || parsed.rows.filter((row) => row.kind === "add").length !== file.additions || parsed.rows.filter((row) => row.kind === "del").length !== file.deletions) notice = "GitHub가 제공한 차이가 일부이거나 행 수와 맞지 않습니다. 전체 파일을 확인하세요."; }
          if (totalPatch + Buffer.byteLength(patch) > 4 * 1024 * 1024) { patch = ""; notice = "이 PR의 차이 표시 용량을 넘었습니다. GitHub에서 전체 파일을 확인하세요."; }
          totalPatch += Buffer.byteLength(patch); seen++;
          data.files.push({ id: randomUUID(), path, oldPath: string(file.previous_filename, 8192) || null, status: string(file.status, 64), additions: Math.max(0, Number(file.additions) || 0), deletions: Math.max(0, Number(file.deletions) || 0), patch, notice });
        }
        if (list.length < 100) break;
      }
      if (seen !== pull.changedFiles) notices.push(`변경 파일 ${pull.changedFiles}개 중 ${seen}개를 표시합니다. 최대 300개이며 전체 목록이 아닐 수 있습니다.`);
      try {
        const [owner, repo] = base.repo.split("/"), result = checkData(await this.reader.json("graphql", { query: checksQuery, variables: { owner, repo, number } }, true), pull, randomUUID);
        data.checks = result.checks; data.notices.push(...result.notices); checks = result.identities; mergeOid = result.mergeOid;
      } catch (error) { if (error instanceof HttpError && error.code === "github_pull_changed") throw error; notices.push(`검사 정보를 불러오지 못했습니다. 성공 여부를 판단하지 않습니다. ${message(error)}`); }
      const finalRaw = await this.reader.json(endpoint, undefined, true), final = pullData(finalRaw);
      if (!belongs(finalRaw) || pull.headOid !== final.headOid || pull.baseOid !== final.baseOid || pull.changedFiles !== final.changedFiles) throw new HttpError(409, "github_pull_changed", "파일을 읽는 동안 PR 기준이나 커밋이 바뀌었습니다. 새로고침하세요.");
      data.pull = final;
    }
    await this.bound(workspaceId, selection.binding); data.checkedAt = Date.now(); data.revision = scmHash(JSON.stringify(data));
    this.store({ data, key, at: Date.now(), checks, mergeOid }); return data;
  }
  private async view(workspaceId: string, id: string, revision: string) {
    const view = this.views.get(id); if (!view || view.data.workspaceId !== workspaceId || view.data.revision !== revision || Date.now() - view.at > 30 * 60000) throw expired();
    await this.bound(workspaceId, view.data.binding); return view;
  }
  async actionScope(workspaceId: string, id: string, revision: string) {
    const view = await this.view(workspaceId, id, revision);
    return { view: view.data, checks: [...view.checks.entries()], mergeOid: view.mergeOid };
  }
  async templates(workspaceId: string, id: string, revision: string): Promise<GitHubTemplate[]> {
    const view = await this.view(workspaceId, id, revision), state = await this.scm.status(workspaceId), commit = view.data.localHead;
    if (!commit || commit !== state.head) throw changed();
    const rows = (await scmGit(state.root, ["ls-tree", "-r", "-z", commit, "--", ".github", "docs", "PULL_REQUEST_TEMPLATE.md", "pull_request_template.md"], { noLazyFetch: true, limit: 1024 * 1024 })).toString("utf8").split("\0");
    const candidates = rows.map((row) => /^(100644|100755) blob ([a-f0-9]{40,64})\t(.+)$/.exec(row)).filter((row) => row && /^(?:(?:\.github|docs)\/)?pull_request_template(?:\.md|\/[^/]+\.md)$/i.test(row[3]!));
    if (candidates.length > 20) throw new HttpError(413, "github_templates", "PR 템플릿이 20개를 넘습니다. 저장소에서 사용할 템플릿을 정리하세요.");
    const result: GitHubTemplate[] = []; let bytes = 0;
    for (const item of candidates) { const content = await scmGit(state.root, ["cat-file", "blob", item![2]!], { noLazyFetch: true, limit: 65536 }); bytes += content.length; if (bytes > 256 * 1024) throw new HttpError(413, "github_templates", "PR 템플릿 합계가 256 KiB를 넘습니다."); if (content.includes(0)) continue; result.push({ path: item![3]!, body: content.toString("utf8"), commit }); }
    await this.view(workspaceId, id, revision); return result;
  }
  async details(workspaceId: string, id: string, revision: string, checkId: string): Promise<GitHubCheckDetails> {
    const view = await this.view(workspaceId, id, revision), check = view.checks.get(checkId), label = view.data.checks.find((item) => item.id === checkId);
    if (!check || !label || !view.data.pull) throw new HttpError(404, "github_check", "이 검토에 연결된 검사가 아닙니다.");
    const raw = object(await this.reader.json(`repos/${check.repo}/check-runs/${check.id}`, undefined, true));
    if (raw.id !== check.id || raw.head_sha !== check.oid) throw new HttpError(409, "github_check_changed", "검사의 커밋이 검토 기준과 다릅니다.");
    const output = object(raw.output), result: GitHubCheckDetails = { name: label.name, summary: string(output.summary), text: string(output.text), jobs: [], notices: [] };
    if (!check.run) { result.notices.push("GitHub Actions 실행 정보가 없는 검사입니다."); return result; }
    const run = object(await this.reader.json(`repos/${check.repo}/actions/runs/${check.run}`, undefined, true)), attempt = integer(run.run_attempt);
    const allowed = [view.data.pull.headOid, view.mergeOid].filter(Boolean);
    if (run.id !== check.run || !attempt || !allowed.includes(string(run.head_sha)) || !sameRepo(string(object(run.repository).full_name), check.repo)) throw new HttpError(409, "github_run_scope", "Actions 실행의 저장소·커밋을 이 PR과 연결하지 못했습니다.");
    const response = object(await this.reader.json(`repos/${check.repo}/actions/runs/${check.run}/attempts/${attempt}/jobs?per_page=100`, undefined, true));
    const rows = array(response.jobs); if (Number(response.total_count) > rows.length) result.notices.push("작업이 100개를 넘어 일부만 표시합니다.");
    for (const item of rows) {
      const j = object(item), jobId = integer(j.id);
      if (!jobId || j.run_id !== check.run || j.run_attempt !== attempt || !allowed.includes(string(j.head_sha)) || string(j.check_run_url) !== `https://api.github.com/repos/${check.repo}/check-runs/${check.id}`) continue;
      const token = randomUUID(), name = string(j.name, 1024);
      const job: GitHubJob = { id: token, name, status: string(j.status, 64), conclusion: string(j.conclusion, 64) || null, steps: array(j.steps).slice(0, 200).map((value) => { const step = object(value); return { name: string(step.name, 1024), status: string(step.status, 64), conclusion: string(step.conclusion, 64) || null }; }) };
      this.jobs.set(token, { view: id, repo: check.repo, id: jobId, run: check.run, attempt, check: check.id, sha: string(j.head_sha), name }); result.jobs.push(job);
    }
    while (this.jobs.size > 512) this.jobs.delete(this.jobs.keys().next().value!);
    if (!result.jobs.length) result.notices.push("이 검사와 일치하는 실행 작업을 찾지 못했습니다. 재실행되었다면 PR을 새로고침하세요.");
    await this.view(workspaceId, id, revision); return result;
  }
  async log(workspaceId: string, id: string, revision: string, jobId: string): Promise<GitHubLog> {
    await this.view(workspaceId, id, revision); const job = this.jobs.get(jobId);
    if (!job || job.view !== id) throw new HttpError(404, "github_job", "이 검토의 실행 작업이 아닙니다.");
    const raw = object(await this.reader.json(`repos/${job.repo}/actions/jobs/${job.id}`, undefined, true));
    if (raw.id !== job.id || raw.run_id !== job.run || raw.run_attempt !== job.attempt || raw.head_sha !== job.sha || string(raw.check_run_url) !== `https://api.github.com/repos/${job.repo}/check-runs/${job.check}`) throw new HttpError(409, "github_job_changed", "검토한 실행 시도와 작업 정보가 다릅니다. 새로고침하세요.");
    if (raw.status !== "completed") throw new HttpError(409, "github_log_pending", "작업이 끝나면 로그를 읽을 수 있습니다.");
    const text = githubLogText(await this.reader.log(`repos/${job.repo}/actions/jobs/${job.id}/logs`));
    await this.view(workspaceId, id, revision);
    return { name: job.name, text: text.slice(-128 * 1024), truncated: text.length > 128 * 1024, fetchedAt: Date.now() };
  }
  async close() { this.stopped = true; await this.reader.close(); await Promise.allSettled([...this.loading.values()]); this.bindings.clear(); this.views.clear(); this.jobs.clear(); }
}
