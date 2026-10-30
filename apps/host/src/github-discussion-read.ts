import { githubReactions, type GitHubDiscussionComment, type GitHubDiscussionThread, type GitHubReviewer } from "@workbench/contracts";
import type { GitHubReader } from "./github-reader.ts";
import { array, integer, object, publicUrl, sameRepo, string } from "./github-data.ts";
import { commonCommentFields, connectionFields, discussionError, discussionIdentityFields, discussionQuery, inlineCommentFields, reviewFields, reviewerFields, threadFields } from "./github-discussion-data.ts";
import { scmHash } from "./scm-status.ts";

export type DiscussionIdentity = { repo: string; number: number; headOid: string; baseOid: string; headRepo: string; headBranch: string; baseBranch: string; actorId: string; repoId: string; pullId: string; headRepoId: string };
export type RemoteComment = { data: GitHubDiscussionComment; node: string; databaseId: string; authorId: string; root: string; reviewNode: string };
export type RemoteThread = { data: GitHubDiscussionThread; node: string };
export type RemoteReviewer = { data: GitHubReviewer; node: string };
export type DiscussionRemote = { identity: DiscussionIdentity; actor: string; author: string; state: string; locked: boolean; canRequest: boolean; complete: boolean; notices: string[]; comments: RemoteComment[]; threads: RemoteThread[]; reviewers: RemoteReviewer[] };
export const discussionHash = (value: unknown) => scmHash(JSON.stringify(value));
const numericId = (value: unknown) => /^[1-9]\d{0,24}$/.test(String(value)) ? String(value) : "";
const safeBody = (value: unknown) => { if (typeof value !== "string" || Buffer.byteLength(value) > 256 * 1024) throw discussionError("검토 본문을 온전히 읽지 못했습니다."); return value; };
const opaque = (identity: DiscussionIdentity, node: string) => discussionHash([identity.repoId, identity.pullId, node]);
export async function readDiscussion(reader: GitHubReader, expected: Pick<DiscussionIdentity, "repo" | "number" | "headOid" | "baseOid" | "headRepo" | "headBranch" | "baseBranch">, pinned?: DiscussionIdentity): Promise<DiscussionRemote> {
  const [owner, repo] = expected.repo.split("/"), variables = { owner, repo, number: expected.number };
  let budget = 24, bytes = 0;
  const query = async (query: string, variables: object) => {
    if (--budget < 0) throw discussionError("긴 리뷰의 조회 한도에 도달했습니다. 일부 대화만 표시합니다.");
    const raw = object(await reader.json("graphql", { query, variables }, true));
    bytes += Buffer.byteLength(JSON.stringify(raw)); if (bytes > 16 * 1024 * 1024) throw discussionError("리뷰 자료가 16 MiB를 넘어 일부만 읽었습니다.");
    if (array(raw.errors).length) throw discussionError("GitHub가 리뷰 조회 오류를 반환했습니다."); return object(raw.data);
  };
  const result = await query(discussionQuery, variables), base = object(result.repository), pull = object(base.pullRequest), viewer = object(result.viewer), head = object(pull.headRepository);
  const identity: DiscussionIdentity = { ...expected, actorId: string(viewer.id), repoId: string(base.id), pullId: string(pull.id), headRepoId: string(head.id) };
  const verify = (raw: Record<string, unknown>, actor: Record<string, unknown>, repository: Record<string, unknown>) => {
    if (!identity.actorId || !identity.repoId || !identity.pullId || !identity.headRepoId || raw.id !== identity.pullId || raw.number !== expected.number || raw.headRefOid !== expected.headOid || raw.baseRefOid !== expected.baseOid || raw.headRefName !== expected.headBranch || raw.baseRefName !== expected.baseBranch || !sameRepo(string(repository.nameWithOwner), expected.repo) || !sameRepo(string(object(raw.headRepository).nameWithOwner), expected.headRepo) || object(raw.headRepository).id !== identity.headRepoId || repository.id !== identity.repoId || actor.id !== identity.actorId) throw discussionError("리뷰를 읽는 동안 계정·저장소·PR 커밋이 바뀌었습니다. PR을 새로고침하세요.");
    if (pinned && discussionHash(pinned) !== discussionHash(identity)) throw discussionError("리뷰의 계정·저장소 식별자가 바뀌었습니다.");
  };
  verify(pull, viewer, base);
  const out: DiscussionRemote = { identity, actor: string(viewer.login), author: string(object(pull.author).login), state: string(pull.state), locked: pull.locked === true, canRequest: pull.viewerCanUpdate === true, complete: true, notices: [], comments: [], threads: [], reviewers: [] };
  const partial = (text: string) => { out.complete = false; if (!out.notices.includes(text)) out.notices.push(text); };
  const connection = async (initial: unknown, nodeId: string, type: string, field: string, fields: string, label: string) => {
    let c = object(initial); const nodes: unknown[] = [], ids = new Set<string>(), cursors = new Set<string>();
    for (let page = 0; page < 3; page++) {
      if (!Array.isArray(c.nodes) || typeof object(c.pageInfo).hasNextPage !== "boolean") { partial(`${label} 목록을 온전히 읽지 못했습니다.`); break; }
      for (const item of c.nodes) { const n = object(item), id = string(n.id) || JSON.stringify(n); if (ids.has(id)) { partial(`${label} 조회 중 목록이 바뀌었습니다.`); continue; } ids.add(id); nodes.push(item); }
      const info = object(c.pageInfo); if (info.hasNextPage === false) return nodes;
      const cursor = string(info.endCursor); if (!cursor || cursors.has(cursor) || page === 2 || budget <= 1) { partial(`${label}이 많아 일부만 표시합니다.`); break; } cursors.add(cursor);
      try { const next = await query(`query WorkbenchDiscussionPage($id:ID!,$cursor:String!) { node(id:$id) { ... on ${type} { id ${field}(first:100,after:$cursor) { ${connectionFields} nodes { ${fields} } } } } }`, { id: nodeId, cursor }); const node = object(next.node); if (node.id !== nodeId) throw discussionError("리뷰 페이지의 대상을 확인하지 못했습니다."); c = object(node[field]); }
      catch (error) { partial(`${label} 일부를 읽지 못했습니다. ${error instanceof Error ? error.message : String(error)}`); break; }
    }
    return nodes;
  };
  const commentMap = new Map<string, RemoteComment>();
  const comment = (raw: unknown, kind: GitHubDiscussionComment["kind"], thread?: string) => {
    const c = object(raw), node = string(c.id); if (!node) { partial("식별자가 없는 리뷰 댓글을 제외했습니다."); return null; }
    const id = opaque(identity, node), old = commentMap.get(node), review = object(c.pullRequestReview), root = object(c.replyTo);
    try {
      const data: GitHubDiscussionComment = { id, kind, author: string(object(c.author).login) || "삭제된 계정", body: safeBody(c.body), url: publicUrl(c.url), createdAt: string(c.createdAt), updatedAt: string(c.updatedAt), canUpdate: c.viewerCanUpdate === true, canDelete: c.viewerCanDelete === true, canReact: c.viewerCanReact === true,
        reactions: array(c.reactionGroups).flatMap((raw) => { const r = object(raw), content = r.content as typeof githubReactions[number]; return githubReactions.includes(content) ? [{ content, count: Math.max(0, Number(object(r.reactors).totalCount) || 0), mine: r.viewerHasReacted === true }] : []; }),
        ...(kind === "review" ? { state: string(c.state), commit: string(object(c.commit).oid) } : {}),
        ...(kind === "inline" ? { state: string(review.state), commit: string(object(c.commit).oid), review: string(review.id) ? opaque(identity, string(review.id)) : "" } : {}), ...(thread || old?.data.thread ? { thread: thread ?? old?.data.thread } : {}),
      };
      if (old && (old.data.body !== data.body || old.data.updatedAt !== data.updatedAt)) partial("조회 중 댓글이 수정되었습니다. 최신 대화를 다시 확인하세요.");
      commentMap.set(node, { data, node, databaseId: numericId(c.fullDatabaseId), authorId: string(object(c.author).id), root: numericId(root.fullDatabaseId) || numericId(c.fullDatabaseId), reviewNode: string(review.id) }); return id;
    } catch (error) { partial(error instanceof Error ? error.message : String(error)); return null; }
  };
  const conversations = await connection(pull.comments, identity.pullId, "PullRequest", "comments", commonCommentFields, "PR 댓글");
  for (const c of conversations) comment(c, "conversation");
  const reviews = await connection(pull.reviews, identity.pullId, "PullRequest", "reviews", reviewFields, "리뷰");
  for (const r of reviews) { const raw = object(r); comment(r, "review"); const comments = await connection(raw.comments, string(raw.id), "PullRequestReview", "comments", inlineCommentFields, "리뷰의 행 의견"); for (const c of comments) comment(c, "inline"); }
  const threads = await connection(pull.reviewThreads, identity.pullId, "PullRequest", "reviewThreads", threadFields, "검토 스레드");
  for (const raw of threads) {
    const t = object(raw), node = string(t.id); if (!node) { partial("식별자가 없는 검토 스레드를 제외했습니다."); continue; }
    const id = opaque(identity, node), rows = await connection(t.comments, node, "PullRequestReviewThread", "comments", inlineCommentFields, "스레드 답글"), comments = rows.map((c) => comment(c, "inline", id)).filter((id): id is string => !!id);
    out.threads.push({ node, data: { id, path: string(t.path, 8192), side: t.diffSide === "LEFT" ? "LEFT" : "RIGHT", line: integer(t.line), start: integer(t.startLine), originalLine: integer(t.originalLine), originalStart: integer(t.originalStartLine), file: t.subjectType === "FILE", resolved: t.isResolved === true, outdated: t.isOutdated === true, canReply: t.viewerCanReply === true, canResolve: t.viewerCanResolve === true, canUnresolve: t.viewerCanUnresolve === true, comments } });
  }
  const reviewers = await connection(pull.reviewRequests, identity.pullId, "PullRequest", "reviewRequests", reviewerFields, "검토 요청");
  for (const raw of reviewers) { const r = object(object(raw).requestedReviewer), node = string(r.id), kind = r.__typename; if (!node || !["User", "Team", "Bot"].includes(String(kind))) { partial("알 수 없는 검토 요청 유형이 있습니다."); continue; } out.reviewers.push({ node, data: { id: opaque(identity, node), kind: kind as GitHubReviewer["kind"], name: kind === "Team" ? `${string(object(r.organization).login)}/${string(r.slug)}` : string(r.login) } }); }
  out.comments = [...commentMap.values()];
  // Each page is independently read; at minimum the PR identity must remain pinned throughout.
  const final = await query(`query WorkbenchDiscussionIdentity($owner:String!,$repo:String!,$number:Int!) { viewer { id } repository(owner:$owner,name:$repo) { id nameWithOwner pullRequest(number:$number) { ${discussionIdentityFields} } } }`, variables);
  verify(object(object(final.repository).pullRequest), object(final.viewer), object(final.repository));
  const last = object(object(final.repository).pullRequest);
  if (last.state !== pull.state || last.locked !== pull.locked || last.viewerCanUpdate !== pull.viewerCanUpdate) partial("조회 중 PR 상태·잠금·권한이 바뀌었습니다. 대화를 다시 확인하세요.");
  return out;
}
