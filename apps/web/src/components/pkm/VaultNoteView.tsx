import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { Components } from "react-markdown";
import type { VaultNote } from "@workbench/contracts";
import { ObsidianMarkdown, obsidianComponents, pictureSize, type EmbedProps } from "../../markdown/obsidian.tsx";
import { cardDate, noteSection, obsidianUrl, openObsidian, vaultMarkdown } from "../../pkm.ts";
import { diagramComponents } from "../Diagram.tsx";
import { Icon } from "../Icon.tsx";
import { useEngineChoice } from "../StartView.tsx";
import { CardComposer } from "./CardComposer.tsx";
import { Picture, TagPill, tagColor } from "./CardListView.tsx";
import { usePkm } from "./PkmContext.tsx";
import "../../styles/pkm.css";

const DRAWN = diagramComponents();

/** How deep `![[note]]` has gone: a note shown inside a note inside a note is only a link. */
const EmbedDepth = createContext(0);
const MAX_EMBED_DEPTH = 2;

/** `![[another note]]`: that note (or the heading or block named) in place, its name opening it. */
function NoteEmbed({ path, heading, label, components, version }: EmbedProps & { components: Components; version: number }) {
  const pkm = usePkm();
  const depth = useContext(EmbedDepth);
  const [note, setNote] = useState<VaultNote | null>(null);
  const [failed, setFailed] = useState(false);
  const markdown = /\.md$/i.test(path);
  const shown = markdown && depth < MAX_EMBED_DEPTH;
  useEffect(() => {
    if (!shown) return;
    let cancelled = false;
    pkm.client
      .note(path)
      .then((next) => !cancelled && setNote(next))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, shown, version]);
  const vaultPath = pkm.tree?.status.path ?? null;
  const open = () => {
    if (markdown) pkm.open?.({ kind: "note", path });
    else if (vaultPath) void openObsidian(obsidianUrl(vaultPath, path)).catch(() => undefined);
  };
  const part = note ? noteSection(note.body, heading) : "";
  return (
    <div className="note-embed">
      <button type="button" className="link note-embed-head" onClick={open} title={markdown ? "이 노트 열기" : "Obsidian에서 열기"}>
        <Icon name={markdown ? "page" : "external"} size={13} /> {label}
        {heading ? ` › ${heading.replace(/^\^/, "")}` : ""}
      </button>
      {!shown ? null : failed ? (
        <div className="muted">노트를 불러오지 못했습니다.</div>
      ) : !note ? (
        <div className="muted">불러오는 중…</div>
      ) : part ? (
        <EmbedDepth.Provider value={depth + 1}>
          <div className="note-embed-body">
            <ObsidianMarkdown components={components}>{vaultMarkdown(part, note, version)}</ObsidianMarkdown>
          </div>
        </EmbedDepth.Provider>
      ) : (
        <div className="muted">그 부분을 노트에서 찾지 못했습니다.</div>
      )}
    </div>
  );
}

/**
 * A vault note, read-only, as Markdown: its properties (keys exactly as written), the text with
 * Obsidian links and pictures resolved inside the vault, and "Obsidian에서 열기" to change it there.
 * The input below starts a session with this note attached as a read-only reference.
 */
