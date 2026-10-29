import { useEffect, useMemo, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { FORMAT_LABEL, type CardList, type PkmCard } from "@workbench/contracts";
import { cardDate, groupCards, obsidianUrl, openObsidian, pictureUrl, thumbPath, type PkmTarget } from "../../pkm.ts";
import { useDocs } from "../DocCards.tsx";
import { EngineMark } from "../EngineMark.tsx";
import { Icon } from "../Icon.tsx";
import { useEngineChoice } from "../StartView.tsx";
import type { MenuEntry } from "../ContextMenu.tsx";
import { CardComposer, type ComposerPlace } from "./CardComposer.tsx";
import { usePkm } from "./PkmContext.tsx";
import { paneDrag, usePaneActions, usePaneDragSlice } from "../../panedrag.ts";
import type { PaneItem } from "../../panes.ts";
import "../../styles/pkm.css";

// The card list in the centre (Notebook Navigator style): the notes of a vault folder, the works of
// an app folder, or the sessions and pages of a work. A card opens with a click (Ctrl+click or a
// middle click: in the right pane); a note card dragged onto an input goes with its next request as
// a read-only reference, and any card dragged onto the main area's left or right half opens there.

/** What a card opens in a pane. */
export function cardItem(card: PkmCard): PaneItem {
  if (card.kind === "note") return { kind: "note", path: card.id };
  if (card.kind === "page") return { kind: "doc", id: card.id };
  if (card.kind === "session") return { kind: "session", id: card.id };
  return { kind: "work", id: card.id };
}

/** Status dots as the sidebar draws them. */
const TONE: Partial<Record<NonNullable<PkmCard["status"]>, string>> = { starting: "active", running: "active", interrupting: "active", awaitingApproval: "attention", error: "error" };

/** A picture the gateway serves behind the token. */
export function Picture({ path, alt, className, width, height }: { path: string | null; alt: string; className?: string; width?: number; height?: number }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // A picture on the web (R2, S3 …) is shown from there, without the gateway or its token.
  const remote = path !== null && /^https?:\/\//i.test(path);
  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    if (path && !remote) void pictureUrl(path).then((next) => !cancelled && setUrl(next));
    return () => {
      cancelled = true;
    };
  }, [path, remote]);
  if (failed === path) return null;
  if (remote) return <img src={path} alt={alt} className={className} width={width} height={height} loading="lazy" referrerPolicy="no-referrer" draggable={false} onError={() => setFailed(path)} />;
  return url ? <img src={url} alt={alt} className={className} width={width} height={height} loading="lazy" draggable={false} onError={() => setFailed(path)} /> : null;
}

/** A tag as a pill, in Notebook Navigator's colour for it when there is one. */
export function TagPill({ tag, color }: { tag: string; color: string | null }) {
  return (
    <span className="pkm-tag" style={color ? ({ "--tag-color": color } as CSSProperties) : undefined}>
      #{tag}
    </span>
  );
}

export function tagColor(colors: Record<string, string>, tag: string): string | null {
  const lower = tag.toLowerCase();
  for (let at = lower; at; at = at.includes("/") ? at.slice(0, at.lastIndexOf("/")) : "") if (colors[at]) return colors[at]!;
  return null;
}

