import { githubActionsFixture, githubActionsRead, githubActionsWrite } from "./github-actions.ts";
type Dict = { [key: string]: any };
const comment = (id: string, body: string, author = "reviewer", databaseId = "501") => ({ id, fullDatabaseId: databaseId, body, author: { login: author, id: author === "worker" ? "U1" : "U2" }, createdAt: "2026-10-30T01:00:00Z", updatedAt: "2026-10-30T01:00:00Z", url: `https://github.com/fixture/project/pull/7#${id}`, viewerCanUpdate: author === "worker", viewerCanDelete: author === "worker", viewerCanReact: true, reactionGroups: [] as Dict[] });
export function githubDiscussionFixture(head?: string) {
  const base = githubActionsFixture(head), sha = base.pull.head.sha;
  const root = { ...comment("C1", "경계값 검사를 추가해 주세요."), commit: { oid: sha }, pullRequestReview: { id: "R1", state: "CHANGES_REQUESTED" }, replyTo: null };
  const reply = { ...comment("C2", "이 답글에서도 회신할 수 있어야 합니다.", "worker", "502"), createdAt: "2026-10-30T01:02:00Z", commit: { oid: sha }, pullRequestReview: { id: "R2", state: "COMMENTED" }, replyTo: { id: "C1", fullDatabaseId: "501" } };
  base.pull.draft = false;
  base.pull.user.login = "author";
  return { ...base, discussion: {
    pageSize: 100, sequence: 600, locked: false, malformed: "", loseNext: false, users: { reviewer: "U2", teammate: "U3", worker: "U1" } as Dict, teams: { "fixture/core": "T1" } as Dict,
    comments: [comment("I1", "**PR 전체 의견**\n\n- 변경 범위 확인\n- 회귀 확인\n\n`검토 메모`", "worker", "500")] as Dict[],
    reviews: [{ ...comment("R1", "행 의견을 확인해 주세요.", "reviewer", "510"), state: "CHANGES_REQUESTED", commit: { oid: sha } }, { ...comment("R2", "", "worker", "511"), state: "COMMENTED", commit: { oid: sha } }, { ...comment("R3", "", "reviewer", "512"), state: "APPROVED", commit: { oid: sha } }] as Dict[],
    threads: [{ id: "TH1", path: "한글.txt", diffSide: "RIGHT", startDiffSide: "RIGHT", line: 1, startLine: null, originalLine: 1, originalStartLine: null, subjectType: "LINE", isResolved: false, isOutdated: false, viewerCanReply: true, viewerCanResolve: true, viewerCanUnresolve: true, comments: [root, reply] }] as Dict[],
    requests: [{ requestedReviewer: { __typename: "User", id: "U2", login: "reviewer" } }] as Dict[],
  } };
}
export type GitHubDiscussionFixture = ReturnType<typeof githubDiscussionFixture>;
function all(data: GitHubDiscussionFixture) { return [...data.discussion.comments, ...data.discussion.reviews, ...data.discussion.threads.flatMap((t) => t.comments)]; }
function connection(data: GitHubDiscussionFixture, nodes: Dict[], cursor?: string) { const start = Number(cursor ?? 0), size = data.discussion.pageSize, end = Math.min(nodes.length, start + size); return { nodes: nodes.slice(start, end), pageInfo: { hasNextPage: end < nodes.length, endCursor: end < nodes.length ? String(end) : null } }; }
function review(data: GitHubDiscussionFixture, value: Dict) { return { ...value, comments: connection(data, data.discussion.threads.flatMap((t) => t.comments).filter((c: Dict) => c.pullRequestReview?.id === value.id)) }; }
function thread(data: GitHubDiscussionFixture, value: Dict) { return { ...value, comments: connection(data, value.comments) }; }
export function githubDiscussionRead(endpoint: string, data: GitHubDiscussionFixture, body?: Dict): unknown {
  const q = String(body?.query ?? ""), v = body?.variables ?? {}, d = data.discussion;
  if (endpoint !== "graphql" || !q.startsWith("query WorkbenchDiscussion")) return githubActionsRead(endpoint, data, body);
  if (q.startsWith("query WorkbenchDiscussionReviewer")) { if (v.login) return { data: { user: d.users[v.login] ? { id: d.users[v.login], login: v.login } : null } }; const name = `${v.org}/${v.slug}`; return { data: { organization: { team: d.teams[name] ? { id: d.teams[name], slug: v.slug, organization: { login: v.org } } : null } } }; }
  if (q.startsWith("query WorkbenchDiscussionPage")) {
    const field = /\b(comments|reviews|reviewThreads|reviewRequests)\(first:/.exec(q)?.[1]!;
    let rows: Dict[] = [];
    if (v.id === "P7") rows = field === "comments" ? d.comments : field === "reviews" ? d.reviews.map((r) => review(data, r)) : field === "reviewThreads" ? d.threads.map((t) => thread(data, t)) : d.requests;
    else { const t = d.threads.find((t) => t.id === v.id), r = d.reviews.find((r) => r.id === v.id); rows = t?.comments ?? (r ? d.threads.flatMap((t) => t.comments).filter((c: Dict) => c.pullRequestReview.id === r.id) : []); }
    return { data: { node: { id: v.id, [field]: connection(data, rows, v.cursor) } } };
  }
  const result = githubActionsRead("graphql", data, { query: "query WorkbenchActions", variables: { hasPull: true } }) as Dict;
  const pull = result.data.repository.pullRequest;
  Object.assign(pull, { locked: d.locked, author: { login: data.pull.user.login } });
  if (!q.startsWith("query WorkbenchDiscussionIdentity")) Object.assign(pull, { comments: connection(data, d.comments), reviews: connection(data, d.reviews.map((r) => review(data, r))), reviewThreads: connection(data, d.threads.map((t) => thread(data, t))), reviewRequests: connection(data, d.requests) });
  if (d.malformed) pull[d.malformed] = null;
  return result;
}
export function githubDiscussionWrite(request: { method: string; endpoint: string; body?: Dict }, data: GitHubDiscussionFixture) {
  const { endpoint, body, method } = request, d = data.discussion, a = data.action, input = body?.variables?.input ?? {}, query = String(body?.query ?? "");
  if (!(endpoint === "graphql" && query.startsWith("mutation WorkbenchDiscussionAction")) && !/\/pulls\/7\/comments(?:\/\d+\/replies)?$/.test(endpoint) && !endpoint.endsWith("/pulls/7/requested_reviewers")) return githubActionsWrite(request, data);
  a.requests.push(request); a.sequence++; d.sequence++; data.pull.updated_at = `2026-10-30T02:${String(Math.floor(a.sequence / 60)).padStart(2, "0")}:${String(a.sequence % 60).padStart(2, "0")}Z`;
  const node = (kind: string) => `${kind}${d.sequence}`, fresh = (id: string, body: string) => ({ ...comment(id, body, a.actor, String(d.sequence)), author: { id: a.actorId, login: a.actor }, createdAt: data.pull.updated_at, updatedAt: data.pull.updated_at });
  const makeReview = (body: string, state: string, commit = data.pull.head.sha) => { const r = { ...fresh(node("RV"), body), state, commit: { oid: commit } }; d.reviews.push(r); return r; };
  const makeThread = (text: string, value: Dict, r: Dict) => {
    const c = { ...fresh(node("RC"), text), commit: r.commit, pullRequestReview: { id: r.id, state: r.state }, replyTo: null };
    const t = { id: node("TH"), path: value.path, diffSide: value.side ?? "RIGHT", startDiffSide: value.startSide ?? value.start_side ?? "RIGHT", line: value.line ?? null, startLine: value.startLine ?? value.start_line ?? null, originalLine: value.line ?? null, originalStartLine: value.startLine ?? value.start_line ?? null, subjectType: value.subject_type === "file" ? "FILE" : "LINE", isResolved: false, isOutdated: false, viewerCanReply: true, viewerCanResolve: true, viewerCanUnresolve: true, comments: [c] }; d.threads.push(t); return c;
  };
  if (endpoint !== "graphql") {
    if (method === "DELETE" && endpoint.endsWith("/requested_reviewers")) { d.requests = d.requests.filter((r) => !(body?.reviewers ?? []).includes(r.requestedReviewer.login) && !(body?.team_reviewers ?? []).includes(r.requestedReviewer.slug)); return { status: 200, value: data.pull }; }
    if (method !== "POST") throw new Error("fixture method mismatch");
    if (endpoint.endsWith("/replies")) { const root = endpoint.split("/").at(-2), t = d.threads.find((t) => t.comments.some((c: Dict) => String(c.fullDatabaseId) === root && !c.replyTo)); if (!t) throw new Error("REST replies must address the root comment"); const r = makeReview("", "COMMENTED"), c = { ...fresh(node("RC"), body!.body), commit: r.commit, pullRequestReview: { id: r.id, state: r.state }, replyTo: { id: t.comments[0].id, fullDatabaseId: root } }; t.comments.push(c); return { status: 201, value: { node_id: c.id, id: Number(c.fullDatabaseId), body: c.body } }; }
    if (body?.commit_id !== data.pull.head.sha) throw new Error("wrong inline commit"); const r = makeReview("", "COMMENTED"), c = makeThread(body!.body, body!, r); return { status: 201, value: { node_id: c.id, id: Number(c.fullDatabaseId), body: c.body } };
  }
  const name = /\{ (\w+)\(input:/.exec(query)?.[1]; if (!name || !input.clientMutationId) throw new Error("fixture mutation mismatch");
  const payload: Dict = { clientMutationId: input.clientMutationId }, target = all(data).find((c) => c.id === (input.id ?? input.pullRequestReviewId ?? input.pullRequestReviewCommentId ?? input.subjectId));
  switch (name) {
    case "addComment": { if (input.subjectId !== "P7") throw new Error("wrong subject"); const c = fresh(node("IC"), input.body); d.comments.push(c); payload.commentEdge = { node: { id: c.id } }; break; }
    case "updateIssueComment": case "updatePullRequestReview": case "updatePullRequestReviewComment": { if (!target?.viewerCanUpdate) throw new Error("not permitted"); target.body = input.body; target.updatedAt = data.pull.updated_at; payload[name === "updateIssueComment" ? "issueComment" : name === "updatePullRequestReview" ? "pullRequestReview" : "pullRequestReviewComment"] = { id: target.id }; break; }
    case "deleteIssueComment": case "deletePullRequestReviewComment": { if (!target?.viewerCanDelete) throw new Error("not permitted"); d.comments = d.comments.filter((c) => c.id !== target.id); for (const t of d.threads) t.comments = t.comments.filter((c: Dict) => c.id !== target.id); break; }
    case "addReaction": case "removeReaction": { if (!target) throw new Error("missing reaction target"); let r = target.reactionGroups.find((r: Dict) => r.content === input.content); if (!r) { r = { content: input.content, viewerHasReacted: false, reactors: { totalCount: 0 } }; target.reactionGroups.push(r); } r.viewerHasReacted = name === "addReaction"; r.reactors.totalCount = r.viewerHasReacted ? 1 : 0; payload.subject = { id: target.id }; break; }
    case "resolveReviewThread": case "unresolveReviewThread": { const t = d.threads.find((t) => t.id === input.threadId); if (!t) throw new Error("missing thread"); t.isResolved = name === "resolveReviewThread"; payload.thread = { id: t.id, isResolved: t.isResolved }; break; }
    case "requestReviews": { if (input.pullRequestId !== "P7") throw new Error("wrong PR"); const rows = [...(input.userIds ?? []).map((id: string) => { const login = Object.keys(d.users).find((login) => d.users[login] === id); if (!login) throw new Error("unknown user"); return { requestedReviewer: { __typename: "User", id, login } }; }), ...(input.teamIds ?? []).map((id: string) => { const name = Object.keys(d.teams).find((name) => d.teams[name] === id)!; return { requestedReviewer: { __typename: "Team", id, slug: name.split("/")[1], organization: { login: name.split("/")[0] } } }; })]; d.requests = input.union ? [...d.requests, ...rows.filter((r) => !d.requests.some((old) => old.requestedReviewer.id === r.requestedReviewer.id))] : rows; payload.pullRequest = { id: "P7" }; break; }
    case "addPullRequestReview": { if (input.pullRequestId !== "P7" || input.commitOID !== data.pull.head.sha) throw new Error("wrong review commit"); const r = makeReview(input.body, input.event === "APPROVE" ? "APPROVED" : input.event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED", input.commitOID); for (const t of input.threads ?? []) { d.sequence++; makeThread(t.body, t, r); } payload.pullRequestReview = { id: r.id, state: r.state }; break; }
    case "submitPullRequestReview": { if (!target || target.state !== "PENDING") throw new Error("not pending"); target.state = input.event === "APPROVE" ? "APPROVED" : input.event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED"; target.body = input.body; for (const t of d.threads) for (const c of t.comments) if (c.pullRequestReview.id === target.id) c.pullRequestReview.state = target.state; payload.pullRequestReview = { id: target.id, state: target.state }; break; }
    case "deletePullRequestReview": { if (!target || target.state !== "PENDING") throw new Error("not pending"); d.reviews = d.reviews.filter((r) => r.id !== target.id); for (const t of d.threads) t.comments = t.comments.filter((c: Dict) => c.pullRequestReview.id !== target.id); d.threads = d.threads.filter((t) => t.comments.length); payload.pullRequestReview = { id: target.id }; break; }
    default: throw new Error(`unexpected discussion mutation ${name}`);
  }
  return { status: 200, value: { data: { [name]: payload } } };
}
