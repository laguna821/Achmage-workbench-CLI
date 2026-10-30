/** Isolated read-only GitHub protocol fixture, shared by host and actual-app tests. */
export function githubFixture(head = "a".repeat(40)) {
  const repo = { id: 10, full_name: "fixture/project", fork: false }, fork = { id: 11, full_name: "worker/project", fork: true, parent: repo };
  const pull = { number: 7, title: "한글 PR 검토", body: "**검증할 변경**\n\n![원격 이미지](https://example.invalid/tracker.png)", state: "open", merged: false, merged_at: null as string | null, draft: true, user: { login: "worker" }, head: { sha: head, ref: "feature", repo: fork }, base: { sha: "b".repeat(40), ref: "main", repo }, changed_files: 2, updated_at: "2026-10-30T00:00:00Z" };
  const commit = { oid: head, statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [
    { __typename: "CheckRun", databaseId: 101, name: "Linux 검사", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/fixture/project/actions/runs/201/job/301", checkSuite: { repository: { nameWithOwner: repo.full_name }, workflowRun: { databaseId: 201 }, commit: { oid: head } } },
    { __typename: "StatusContext", context: "외부 검사", state: "PENDING", targetUrl: "https://ci.example.invalid/build/1" },
  ] } }, checkSuites: { pageInfo: { hasNextPage: false }, nodes: [{ databaseId: 22, status: "COMPLETED", conclusion: "ACTION_REQUIRED", url: "https://github.com/fixture/project/actions", app: { name: "외부 기여" }, repository: { nameWithOwner: repo.full_name } }] } };
  const merge = { oid: "c".repeat(40), statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [{ __typename: "StatusContext", context: "병합 시험", state: "SUCCESS", targetUrl: "https://ci.example.invalid/merge/1" }] } }, checkSuites: { pageInfo: { hasNextPage: false }, nodes: [] } };
  return { repo, fork, pull, commit, merge, empty: false, fail: false, checkFail: false, jobMismatch: false, logMissing: false, calls: [] as string[] };
}
export type GitHubFixture = ReturnType<typeof githubFixture>;
export function githubFixtureResponse(endpoint: string, data: GitHubFixture): unknown {
  data.calls.push(endpoint);
  if (data.fail) throw new Error("GitHub fixture network unavailable");
  if (endpoint === "repos/worker/project") return data.fork;
  if (endpoint === "repos/fixture/project") return data.repo;
  if (endpoint.startsWith("repos/fixture/project/pulls?")) return data.empty ? [] : [data.pull];
  if (endpoint === "repos/fixture/project/pulls/7") return data.pull;
  if (endpoint === "repos/fixture/project/pulls/7/files?per_page=100&page=1") return [
    { filename: "한글.txt", previous_filename: "이전.txt", status: "renamed", additions: 1, deletions: 1, patch: "@@ -1,2 +1,2 @@\n-이전 내용\n+검토한 PR 내용\n 유지\n" },
    { filename: "image.png", status: "added", additions: 0, deletions: 0 },
  ];
  if (endpoint === "graphql") { if (data.checkFail) throw new Error("GraphQL read denied"); return { data: { repository: { pullRequest: { headRefOid: data.pull.head.sha, baseRefOid: data.pull.base.sha, commits: { nodes: [{ commit: data.commit }] }, potentialMergeCommit: data.merge } } } }; }
  if (endpoint === "repos/fixture/project/check-runs/101") return { id: 101, head_sha: data.pull.head.sha, output: { summary: "**테스트 실패**", text: "한글.txt의 경계 조건을 확인하세요." } };
  if (endpoint === "repos/fixture/project/actions/runs/201") return { id: 201, run_attempt: 2, head_sha: data.pull.head.sha, repository: data.repo };
  const job = { id: 301, run_id: 201, run_attempt: 2, head_sha: data.jobMismatch ? "d".repeat(40) : data.pull.head.sha, check_run_url: "https://api.github.com/repos/fixture/project/check-runs/101", name: "Linux 검사", status: "completed", conclusion: "failure", steps: [{ name: "테스트 실행", status: "completed", conclusion: "failure" }] };
  if (endpoint === "repos/fixture/project/actions/runs/201/attempts/2/jobs?per_page=100") return { total_count: 1, jobs: [job] };
  if (endpoint === "repos/fixture/project/actions/jobs/301") return job;
  if (endpoint === "repos/fixture/project/actions/jobs/301/logs") { if (data.logMissing) throw new Error("410 logs expired"); return "2026-10-30 테스트 실행\n\x1b[31mError:\x1b[0m expected boundary to be preserved\n한글.txt:2\n\x1b]0;hidden title\x07"; }
  throw new Error(`Unexpected fixture endpoint: ${endpoint}`);
}