export function VaultNoteView({ path }: { path: string }) {
  const pkm = usePkm();
  const [note, setNote] = useState<VaultNote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [engine, setEngine] = useEngineChoice();
  const [notes, setNotes] = useState<{ path: string; title: string }[]>([]);
  const vaultVersion = pkm.state.pkm.vault ?? 0;
  const vaultPath = pkm.tree?.status.path ?? null;
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

  useEffect(() => {
    let cancelled = false;
    setError(null);
    pkm.client
      .note(path)
      .then((next) => {
        if (cancelled) return;
        setNote(next);
        setNotes((current) => (current.length ? current : [{ path: next.path, title: next.title }]));
      })
      .catch((reason: Error) => !cancelled && setError(reason.message));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, vaultVersion]);

  const components = useMemo<Components>(() => {
    const drawn: Components = obsidianComponents(
      {
        ...DRAWN,
        img: ({ src, alt, width, height }) => {
          const size = pictureSize(alt ?? "", width, height);
          return <Picture path={typeof src === "string" && src ? src : null} alt={size.alt} width={size.width} height={size.height} className="pkm-note-image" />;
        },
        a: ({ href, children }) =>
          href?.startsWith("vault-note:") || href?.startsWith("vault-embed:") ? (
            <a
              href="#"
              className="pkm-wikilink"
              onClick={(event) => {
                event.preventDefault();
                pkm.open?.({ kind: "note", path: decodeURIComponent(href.slice(href.indexOf(":") + 1).split("#")[0]!) });
              }}
            >
              {children}
            </a>
          ) : (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
      },
      {
        tagColor: (tag) => tagColor(pkm.tree?.tagColors ?? {}, tag),
        embed: (props) => <NoteEmbed {...props} components={drawn} version={vaultVersion} />,
      },
    );
    return drawn;
  }, [pkm, vaultVersion]);
  const markdown = useMemo(() => (note ? vaultMarkdown(note.body, note, vaultVersion) : ""), [note, vaultVersion]);

  return (
    <main className="pkm-view pkm-note-view">
      <header className="column pkm-head">
        <div className="pkm-crumbs">
          <button type="button" className="link" onClick={() => pkm.open?.({ kind: "vault", path: folder })}>
            <Icon name="arrowLeft" size={13} /> {folder ? folder.split("/").pop() : (pkm.tree?.status.name ?? "볼트")}
          </button>
        </div>
        <div className="pkm-title-row">
          <h1 className="pkm-title">{note?.title ?? path.split("/").pop()}</h1>
          <span className="vault-readonly" title="볼트 노트는 여기서 고치지 않습니다. Obsidian에서 고치면 여기에 바로 보입니다.">
            읽기 전용
          </span>
          <span className="pkm-head-tools">
            {note?.sessions ? <span className="pkm-count">세션 {note.sessions}</span> : null}
            {vaultPath ? (
              <button type="button" className="ghost-button small pkm-obsidian" onClick={() => void openObsidian(obsidianUrl(vaultPath, path)).catch(() => undefined)}>
                <Icon name="external" size={14} /> Obsidian에서 열기
              </button>
            ) : null}
          </span>
        </div>
      </header>
      <div className="pkm-scroll">
        <div className="column pkm-note">
          {error ? <div className="notice notice-error">{error}</div> : null}
          {note ? (
            <>
              <div className="pkm-note-meta muted">
                {path} · {cardDate(note.date)}
              </div>
              {note.properties.length ? (
                <dl className="pkm-props">
                  {note.properties.map(([key, values]) => (
                    <div key={key} className="pkm-prop">
                      <dt>{key}</dt>
                      <dd>
                        {values?.length ? (
                          key.toLowerCase() === "tags" ? (
                            values.map((value) => <TagPill key={value} tag={value.replace(/^#/, "")} color={tagColor(pkm.tree?.tagColors ?? {}, value.replace(/^#/, ""))} />)
                          ) : (
                            values.map((value, index) => (
                              <span key={`${value}:${index}`} className="pkm-prop-value">
                                {value}
                              </span>
                            ))
                          )
                        ) : (
                          <span className="muted">값 없음</span>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
              <div className="markdown pkm-note-body">
                <ObsidianMarkdown components={components}>{markdown}</ObsidianMarkdown>
              </div>
            </>
          ) : !error ? (
            <div className="empty-hint">불러오는 중…</div>
          ) : null}
        </div>
      </div>
      <CardComposer draftKey={`note:${path}`} place={{ kind: "new", folderId: null }} notes={notes} onNotes={setNotes} engine={engine} setEngine={setEngine} dropping={false} placeholder="이 노트를 붙여 새 세션 시작하기" hint="노트는 지금 내용의 읽기 전용 사본으로 요청에 붙습니다. 고치려면 Obsidian에서 여세요." />
    </main>
  );
}
