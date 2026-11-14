import type { Artifact, BrowserPage, Proposal, Session, TranscriptItem } from "@workbench/contracts";
import { statusText } from "../../format.ts";
import type { State } from "../../state.ts";

// 연결: what a conversation made, used and is linked to, from records the app already has.
// 문서 — file cards (created/changed), proposal cards, documents given with a request, files a step
//        read (`reads`), and the gateway's own `readBy` (the revision each session was sent).
// 웹   — web tabs whose AI this conversation opened, pages an engine fetched by address.
// 대화 — the conversation a document/web AI belongs to, its document AIs, relays (세션 잇기) and
//        hand-offs either way. Forks are left out: a fork records its parent only as words.

// Each row says what its target is now: an archived conversation is 보관됨 (it still opens, as
// itself), a closed web tab is 닫힘 (its address opens again in a new tab), a document whose file is
// gone is not offered.
/** `gone`: the file is missing on disk; the row does not open. */
export type DocLink = { artifact: Artifact; state: string; at: number | null; gone: boolean };
export type WebLink =
  | { kind: "tab"; key: string; session: Session; title: string; state: string; closed: boolean; page: BrowserPage | null }
  | { kind: "visit"; key: string; url: string; title: string; at: number };
export type ChatLink = { session: Session; relation: string; archived: boolean };
export type Links = { documents: DocLink[]; web: WebLink[]; chats: ChatLink[] };

const PROPOSAL_STATE: Record<Proposal["status"], string> = { running: "수정 중", pending: "수정안 대기", applied: "수정안 적용", discarded: "수정안 버림", empty: "바뀐 것 없음" };
const LINK_STATE = { active: "진행 중", paused: "멈춤", ended: "끝남" } as const;
const HANDOFF_STATE = { sent: "답 기다림", answered: "답 받음", failed: "실패" } as const;

/** "ctl.example.ac.kr/guide" for https://ctl.example.ac.kr/guide/ */
function pageName(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`.replace(/\/$/, "");
  } catch {
    return url;
  }
}

export function linksOf(session: Session, items: TranscriptItem[], state: State, pages: BrowserPage[]): Links {
  // Documents in the order the note meets them; a write says what was done last, a read never hides one.
  const documents = new Map<string, Omit<DocLink, "gone"> & { wrote: boolean }>();
  const touch = (artifactId: string, what: string, at: number | null, wrote: boolean) => {
    const artifact = state.artifacts[artifactId];
    if (!artifact) return;
    const known = documents.get(artifactId);
    if (!known) documents.set(artifactId, { artifact, state: what, at, wrote });
    else if (wrote || !known.wrote) documents.set(artifactId, { ...known, state: what, at: at ?? known.at, wrote: wrote || known.wrote });
  };
  const byPath = new Map(Object.values(state.artifacts).map((artifact) => [artifact.path, artifact.id]));
  const visits = new Map<string, WebLink>();
  const senders: string[] = [];
  for (const item of items) {
    if (item.kind === "artifact") touch(item.artifactId, item.change === "created" ? "만듦" : "고침", item.at, true);
    else if (item.kind === "proposal") {
      const proposal = state.proposals[item.proposalId];
      if (proposal) touch(proposal.artifactId, PROPOSAL_STATE[proposal.status], item.at, true);
    } else if (item.kind === "user") {
      for (const ref of item.refs ?? []) touch(ref.artifactId, "읽음", item.at, false);
      if (item.from?.sessionId) senders.push(item.from.sessionId);
    } else if (item.kind === "tool") {
      for (const path of item.reads ?? []) { const id = byPath.get(path); if (id) touch(id, "읽음", item.at, false); }
      // Claude names a fetched page by its address; searches (and Codex's web steps) carry no page.
      if (item.tool === "web" && /^https?:\/\//i.test(item.title) && !visits.has(item.title)) visits.set(item.title, { kind: "visit", key: item.title, url: item.title, title: pageName(item.title), at: item.at });
    }
  }
  for (const artifact of Object.values(state.artifacts)) if (artifact.readBy?.[session.id] !== undefined) touch(artifact.id, "읽음", null, false);

  const live = (entry: Session | undefined): entry is Session => Boolean(entry);
  const children = Object.values(state.sessions).filter((entry) => entry.id !== session.id);
  const tabs: WebLink[] = children
    .filter((entry) => entry.pageAgent?.parentSessionId === session.id)
    .map((entry) => {
      const page = pages.find((candidate) => candidate.pageId === entry.pageAgent!.pageId);
      const closed = !page || page.status === "closed" || Boolean(page.closedAt);
      return { kind: "tab", key: entry.id, session: entry, title: page?.title || entry.purpose, state: closed ? "닫힘" : statusText(entry), closed, page: page && /^https?:\/\//i.test(page.url) ? page : null };
    });

  const chats = new Map<string, ChatLink>();
  const relate = (entry: Session | undefined, relation: string) => {
    if (!live(entry) || entry.id === session.id || chats.has(entry.id)) return;
    chats.set(entry.id, { session: entry, relation: entry.archivedAt ? `${relation} · 보관됨` : relation, archived: Boolean(entry.archivedAt) });
  };
  const parent = session.documentAgent?.parentSessionId ?? session.pageAgent?.parentSessionId;
  if (parent) relate(state.sessions[parent], "원래 대화");
  for (const entry of children) if (entry.documentAgent?.parentSessionId === session.id) relate(entry, `문서 AI · ${state.artifacts[entry.documentAgent.artifactId]?.name ?? "문서"}`);
  for (const link of Object.values(state.links)) {
    if (!link.participants.includes(session.id)) continue;
    for (const id of link.participants) relate(state.sessions[id], `세션 잇기 · ${LINK_STATE[link.state]}`);
  }
  const handoffs = Object.values(state.handoffs);
  for (const handoff of handoffs) if (handoff.sourceSessionId === session.id) relate(state.sessions[handoff.targetSessionId], `보낸 요청 · ${HANDOFF_STATE[handoff.status]}`);
  for (const handoff of handoffs) if (handoff.targetSessionId === session.id) relate(state.sessions[handoff.sourceSessionId], "받은 요청");
  for (const id of senders) relate(state.sessions[id], "받은 요청");

  return {
    documents: [...documents.values()].map(({ artifact, state: what, at }) => artifact.diskState === "missing" ? { artifact, state: "파일 없음", at, gone: true } : { artifact, state: what, at, gone: false }),
    web: [...tabs, ...visits.values()],
    chats: [...chats.values()],
  };
}