function CardView({
  card,
  vaultVersion,
  tagColors,
  onOpen,
  onMenu,
  onPointerDown,
  dragging,
}: {
  card: PkmCard;
  vaultVersion: number;
  tagColors: Record<string, string>;
  onOpen: (event?: ReactMouseEvent) => void;
  onMenu: (x: number, y: number) => void;
  onPointerDown?: (event: ReactPointerEvent) => void;
  dragging: boolean;
}) {
  const thumb = thumbPath(card.thumb, vaultVersion);
  return (
    <article
      role="listitem"
      tabIndex={0}
      className={`pkm-card kind-${card.kind}${dragging ? " dragging" : ""}`}
      data-card-id={card.id}
      onClick={onOpen}
      onAuxClick={(event) => event.button === 1 && onOpen(event)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpen();
        else if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
          const box = event.currentTarget.getBoundingClientRect();
          onMenu(box.left + 24, box.top + 24);
        } else return;
        event.preventDefault();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(event.clientX, event.clientY);
      }}
      onPointerDown={onPointerDown}
    >
      <div className="pkm-card-main">
        <div className="pkm-card-title">
          {card.provider ? <EngineMark provider={card.provider} size={14} /> : card.kind === "page" ? <Icon name="page" size={14} /> : null}
          <span className="pkm-card-name">{card.title}</span>
          {card.pinned ? <Icon name="pin" size={12} className="pkm-card-pin" /> : null}
          {card.status && TONE[card.status] ? <span className={`dot dot-${TONE[card.status]}`} /> : null}
        </div>
        <div className="pkm-card-excerpt">
          <span className="pkm-card-date">{cardDate(card.date)}</span>
          {card.excerpt ? ` ${card.excerpt}` : card.kind === "note" ? <span className="muted"> 내용 없음</span> : null}
        </div>
        {card.stage || card.tags.length || card.sessions || card.engineReads || card.where || card.format ? (
          <div className="pkm-card-meta">
            {card.stage ? <span className="pkm-stage">{card.stage}</span> : null}
            {card.tags.slice(0, 6).map((tag) => (
              <TagPill key={tag} tag={tag} color={tagColor(tagColors, tag)} />
            ))}
            {card.tags.length > 6 ? <span className="muted">+{card.tags.length - 6}</span> : null}
            {card.kind === "note" && card.sessions ? <span className="pkm-card-sessions" title="이 노트를 붙여 보낸 세션">붙인 세션 {card.sessions}</span> : null}
            {card.kind === "note" && card.engineReads ? <span className="pkm-card-sessions" title="엔진이 스스로 이 노트를 읽은 세션">엔진이 읽음 {card.engineReads}</span> : null}
            {card.kind === "work" && card.sessions ? <span className="pkm-card-sessions">세션 {card.sessions}</span> : null}
            {card.format && card.kind === "page" ? <span className="pkm-card-where">{FORMAT_LABEL[card.format]}</span> : null}
            {card.where ? <span className="pkm-card-where">{card.where}</span> : null}
          </div>
        ) : null}
      </div>
      {thumb ? (
        <div className="pkm-card-thumb">
          <Picture path={thumb} alt="" />
        </div>
      ) : null}
    </article>
  );
}

