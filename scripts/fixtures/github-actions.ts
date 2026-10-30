import { githubFixture, githubFixtureResponse } from "./github.ts";

type Dict = { [key: string]: any };
/** Stateful API simulator. No network, git writes or real GitHub CLI calls. */
export function githubActionsFixture(head?: string) {
  return { ...githubFixture(head), action: { actor: "worker", actorId: "U1", remoteHead: head ?? "a".repeat(40), permission: "WRITE", auto: false, queued: false, queueRequired: false, autoAllowed: true, stack: null as Dict | null, method: "squash", asyncResult: "pending", asyncUuid: "fixture-merge-uuid", attempt: 2, runStatus: "completed", conclusion: "failure", sequence: 0, created: false, requests: [] as Dict[], extraRuns: {} as Dict, extraChecks: {} as Dict } };
}
export type GitHubActionsFixture = ReturnType<typeof githubActionsFixture>;
export function githubActionsRead(endpoint: string, data: GitHubActionsFixture, body?: Dict): unknown {
  const a = data.action, p = data.pull;
  if (endpoint === "graphql" && body?.query?.includes("query WorkbenchActions")) {
    data.calls.push(endpoint);
    return { data: { viewer: { id: a.actorId, login: a.actor }, head: { id: "R11", nameWithOwner: data.fork.full_name, ref: { target: { oid: a.remoteHead } } }, repository: {
      id: "R10", nameWithOwner: data.repo.full_name, viewerPermission: a.permission, defaultBranchRef: { name: "main" }, mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: false, autoMergeAllowed: a.autoAllowed, viewerDefaultMergeMethod: "SQUASH",
      ...(body.variables?.hasPull ? { pullRequest: { id: "P7", number: 7, title: p.title, body: p.body, state: p.merged ? "MERGED" : p.state.toUpperCase(), isDraft: p.draft, updatedAt: p.updated_at,
        headRefName: p.head.ref, headRefOid: p.head.sha, baseRefName: p.base.ref, baseRefOid: p.base.sha, headRepository: { id: "R11", nameWithOwner: p.head.repo.full_name },
        viewerCanUpdate: a.permission === "WRITE", viewerCanEnableAutoMerge: a.permission === "WRITE", viewerCanDisableAutoMerge: a.permission === "WRITE", isMergeQueueEnabled: a.queueRequired, isInMergeQueue: a.queued, autoMergeRequest: a.auto ? { mergeMethod: a.method.toUpperCase() } : null, mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED", stack: a.stack,
      } } : {}),
    } } };
  }
  if (endpoint.startsWith("repos/fixture/project/git/ref/heads/")) return { ref: `refs/heads/${decodeURIComponent(endpoint.split("/heads/")[1]!)}`, object: { sha: p.base.sha } };
  if (endpoint.startsWith("repos/fixture/project/pulls?state=all")) return data.empty && !a.created ? [] : [p];
  if (endpoint === "repos/fixture/project/check-runs/101") return { id: 101, head_sha: p.head.sha, status: "completed", conclusion: "failure", started_at: "2026-10-30T00:00:00Z", completed_at: "2026-10-30T00:01:00Z", output: { summary: "failed", text: "" } };
  if (endpoint === "repos/fixture/project/actions/runs/201") return { id: 201, run_attempt: a.attempt, head_sha: p.head.sha, repository: data.repo, status: a.runStatus, conclusion: a.conclusion };
  if (endpoint.includes("/merge-async/")) { if (a.asyncResult === "merged") { p.merged = true; p.state = "closed"; } if (a.asyncResult === "enqueued") a.queued = true; return asyncResponse(data); }
  for (const [key, value] of Object.entries(a.extraRuns)) if (endpoint.endsWith(`/actions/runs/${key}`)) return value;
  for (const [key, value] of Object.entries(a.extraChecks)) if (endpoint.endsWith(`/check-runs/${key}`)) return value;
  return githubFixtureResponse(endpoint, data);
}
function asyncResponse(data: GitHubActionsFixture) { const a = data.action; return { status: a.asyncResult, details: { uuid: a.asyncUuid, expected_head_sha: data.pull.head.sha, merge_method: a.method, merge_action: a.queueRequired ? "merge_queue" : "direct_merge", bypass_rules: false, message: "fixture merge response" } }; }
export function githubActionsWrite(request: { method: string; endpoint: string; body?: Dict }, data: GitHubActionsFixture) {
  const { endpoint, method, body } = request, a = data.action, p = data.pull; a.requests.push(request); a.sequence++;
  if (endpoint === "graphql" && method === "POST") {
    const query = String(body?.query), input = body?.variables?.input ?? {}, name = /\{ (\w+)\(input:/.exec(query)?.[1];
    if (!query.startsWith("mutation WorkbenchAction") || !input.clientMutationId) throw new Error("fixture rejected unknown mutation");
    if (name !== "createPullRequest" && input.pullRequestId !== "P7") throw new Error("fixture rejected wrong pull id");
    switch (name) {
      case "createPullRequest": if (!data.empty) throw new Error("duplicate fixture PR"); a.created = true; data.empty = false; p.title = input.title; p.body = input.body; p.base.ref = input.baseRefName; p.draft = input.draft; break;
      case "updatePullRequest": p.title = input.title; p.body = input.body; p.base.ref = input.baseRefName; break;
      case "closePullRequest": p.state = "closed"; break;
      case "reopenPullRequest": p.state = "open"; break;
      case "convertPullRequestToDraft": p.draft = true; break;
      case "markPullRequestReadyForReview": p.draft = false; break;
      case "enablePullRequestAutoMerge": if (input.expectedHeadOid !== p.head.sha) throw new Error("stale head"); a.auto = true; a.method = input.mergeMethod.toLowerCase(); break;
      case "disablePullRequestAutoMerge": a.auto = false; break;
      default: throw new Error(`fixture does not implement ${name}`);
    }
    p.updated_at = `2026-10-30T00:00:${String(a.sequence).padStart(2, "0")}Z`;
    return { status: 200, value: { data: { [name!]: { clientMutationId: input.clientMutationId, ...(name === "createPullRequest" ? { pullRequest: { number: 7, id: "P7" } } : {}) } } } };
  }
  if (/\/actions\/runs\/\d+\/rerun(?:-failed-jobs)?$/.test(endpoint) && method === "POST") { const run = endpoint.split("/").at(-2)!; if (run === "201") { a.attempt++; a.runStatus = "queued"; } else { a.extraRuns[run].run_attempt++; a.extraRuns[run].status = "queued"; } return { status: 201, value: null }; }
  if (endpoint === "repos/fixture/project/pulls/7/merge-async" && method === "PUT") { if (body?.sha !== p.head.sha || body?.bypass_rules) throw new Error("fixture rejected wrong merge condition"); a.method = body?.merge_method ?? a.method; return { status: 202, value: asyncResponse(data) }; }
  throw new Error(`fixture forbids ${method} ${endpoint}`);
}
