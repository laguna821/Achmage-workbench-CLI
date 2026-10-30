import type { GitHubCheck, GitHubPull } from "@workbench/contracts";
import { HttpError } from "./errors.ts";
export const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const string = (value: unknown, limit = 65536) => typeof value === "string" ? value.slice(0, limit) : "";
export const integer = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
export const oid = (value: unknown) => typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value) ? value : null;
export const repoName = (value: unknown) => typeof value === "string" && /^[a-z\d](?:[a-z\d-]{0,38})\/[a-z\d_.-]{1,100}$/i.test(value) && !value.split("/").some((part) => part === "." || part === "..") ? value : null;
export const sameRepo = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
export function githubRemote(raw: string) {
  let path: string | null = null;
  const scp = /^git@github\.com:([^?#\s]+)$/i.exec(raw); if (scp) path = scp[1]!;
  else try { const url = new URL(raw); if (url.hostname.toLowerCase() === "github.com" && !url.port && !url.password && !url.search && !url.hash && ((url.protocol === "https:" && !url.username) || (url.protocol === "ssh:" && url.username === "git"))) path = url.pathname.slice(1); } catch { /* Filesystem and other hosts are not GitHub. */ }
  return path ? repoName(path.replace(/\.git$/i, "")) : null;
}
export function publicUrl(value: unknown) { try { const url = new URL(string(value, 8192)); return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null; } catch { return null; } }
export function pullData(raw: unknown): GitHubPull {
  const p = object(raw), head = object(p.head), base = object(p.base), headRepo = repoName(object(head.repo).full_name), baseRepo = repoName(object(base.repo).full_name);
  const number = integer(p.number), headOid = oid(head.sha), baseOid = oid(base.sha), headBranch = string(head.ref, 1024), baseBranch = string(base.ref, 1024);
  if (!number || !headRepo || !baseRepo || !headOid || !baseOid || !headBranch || !baseBranch || !["open", "closed"].includes(string(p.state))) throw new HttpError(502, "github_pull_identity", "PR 저장소·브랜치·커밋 정보를 확인하지 못했습니다. 삭제된 포크인지 확인하세요.");
  return { number, title: string(p.title, 1024), body: string(p.body), author: string(object(p.user).login, 128), url: `https://github.com/${baseRepo}/pull/${number}`, state: p.merged === true || p.merged_at ? "merged" : p.state as "open" | "closed", draft: p.draft === true, baseRepo, baseBranch, baseOid, headRepo, headBranch, headOid, changedFiles: Math.max(0, Number(p.changed_files) || 0), updatedAt: string(p.updated_at, 64) };
}
const fields = `oid statusCheckRollup { contexts(first:100) { pageInfo { hasNextPage } nodes { __typename
  ... on CheckRun { databaseId name status conclusion detailsUrl checkSuite { repository { nameWithOwner } workflowRun { databaseId } commit { oid } } }
  ... on StatusContext { context state targetUrl }
} } } checkSuites(first:100) { pageInfo { hasNextPage } nodes { databaseId status conclusion url app { name } repository { nameWithOwner } } }`;
export const checksQuery = `query($owner:String!,$repo:String!,$number:Int!) { repository(owner:$owner,name:$repo) { pullRequest(number:$number) {
  headRefOid baseRefOid commits(last:1) { nodes { commit { ${fields} } } } potentialMergeCommit { ${fields} }
} } }`;
export type CheckIdentity = { id: number; run: number | null; repo: string; oid: string };
export function checkData(raw: unknown, pull: GitHubPull, makeId: () => string) {
  const p = object(object(object(object(raw).data).repository).pullRequest), commits = array(object(p.commits).nodes), head = object(object(commits[0]).commit), merge = object(p.potentialMergeCommit);
  if (p.headRefOid !== pull.headOid || p.baseRefOid !== pull.baseOid || head.oid !== pull.headOid) throw new HttpError(409, "github_pull_changed", "검사를 읽는 동안 PR 커밋이 바뀌었습니다. 새로고침하세요.");
  const checks: GitHubCheck[] = [], identities = new Map<string, CheckIdentity>(), notices: string[] = [];
  for (const [source, commit] of [["head", head], ["merge", merge]] as const) {
    const sha = oid(commit.oid); if (!sha || (source === "merge" && sha === pull.headOid)) continue;
    const contexts = object(object(commit.statusCheckRollup).contexts), suites = object(commit.checkSuites);
    if (object(contexts.pageInfo).hasNextPage || object(suites.pageInfo).hasNextPage) notices.push(`${source === "head" ? "PR" : "시험 병합"} 커밋의 검사/승인 목록이 100개를 넘어 일부만 표시합니다.`);
    for (const entry of array(contexts.nodes)) {
      const c = object(entry), suite = object(c.checkSuite), repo = repoName(object(suite.repository).nameWithOwner), id = makeId(), checkId = integer(c.databaseId);
      const ownOid: string = oid(object(suite.commit).oid) ?? sha;
      const isCheck = c.__typename === "CheckRun", isStatus = c.__typename === "StatusContext"; if (!isCheck && !isStatus) { notices.push("알 수 없는 검사 유형이 있어 전체 성공 여부를 판단할 수 없습니다."); continue; }
      if (isCheck && ownOid !== sha) { notices.push("다른 커밋에 속한 검사 결과를 제외했습니다. 전체 성공 여부를 판단하지 않습니다."); continue; }
      const permittedRepo = repo && (sameRepo(repo, pull.baseRepo) || sameRepo(repo, pull.headRepo));
      const details = !!(isCheck && checkId && permittedRepo && ownOid === sha);
      checks.push({ id, name: string(isCheck ? c.name : c.context, 1024) || "이름 없는 검사", status: string(isCheck ? c.status : c.state, 64).toLowerCase(), conclusion: isCheck ? string(c.conclusion, 64).toLowerCase() || null : string(c.state, 64).toLowerCase() || null, url: publicUrl(isCheck ? c.detailsUrl : c.targetUrl), source, oid: sha, repo, kind: isCheck ? "check" : "status", details });
      if (details) identities.set(id, { id: checkId!, run: integer(object(suite.workflowRun).databaseId), repo: repo!, oid: sha });
    }
    for (const entry of array(suites.nodes)) { const suite = object(entry); if (suite.conclusion !== "ACTION_REQUIRED") continue;
      checks.push({ id: makeId(), name: `${string(object(suite.app).name, 512) || "검사"} · 실행 승인 필요`, status: string(suite.status, 64).toLowerCase(), conclusion: "action_required", url: publicUrl(suite.url), source, oid: sha, repo: repoName(object(suite.repository).nameWithOwner), kind: "approval", details: false });
    }
  }
  return { checks, identities, notices, mergeOid: oid(merge.oid) };
}