export function CardListView({ target }: { target: Exclude<PkmTarget, { kind: "note" }> }) {
  const pkm = usePkm();
  const docs = useDocs();
  const [descendants, setDescendants] = useState(true);
  const [list, setList] = useState<CardList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<{ path: string; title: string }[]>([]);
  const [engine, setEngine] = useEngineChoice();
  const panes = usePaneActions();
  // The card being dragged (with the pointer: the desktop webview's HTML drag and drop is unreliable).
  const dragging = usePaneDragSlice((drag) => (drag?.own ? JSON.stringify(drag.item) : ""));
  const key = target.kind === "vault" ? `vault:${target.path}` : target.kind === "view" ? `view:${target.id}` : `${target.kind}:${target.id}`;
  const vaultVersion = pkm.state.pkm.vault ?? 0;
  const status = pkm.tree?.status;

  // Cards of app folders, works and views follow sessions and documents; a short pause groups changes.
  const { works, sessions, artifacts } = pkm.state;
  const followsApp = target.kind !== "vault";
  const appVersion = followsApp ? `${Object.keys(works).length}:${Object.keys(sessions).length}:${Object.keys(artifacts).length}` : "";
  const viewVersion = target.kind === "view" ? `${pkm.state.pkm.views ?? 0}:${pkm.state.pkm.rules ?? 0}` : "";
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!followsApp) return;
    const timer = window.setTimeout(() => setTick((value) => value + 1), 600);
    return () => window.clearTimeout(timer);
  }, [followsApp, works, sessions, artifacts]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    pkm.client
      .cards(target, descendants)
      .then((next) => !cancelled && setList(next))
      .catch((reason: Error) => !cancelled && setError(reason.message));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, descendants, vaultVersion, tick, appVersion, viewVersion]);

  const attach = (card: PkmCard) => {
    if (card.kind !== "note") return;
    if (!card.id.endsWith(".md")) {
      pkm.onToast("마크다운 노트만 요청에 붙일 수 있습니다.");
      return;
    }
    setNotes((current) => (current.some((note) => note.path === card.id) ? current : [...current, { path: card.id, title: card.title }]));
  };

  const open = (card: PkmCard, event?: ReactMouseEvent) => {
    if (paneDrag.justDragged()) return;
    if (event && panes && (event.button === 1 || event.ctrlKey || event.metaKey)) return panes.openBeside(cardItem(card));
    if (card.kind === "note") pkm.open?.({ kind: "note", path: card.id });
    else if (card.kind === "page") docs.actions.openArtifact(card.id);
    else if (card.kind === "session") docs.actions.openSession(card.id);
    else {
      const work = pkm.state.works[card.id];
      if (work) pkm.showWork(work);
    }
  };

  const menu = (card: PkmCard, x: number, y: number) => {
    const vaultPath = status?.path;
    const items: MenuEntry[] = [
      { kind: "item", label: "열기", icon: card.kind === "note" || card.kind === "page" ? "page" : "chat", hint: "Enter", onSelect: () => open(card) },
      ...(panes ? [{ kind: "item" as const, label: "오른쪽에 열기", icon: "columns" as const, hint: "Ctrl+클릭", onSelect: () => panes.openBeside(cardItem(card)) }] : []),
    ];
    if (card.kind === "note") {
      items.push({ kind: "item", label: "요청에 붙이기", icon: "plus", onSelect: () => attach(card) });
      // Pinned to a work, a note's path goes into the context card of that work's new sessions.
      const pins = pkm.pkmState?.pins ?? {};
      const works = Object.values(pkm.state.works)
        .filter((work) => !work.archivedAt)
        .sort((a, b) => Number(b.id === (target.kind === "work" ? target.id : "")) - Number(a.id === (target.kind === "work" ? target.id : "")) || b.updatedAt - a.updatedAt)
        .slice(0, 8);
      if (target.kind === "work" && pins[target.id]?.includes(card.id)) {
        items.push({ kind: "item", label: "이 작업에서 고정 풀기", icon: "pin", onSelect: () => void pkm.client.pin(target.id, card.id, false).catch((reason: Error) => pkm.onToast(reason.message)) });
      } else if (works.length) {
        items.push({
          kind: "submenu",
          label: "작업에 고정",
          icon: "pin",
          items: works.map((work) => {
            const pinned = pins[work.id]?.includes(card.id) ?? false;
            return {
              kind: "item" as const,
              label: work.title,
              checked: pinned,
              onSelect: () =>
                void pkm.client
                  .pin(work.id, card.id, !pinned)
                  .then(() => pkm.onToast(pinned ? `「${work.title}」에서 고정을 풀었습니다.` : `「${work.title}」에 고정했습니다. 그 작업의 새 세션이 이 노트 경로를 받습니다.`))
                  .catch((reason: Error) => pkm.onToast(reason.message)),
            };
          }),
        });
      }
      if (vaultPath) items.push({ kind: "item", label: "Obsidian에서 열기", icon: "external", onSelect: () => void openObsidian(obsidianUrl(vaultPath, card.id)).catch(() => undefined) });
    }
    pkm.openMenu({ x, y, title: card.title, items });
  };

  // A view grouped by a key comes with its groups; everything else is grouped by date.
  const groups = useMemo(() => {
    if (!list?.groups) return groupCards(list?.cards ?? []);
    const byKey = new Map(list.cards.map((card) => [`${card.kind}:${card.id}`, card]));
    return list.groups.map((group) => ({ label: group.label, cards: group.ids.map((id) => byKey.get(id)).filter((card): card is PkmCard => Boolean(card)) }));
  }, [list]);
  const view = target.kind === "view" ? pkm.pkmState?.views.find((entry) => entry.id === target.id) : undefined;
  const place: ComposerPlace = target.kind === "work" ? { kind: "work", workId: target.id } : { kind: "new", folderId: target.kind === "folder" ? target.id : null };
  const noun = target.kind === "vault" ? "노트" : target.kind === "folder" ? "작업" : "항목";

  return (
    <main className="pkm-view">
      <header className="column pkm-head">
        <div className="pkm-crumbs">{(list?.crumbs ?? []).slice(0, -1).join(" › ")}</div>
        <div className="pkm-title-row">
          <h1 className="pkm-title">{list?.title ?? ""}</h1>
          <span className="pkm-count">
            {noun} {list?.total ?? 0}
            {list && list.total > list.cards.length ? ` · 최근 ${list.cards.length}개만` : ""}
          </span>
          {view ? <code className="pkm-query">{view.query}</code> : null}
          <span className="pkm-head-tools">
            {view ? (
              <button type="button" className="ghost-button small" onClick={() => pkm.setDialog({ kind: "view", id: view.id })}>
                <Icon name="edit" size={14} /> 고치기
              </button>
            ) : null}
            {target.kind === "vault" ? (
              <>
                <label className="check-row pkm-check" title="하위 폴더의 노트도 함께 봅니다">
                  <input type="checkbox" checked={descendants} onChange={(event) => setDescendants(event.target.checked)} />
                  하위 폴더 포함
                </label>
                {status?.path ? (
                  <button type="button" className="ghost-button small" onClick={() => void openObsidian(obsidianUrl(status.path!, target.path)).catch(() => undefined)} title="이 폴더를 Obsidian에서 엽니다">
                    <Icon name="external" size={14} /> Obsidian에서 열기
                  </button>
                ) : null}
              </>
            ) : null}
          </span>
        </div>
      </header>
      <div className="pkm-scroll">
        <div className="column pkm-cards" role="list" aria-label={`${list?.title ?? ""} 카드`}>
          {error ? <div className="notice notice-error">{error}</div> : null}
          {list?.problems?.length ? <div className="notice notice-info">읽지 못한 조건은 빼고 보입니다: {list.problems.join(" ")}</div> : null}
          {list && !list.cards.length ? (
            <div className="empty-hint">{target.kind === "vault" ? "이 폴더에 노트가 없습니다." : target.kind === "folder" ? "이 폴더에 작업이 없습니다." : target.kind === "view" ? "이 보기에 맞는 것이 없습니다." : "아직 세션이나 페이지가 없습니다."}</div>
          ) : null}
          {groups.map((group) => (
            <section key={group.label} className="pkm-group" aria-label={group.label}>
              <div className="pkm-group-label">{group.label}</div>
              {group.cards.map((card) => (
                <CardView
                  key={`${card.kind}:${card.id}`}
                  card={card}
                  vaultVersion={vaultVersion}
                  tagColors={pkm.tree?.tagColors ?? {}}
                  dragging={dragging === JSON.stringify(cardItem(card))}
                  onOpen={(event) => open(card, event)}
                  onMenu={(x, y) => menu(card, x, y)}
                  onPointerDown={(event) => {
                    if (event.button === 1 && panes) event.preventDefault();
                    paneDrag.press({ item: cardItem(card), label: card.title }, event);
                  }}
                />
              ))}
            </section>
          ))}
        </div>
      </div>
      <CardComposer draftKey={key} place={place} notes={notes} onNotes={setNotes} engine={engine} setEngine={setEngine} dropping={false} />
    </main>
  );
}
