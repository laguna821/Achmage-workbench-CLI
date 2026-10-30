import { randomUUID } from "node:crypto";
import { scmPatchRows, type GitHubActionContext, type GitHubDiscussionDraft, type GitHubDiscussionOperation, type GitHubDiscussionView, type GitHubEffect, type GitHubInlineSelection, type GitHubView } from "@workbench/contracts";
import type { Store } from "./store.ts";
import type { GitHubReviews } from "./github.ts";
import { GitHubWriteError, type GitHubWrite } from "./github-reader.ts";
import { object, string } from "./github-data.ts";
import { commentSignature, discussionError, discussionLabels, discussionOperation, discussionText, inlineDrafts, inlineSelection, reviewEvent, reviewState } from "./github-discussion-data.ts";
import { discussionHash as hash, readDiscussion, type DiscussionIdentity, type DiscussionRemote, type RemoteComment } from "./github-discussion-read.ts";

type Snapshot = { data: GitHubDiscussionView; remote: DiscussionRemote };
type Anchor = { path: string; side: "LEFT" | "RIGHT" | "FILE"; start?: number; end?: number; quote: string[] };
export type DiscussionPlan = {
  identity: DiscussionIdentity; operation: GitHubDiscussionOperation; baseline: string; target: string | null;
  thread: string | null; reviewers: { node: string; kind: string; name: string }[]; anchors: Anchor[];
  before: string[]; request: GitHubWrite; label: string; evidence: string[]; ack: string | null;
};
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const gql = (name: string, input: object, fields: string): GitHubWrite => ({ method: "POST", endpoint: "graphql", body: { query: `mutation WorkbenchDiscussionAction($input:${name[0]!.toUpperCase() + name.slice(1)}Input!) { ${name}(input:$input) { clientMutationId ${fields} } }`, variables: { input } } });
const scope = (v: GitHubView) => { const p = v.pull; if (!p || v.stale) throw discussionError("최신 PR 하나를 선택하세요."); return { repo: p.baseRepo, number: p.number, headOid: p.headOid, baseOid: p.baseOid, headRepo: p.headRepo, headBranch: p.headBranch, baseBranch: p.baseBranch }; };
function operationStamp(remote: DiscussionRemote, op: GitHubDiscussionOperation) {
  const target = "target" in op ? op.target : "", comment = remote.comments.find((c) => c.data.id === target), thread = remote.threads.find((t) => t.data.id === target || t.data.id === comment?.data.thread);
  const pending = remote.comments.filter((c) => c.data.kind === "review" && c.authorId === remote.identity.actorId && c.data.state === "PENDING");
  return hash([remote.identity, remote.state, remote.locked, remote.canRequest, remote.complete,
    comment ? commentSignature(comment.data) : null, thread?.data ?? null,
    op.kind === "request-review" || op.kind === "remove-reviewer" ? remote.reviewers : null,
    ["inline", "review", "reply", "submit-pending", "discard-pending"].includes(op.kind) ? pending.map((p) => [commentSignature(p.data), remote.comments.filter((c) => c.reviewNode === p.node).map((c) => commentSignature(c.data))]) : null,
  ]);
}
export class GitHubDiscussions {
  private store: Store; private reviews: GitHubReviews; private assertActive: (workspaceId: string) => void;
  private snapshots = new Map<string, Snapshot>();
  constructor(store: Store, reviews: GitHubReviews, assertActive: (workspaceId: string) => void) { this.store = store; this.reviews = reviews; this.assertActive = assertActive; }
  async load(workspaceId: string, id: string, revision: string) {
    this.assertActive(workspaceId); const { view } = await this.reviews.actionScope(workspaceId, id, revision), remote = await readDiscussion(this.reviews.reader, scope(view));
    await this.reviews.actionScope(workspaceId, id, revision);
    const files = view.files.map((f) => ({ ...f, id: hash([remote.identity.repoId, remote.identity.pullId, remote.identity.headOid, remote.identity.baseOid, f.path]) }));
    const stable = { actor: remote.actor, author: remote.author, repo: remote.identity.repo, number: remote.identity.number, headOid: remote.identity.headOid, baseOid: remote.identity.baseOid, state: remote.state, locked: remote.locked, canRequest: remote.canRequest, complete: remote.complete, notices: remote.notices, comments: remote.comments.map((c) => c.data), threads: remote.threads.map((t) => t.data), reviewers: remote.reviewers.map((r) => r.data), files };
    const data: GitHubDiscussionView = { ...stable, id: randomUUID(), revision: hash([remote.identity, stable]), workspaceId, viewId: id, viewRevision: revision, checkedAt: Date.now() };
    this.snapshots.set(data.id, { data, remote });
    let bytes = [...this.snapshots.values()].reduce((n, value) => n + Buffer.byteLength(JSON.stringify(value)), 0);
    while (this.snapshots.size > 32 || bytes > 32 * 1024 * 1024) { const first = this.snapshots.keys().next().value!; bytes -= Buffer.byteLength(JSON.stringify(this.snapshots.get(first))); this.snapshots.delete(first); }
    if (!this.snapshots.has(data.id)) throw discussionError("리뷰 대화가 보관 한도를 넘었습니다. 범위를 줄여 확인하세요."); return copy(data);
  }
  snapshot(workspaceId: string, id: string, revision?: string) {
    this.assertActive(workspaceId); const s = this.snapshots.get(id);
    if (!s || s.data.workspaceId !== workspaceId || revision !== undefined && s.data.revision !== revision || Date.now() - s.data.checkedAt > 30 * 60000) throw discussionError("리뷰 대화가 만료되었습니다. 입력을 유지한 채 새로고침하세요."); return s;
  }
  private draftKey(s: Snapshot) { return `github-discussion-draft:v1:${hash([s.data.workspaceId, s.remote.identity.repoId, s.remote.identity.pullId])}`; }
  draft(workspaceId: string, id: string): GitHubDiscussionDraft {
    const s = this.snapshot(workspaceId, id), raw = this.store.getMeta(this.draftKey(s));
    return raw ? JSON.parse(raw) : { version: 0, headOid: s.data.headOid, mode: "comment", target: "", body: "", event: "COMMENT", selection: null, comments: [] };
  }
  saveDraft(workspaceId: string, id: string, value: GitHubDiscussionDraft) {
    const s = this.snapshot(workspaceId, id);
    if (!value || !["comment", "reply", "edit-comment", "inline", "review"].includes(value.mode) || typeof value.target !== "string" || value.target.length > 100 || typeof value.headOid !== "string" || !/^[a-f0-9]{40,64}$/.test(value.headOid)) throw discussionError("리뷰 초안을 확인하세요.");
    const next = { version: value.version + 1, headOid: value.headOid, mode: value.mode, target: value.target, body: discussionText(value.body, false), event: reviewEvent(value.event), selection: value.selection ? inlineSelection(value.selection) : null, comments: inlineDrafts(value.comments) };
    if (Buffer.byteLength(JSON.stringify(next)) > 256 * 1024) throw discussionError("리뷰 초안이 256 KiB를 넘습니다.");
    return this.store.transaction(() => { if (this.draft(workspaceId, id).version !== value.version) throw discussionError("다른 창에서 리뷰 초안이 바뀌었습니다. 입력을 유지한 채 저장된 초안을 확인하세요."); this.store.setMeta(this.draftKey(s), JSON.stringify(next)); return next; });
  }
  private anchor(s: Snapshot, selection: GitHubInlineSelection): Anchor {
    const file = s.data.files.find((f) => f.id === selection.file); if (!file) throw discussionError("이 PR 커밋의 파일을 다시 선택하세요.");
    if (selection.side === "FILE") return { path: file.path, side: "FILE", quote: [] };
    const parsed = scmPatchRows(file.patch); if (!parsed.valid || file.notice) throw discussionError("일부만 제공된 차이에는 행 의견을 붙일 수 없습니다. 파일 의견을 사용하세요.");
    const key = selection.side === "LEFT" ? "before" : "after", rows = parsed.rows.filter((r) => r[key] !== undefined && r[key]! >= selection.start && r[key]! <= selection.end);
    if (rows.length !== selection.end - selection.start + 1 || new Set(rows.map((r) => r[key])).size !== rows.length) throw discussionError("행 범위가 현재 차이의 연속된 행 안에 있어야 합니다.");
    let hunk = 0; const hunks = new Set<number>(); for (const row of parsed.rows) { if (row.kind === "hunk") hunk++; if (rows.includes(row)) hunks.add(hunk); } if (hunks.size !== 1) throw discussionError("하나의 변경 구간 안에서 행 범위를 선택하세요.");
    return { path: file.path, side: selection.side, start: selection.start, end: selection.end, quote: rows.map((r) => r.text) };
  }
  async prepare(workspaceId: string, context: GitHubActionContext, id: string, revision: string, operation: GitHubDiscussionOperation): Promise<DiscussionPlan> {
    const s = this.snapshot(workspaceId, id, revision), op = discussionOperation(operation), d = s.data, r = s.remote, i = r.identity;
    if (d.viewId !== context.viewId || d.viewRevision !== context.viewRevision || d.headOid !== context.headOid || d.repo !== context.repo || d.number !== context.number || d.actor !== context.actor) throw discussionError("PR 작업과 리뷰 대화의 대상이 다릅니다. 새로고침하세요.");
    if (!r.complete) throw discussionError("리뷰 대화를 일부만 읽었습니다. 전체 대화를 확인한 뒤 변경하세요.");
    if (r.locked && !context.canUpdate) throw discussionError("잠긴 대화에 참여할 권한을 확인하세요.");
    const target = "target" in op ? r.comments.find((c) => c.data.id === op.target) : undefined, thread = "target" in op ? r.threads.find((t) => t.data.id === op.target || t.data.id === target?.data.thread) : undefined;
    const ownPending = r.comments.filter((c) => c.data.kind === "review" && c.authorId === i.actorId && c.data.state === "PENDING");
    const plan: DiscussionPlan = { identity: copy(i), operation: op, baseline: operationStamp(r, op), target: target?.node ?? null, thread: thread?.node ?? null, reviewers: [], anchors: [], before: r.comments.map((c) => c.node), request: { method: "POST", endpoint: "graphql" }, label: discussionLabels[op.kind], evidence: [], ack: null };
    if (target) plan.evidence.push(`${target.data.author} · ${target.data.url ?? ""}\n${target.data.body}`);
    const requireComment = () => { if (!target) throw discussionError("선택한 리뷰 댓글이 없습니다."); return target; };
    const requirePending = () => { const c = requireComment(); if (c.data.kind !== "review" || c.authorId !== i.actorId || c.data.state !== "PENDING" || !c.data.canDelete && op.kind === "discard-pending") throw discussionError("현재 계정이 작성 중인 리뷰를 선택하세요."); const children = r.comments.filter((n) => n.reviewNode === c.node); plan.evidence.push(...children.map((c) => `포함된 행 의견 · ${c.data.url ?? ""}\n${c.data.body}`)); return c; };
    const requireReview = (event: string, body: string) => { if (r.state !== "OPEN") throw discussionError("열린 PR에 리뷰를 제출할 수 있습니다."); if (event !== "COMMENT" && r.author.toLowerCase() === r.actor.toLowerCase()) throw discussionError("본인의 PR에는 승인·변경 요청 리뷰를 제출할 수 없습니다."); if (event !== "APPROVE" && !body.trim()) throw discussionError("의견·변경 요청 리뷰에는 본문을 입력하세요."); };
    if (["inline", "review", "reply"].includes(op.kind) && ownPending.length) throw discussionError("GitHub에 작성 중인 리뷰가 있습니다. 내용을 확인해 제출하거나 삭제한 뒤 새 의견을 게시하세요.");
    switch (op.kind) {
      case "comment": plan.request = gql("addComment", { subjectId: i.pullId, body: op.body }, "commentEdge { node { id } }"); break;
      case "reply": { const c = requireComment(); if (c.data.kind !== "inline" || !thread?.data.canReply || !thread.data.comments.includes(c.data.id) || !c.root) throw discussionError("답글을 달 수 있는 검토 스레드를 선택하세요."); plan.request = { method: "POST", endpoint: `repos/${i.repo}/pulls/${i.number}/comments/${c.root}/replies`, body: { body: op.body } }; break; }
      case "edit-comment": { const c = requireComment(); if (!c.data.canUpdate) throw discussionError("댓글을 수정할 권한이 없습니다."); const name = c.data.kind === "conversation" ? "updateIssueComment" : c.data.kind === "review" ? "updatePullRequestReview" : "updatePullRequestReviewComment"; const id = c.data.kind === "conversation" ? "id" : c.data.kind === "review" ? "pullRequestReviewId" : "pullRequestReviewCommentId"; const field = c.data.kind === "conversation" ? "issueComment" : c.data.kind === "review" ? "pullRequestReview" : "pullRequestReviewComment"; plan.request = gql(name, { [id]: c.node, body: op.body }, `${field} { id }`); break; }
      case "delete-comment": { const c = requireComment(); if (!c.data.canDelete || c.data.kind === "review") throw discussionError("삭제할 수 있는 댓글을 선택하세요. 작성 중인 리뷰는 리뷰 삭제를 사용하세요."); plan.request = gql(c.data.kind === "conversation" ? "deleteIssueComment" : "deletePullRequestReviewComment", { [c.data.kind === "conversation" ? "id" : "id"]: c.node }, ""); break; }
      case "reaction": { const c = requireComment(); if (!c.data.canReact || c.data.reactions.some((r) => r.content === op.content && r.mine) === op.add) throw discussionError("반응 상태가 이미 바뀌었습니다. 대화를 새로고침하세요."); plan.request = gql(op.add ? "addReaction" : "removeReaction", { subjectId: c.node, content: op.content }, "subject { id }"); break; }
      case "resolve": if (!thread || (op.resolved ? !thread.data.canResolve : !thread.data.canUnresolve) || thread.data.resolved === op.resolved) throw discussionError("스레드의 해결 권한·상태가 바뀌었습니다."); plan.request = gql(op.resolved ? "resolveReviewThread" : "unresolveReviewThread", { threadId: thread.node }, "thread { id isResolved }"); break;
      case "request-review": {
        if (!r.canRequest || r.state !== "OPEN") throw discussionError("검토 요청 권한과 PR 상태를 확인하세요.");
        for (const name of op.reviewers) {
          const parts = name.split("/"), team = parts.length === 2;
          if (team && parts[0]!.toLowerCase() !== i.repo.split("/")[0]!.toLowerCase()) throw discussionError("PR 저장소와 같은 조직의 팀을 선택하세요.");
          const raw = object(await this.reviews.reader.json("graphql", { query: team ? "query WorkbenchDiscussionReviewer($org:String!,$slug:String!) { organization(login:$org) { team(slug:$slug) { id slug organization { login } } } }" : "query WorkbenchDiscussionReviewer($login:String!) { user(login:$login) { id login } }", variables: team ? { org: parts[0], slug: parts[1] } : { login: name } }, true)), data = object(raw.data), item = team ? object(object(data.organization).team) : object(data.user), canonical = team ? `${string(object(item.organization).login)}/${string(item.slug)}` : string(item.login);
          if (!string(item.id) || canonical.toLowerCase() !== name.toLowerCase()) throw discussionError(`검토자 ${name}을 확인하지 못했습니다.`);
          if (!team && canonical.toLowerCase() === r.author.toLowerCase()) throw discussionError("PR 작성자에게 검토를 요청할 수 없습니다.");
          plan.reviewers.push({ node: string(item.id), kind: team ? "Team" : "User", name: canonical });
        }
        if (plan.reviewers.every((a) => r.reviewers.some((b) => b.node === a.node))) throw discussionError("이미 요청한 검토자입니다.");
        plan.request = gql("requestReviews", { pullRequestId: i.pullId, userIds: plan.reviewers.filter((r) => r.kind === "User").map((r) => r.node), teamIds: plan.reviewers.filter((r) => r.kind === "Team").map((r) => r.node), union: true }, "pullRequest { id }"); plan.evidence.push(...plan.reviewers.map((r) => `${r.kind}: ${r.name}`)); break;
      }
      case "remove-reviewer": {
        const selected = r.reviewers.find((r) => r.data.id === op.target); if (!r.canRequest || !selected || r.state !== "OPEN") throw discussionError("취소할 검토 요청을 확인하세요.");
        plan.target = selected.node; plan.reviewers = r.reviewers.filter((r) => r.node !== selected.node).map((r) => ({ node: r.node, kind: r.data.kind, name: r.data.name }));
        if (selected.data.kind === "Bot") {
          plan.request = gql("requestReviews", { pullRequestId: i.pullId, userIds: plan.reviewers.filter((r) => r.kind === "User").map((r) => r.node), teamIds: plan.reviewers.filter((r) => r.kind === "Team").map((r) => r.node), botIds: plan.reviewers.filter((r) => r.kind === "Bot").map((r) => r.node), union: false }, "pullRequest { id }");
          plan.evidence.push("봇 요청 취소는 확인한 검토자 목록 전체를 다시 설정합니다. 전송 순간 다른 사용자가 추가한 요청은 보존하지 못할 수 있습니다.");
        } else plan.request = { method: "DELETE", endpoint: `repos/${i.repo}/pulls/${i.number}/requested_reviewers`, body: { reviewers: selected.data.kind === "User" ? [selected.data.name] : [], team_reviewers: selected.data.kind === "Team" ? [selected.data.name.split("/")[1]] : [] } };
        plan.evidence.push(`취소: ${selected.data.name}`, `유지: ${plan.reviewers.map((r) => r.name).join(", ") || "없음"}`); break;
      }
      case "inline": {
        if (r.state !== "OPEN") throw discussionError("열린 PR에 파일 의견을 게시하세요.");
        const a = this.anchor(s, op.selection); plan.anchors.push(a); plan.request = { method: "POST", endpoint: `repos/${i.repo}/pulls/${i.number}/comments`, body: { body: op.body, commit_id: i.headOid, path: a.path, ...(a.side === "FILE" ? { subject_type: "file" } : { subject_type: "line", side: a.side, line: a.end, ...(a.start !== a.end ? { start_line: a.start, start_side: a.side } : {}) }) } }; break;
      }
      case "review": {
        requireReview(op.event, op.body);
        const threads = op.comments.map((c) => { const a = this.anchor(s, c.selection); if (a.side === "FILE") throw discussionError("묶음 리뷰에는 행 의견을 넣으세요. 파일 의견은 별도로 게시할 수 있습니다."); plan.anchors.push(a); return { body: c.body, path: a.path, side: a.side, line: a.end, ...(a.start !== a.end ? { startLine: a.start, startSide: a.side } : {}) }; });
        plan.request = gql("addPullRequestReview", { pullRequestId: i.pullId, commitOID: i.headOid, event: op.event, body: op.body, threads }, "pullRequestReview { id state }"); break;
      }
      case "submit-pending": { const c = requirePending(); requireReview(op.event, op.body); if (c.data.commit !== i.headOid) throw discussionError("작성 중인 리뷰의 커밋이 현재 PR과 다릅니다. 기존 리뷰를 확인하세요."); plan.request = gql("submitPullRequestReview", { pullRequestReviewId: c.node, event: op.event, body: op.body }, "pullRequestReview { id state }"); break; }
      case "discard-pending": { const c = requirePending(); plan.request = gql("deletePullRequestReview", { pullRequestReviewId: c.node }, "pullRequestReview { id }"); break; }
    }
    plan.evidence.push(...plan.anchors.map((a) => `${a.path} · ${a.side === "FILE" ? "파일" : `${a.side} ${a.start}–${a.end}행`}\n${a.quote.join("\n")}`));
    if (Buffer.byteLength(JSON.stringify(plan)) > 512 * 1024) throw discussionError("리뷰 묶음이 너무 큽니다. 선택을 줄이세요.");
    await this.current(plan); await this.reviews.actionScope(workspaceId, d.viewId, d.viewRevision); return plan;
  }
  async current(plan: DiscussionPlan) {
    const now = await readDiscussion(this.reviews.reader, plan.identity, plan.identity);
    if (!now.complete || operationStamp(now, plan.operation) !== plan.baseline) throw discussionError("댓글·스레드·검토 요청 또는 권한이 바뀌었습니다. 입력을 유지한 채 대화를 새로고침하세요."); return now;
  }
  request(plan: DiscussionPlan, clientMutationId: string) {
    const request = copy(plan.request); if (request.endpoint === "graphql") { const body = object(request.body), variables = object(body.variables); request.body = { ...body, variables: { ...variables, input: { ...object(variables.input), clientMutationId } } }; } return request;
  }
  acknowledge(plan: DiscussionPlan, value: unknown) {
    const op = plan.operation;
    if (!["comment", "inline", "reply", "review"].includes(op.kind)) return;
    const raw = object(value), payload = object(Object.values(object(raw.data))[0]);
    const node = plan.request.endpoint === "graphql" ? string(op.kind === "comment" ? object(object(payload.commentEdge).node).id : object(payload.pullRequestReview).id) : string(raw.node_id);
    if (!node || plan.before.includes(node)) throw new GitHubWriteError("게시 응답에서 새 댓글·리뷰 식별자를 확인하지 못했습니다.", false); plan.ack = node;
  }
  async reconcile(plan: DiscussionPlan, effect: GitHubEffect) {
    let now: DiscussionRemote;
    try { now = await readDiscussion(this.reviews.reader, plan.identity, plan.identity); }
    catch (error) { if (error instanceof Error && /바뀌었습니다/.test(error.message)) { effect.phase = "changed"; effect.detail = "전송 후 PR 커밋·계정이 바뀌었습니다. GitHub의 게시 결과를 확인하세요."; return; } throw error; }
    const op = plan.operation, target = now.comments.find((c) => c.node === plan.target), thread = now.threads.find((t) => t.node === plan.thread);
    let matches = false; let found: RemoteComment | undefined;
    if (op.kind === "comment" || op.kind === "inline" || op.kind === "reply" || op.kind === "review") {
      const expectedKind = op.kind === "comment" ? "conversation" : op.kind === "review" ? "review" : "inline";
      const candidates = now.comments.filter((c) => c.data.kind === expectedKind && c.authorId === plan.identity.actorId && c.data.body === op.body && (plan.ack ? c.node === plan.ack : !plan.before.includes(c.node)) && (op.kind !== "review" || c.data.state === reviewState(op.event) && c.data.commit === plan.identity.headOid) && (op.kind !== "inline" || c.data.commit === plan.identity.headOid) && (op.kind !== "reply" || c.data.thread === thread?.data.id));
      if (candidates.length === 1 && (plan.ack || now.complete)) { found = candidates[0]; matches = true; }
      if (matches && plan.anchors.length) {
        matches = plan.anchors.every((a, index) => now.threads.some((t) => t.data.path === a.path && (a.side === "FILE" ? t.data.file : t.data.side === a.side && t.data.line === a.end && (t.data.start ?? t.data.line) === a.start) && t.data.comments.some((id) => { const c = now.comments.find((c) => c.data.id === id); return c && (op.kind === "review" ? c.reviewNode === found!.node && c.data.body === op.comments[index]?.body : c.node === found!.node); })));
      }
    } else if (op.kind === "edit-comment") matches = target?.data.body === op.body;
    else if (op.kind === "delete-comment" || op.kind === "discard-pending") matches = now.complete && !target;
    else if (op.kind === "reaction") matches = !!target && target.data.reactions.some((r) => r.content === op.content && r.mine) === op.add;
    else if (op.kind === "resolve") matches = thread?.data.resolved === op.resolved;
    else if (op.kind === "request-review") matches = plan.reviewers.every((r) => now.reviewers.some((n) => n.node === r.node));
    else if (op.kind === "remove-reviewer") matches = now.complete && !now.reviewers.some((r) => r.node === plan.target) && plan.reviewers.every((r) => now.reviewers.some((n) => n.node === r.node));
    else if (op.kind === "submit-pending") matches = target?.data.state === reviewState(op.event) && target.data.body === op.body && target.data.commit === plan.identity.headOid;
    effect.phase = matches ? "complete" : "uncertain"; effect.detail = matches ? `원격에서 요청한 리뷰 상태를 확인했습니다.${!plan.ack && ["comment", "inline", "reply", "review"].includes(op.kind) ? " 응답이 없어 같은 계정의 다른 게시일 가능성은 남아 있습니다." : ""}` : "원격에서 요청 결과를 확정하지 못했습니다. 자동 재전송 없이 GitHub와 실행 기록을 확인하세요.";
    if (matches) { effect.outcome = "updated"; effect.number = plan.identity.number; effect.url = found?.data.url ?? target?.data.url ?? `https://github.com/${plan.identity.repo}/pull/${plan.identity.number}`; }
  }
}
