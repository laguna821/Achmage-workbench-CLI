import { useCallback, useEffect, useState, type ImgHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import type { Components } from "react-markdown";
import { ASPECT_LABEL, IMAGE_ASPECTS, dirOf, markdownImageLink, relativePath, resolvePath, type ImageInfo, type ImageItem, type ImageTemplates, type Provider, type Session, type Work } from "@workbench/contracts";
import { newRequestId, statusText } from "../format.ts";
import { copyText, currentDoc, drawImage, inDesktop, openInApp, putInDoc, saveTemplates, stopSession, useDocVersion, usePicture, useTemplates, type DrawChoice } from "../imagegen.ts";
import type { State } from "../state.ts";
import { useDocs } from "./DocCards.tsx";
import { EngineMark } from "./EngineMark.tsx";
import { Icon } from "./Icon.tsx";
import { Popover } from "./Popover.tsx";
import "../styles/imagegen.css";

// "그림": the pill under the input that turns the next request into a drawing (GPT Image through
// Codex), the cards pictures appear as in conversations, and pictures inside Markdown previews.

const firstLine = (text: string) => (text.split("\n").find((line) => line.trim()) ?? "").trim();

/** The Codex sessions of a work a drawing can go through, oldest first. */
function codexSessions(state: State, workId: string) {
  return Object.values(state.sessions)
    .filter((session) => session.workId === workId && session.provider === "codex" && !session.archivedAt)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** Who draws, in words (always ending in "세션", so "이" fits): this one, or a Codex session of the work. */
function drawerLabel(state: State, provider: Provider, via: string | null) {
  if (via === "new") return "새 Codex 세션";
  if (via) return `「${state.sessions[via]?.purpose ?? "?"}」 Codex 세션`;
  return provider === "claude" ? "이 작업의 Codex 그림 세션" : "이 Codex 세션";
}

export type DrawState = { on: boolean; choice: DrawChoice; via: string | null };

/**
 * "그림" in the composer's left slot. On, the next request is drawn with GPT Image through Codex
 * (then it turns off again; the template and shape are remembered). In a Claude conversation the
 * work's Codex session draws, and the picture still shows here.
 */
export function DrawPill({
  state,
  work,
  session,
  provider,
  value,
  onChange,
}: {
  state: State;
  work: Work;
  session: Session | null;
  /** The engine of the conversation (or the one a new conversation starts with). */
  provider: Provider;
  value: DrawState;
  onChange: (next: DrawState) => void;
}) {
  const [open, setOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  const close = useCallback(() => {
    setOpen(false);
    setManaging(false);
  }, []);
  const templates = useTemplates();
  const template = templates?.templates.find((entry) => entry.id === value.choice.templateId) ?? null;
  const codex = state.providers.codex;
  const unavailable = codex ? codex.installed === false || codex.imageGeneration === false : false;
  const others = codexSessions(state, work.id).filter((entry) => entry.id !== session?.id && entry.workspaceId === (session?.workspaceId ?? work.defaultWorkspaceId));
  const rows = [{ id: null as string | null, name: "없음", prompt: "", mine: false }, ...(templates?.templates ?? []).map((entry) => ({ id: entry.id as string | null, name: entry.name, prompt: entry.prompt, mine: !entry.builtIn }))];
  const set = (patch: Partial<DrawState>) => onChange({ ...value, ...patch });
  const choose = (patch: Partial<DrawChoice>) => onChange({ ...value, on: true, choice: { ...value.choice, ...patch } });
  return (
    <div className="anchor">
      <button
        type="button"
        className={`plain-select feature-pill draw-pill${value.on ? " on" : ""}`}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={value.on ? `다음 요청을 그림으로 그립니다 · ${drawerLabel(state, provider, value.via)}` : "그림 그리기 · GPT Image (Codex 전용)"}
      >
        <Icon name="image" size={14} />
        <span className="pill-label">그림</span>
        {value.on && template ? <span className="draw-pill-template"> · {template.name}</span> : null}
      </button>
      <Popover open={open} onClose={close} placement="above" align="left" className="draw-menu">
        {managing ? (
          <TemplateManager templates={templates} onBack={() => setManaging(false)} />
        ) : (
          <>
            <div className="menu-label">그림 · GPT Image (Codex 전용)</div>
            <label className={`draw-switch${value.on ? " on" : ""}`}>
              <input type="checkbox" role="switch" checked={value.on} disabled={unavailable} onChange={(event) => set({ on: event.target.checked })} />
              <span className="draw-switch-track" aria-hidden />
              <span>다음 요청을 그림으로</span>
            </label>
            {unavailable ? <div className="draw-note warn">이 컴퓨터의 Codex에서는 그림 기능을 쓸 수 없습니다. 연결에서 Codex 로그인과 버전을 확인해 주세요.</div> : null}
            <div className="menu-label draw-label">
              템플릿
              <button type="button" className="link" onClick={() => setManaging(true)}>
                관리
              </button>
            </div>
            <div className="draw-templates" role="radiogroup" aria-label="템플릿">
              {rows.map((entry) => (
                <button
                  key={entry.id ?? "none"}
                  type="button"
                  role="radio"
                  aria-checked={value.choice.templateId === entry.id}
                  className={`draw-template${value.choice.templateId === entry.id ? " active" : ""}${entry.mine ? " mine" : ""}`}
                  title={entry.prompt ? `${entry.mine ? "내 템플릿 · " : ""}${entry.prompt}` : "템플릿 없이 적은 그대로 그립니다"}
                  onClick={() => choose({ templateId: entry.id })}
                >
                  {entry.name}
                </button>
              ))}
            </div>
            <div className="menu-label">비율</div>
            <div className="segmented small draw-aspect" role="radiogroup" aria-label="비율">
              {IMAGE_ASPECTS.map((aspect) => (
                <button key={aspect} type="button" role="radio" aria-checked={value.choice.aspect === aspect} className={value.choice.aspect === aspect ? "active" : ""} onClick={() => choose({ aspect })}>
                  {ASPECT_LABEL[aspect]}
                </button>
              ))}
            </div>
            <label className="draw-check">
              <input type="checkbox" checked={value.choice.transparent} onChange={(event) => choose({ transparent: event.target.checked })} /> 투명 배경
            </label>
            <div className="menu-divider" />
            {provider === "claude" ? (
              <div className="draw-note">
                <EngineMark provider="codex" size={13} /> Claude는 그림을 그리지 못해 <strong>이 작업의 Codex 세션</strong>이 그립니다. 그림은 이 대화에 보입니다. Codex는 이 대화 내용을 모르니 그릴 것을 구체적으로 적어 주세요.
              </div>
            ) : null}
            <div className="menu-label">그릴 세션</div>
            <div className="draw-sessions" role="radiogroup" aria-label="그릴 세션">
              <button type="button" role="radio" aria-checked={!value.via} className={`menu-item${!value.via ? " active" : ""}`} onClick={() => set({ via: null })}>
                <span className="menu-item-label">{provider === "claude" ? "자동 · 그림 세션" : "이 세션"}</span>
                <span className="menu-item-hint">{provider === "claude" ? "없으면 만듦" : session ? statusText(session) : "새 세션"}</span>
              </button>
              {others.map((entry) => (
                <button key={entry.id} type="button" role="radio" aria-checked={value.via === entry.id} className={`menu-item${value.via === entry.id ? " active" : ""}`} onClick={() => set({ via: entry.id })}>
                  <span className="menu-item-label">
                    <EngineMark provider="codex" size={13} /> {entry.purpose}
                  </span>
                  <span className="menu-item-hint">{statusText(entry)}</span>
                </button>
              ))}
              <button type="button" role="radio" aria-checked={value.via === "new"} className={`menu-item${value.via === "new" ? " active" : ""}`} onClick={() => set({ via: "new" })}>
                <span className="menu-item-label">새 Codex 세션</span>
              </button>
            </div>
          </>
        )}
      </Popover>
    </div>
  );
}

/** The user's own templates and the rules added to every drawing ("템플릿·규칙 관리"). */
function TemplateManager({ templates, onBack }: { templates: ImageTemplates | null; onBack: () => void }) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [rules, setRules] = useState(templates?.rules ?? "");
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => setRules(templates?.rules ?? ""), [templates?.rules]);
  const mine = templates?.templates.filter((template) => !template.builtIn) ?? [];
  const save = async (next: ImageTemplates, done: string) => {
    try {
      await saveTemplates(next);
      setNote(done);
      return true;
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
      return false;
    }
  };
  if (!templates) return <div className="menu-label">불러오는 중…</div>;
  return (
    <div className="draw-manager">
      <button type="button" className="text-button" onClick={onBack}>
        <Icon name="arrowLeft" size={14} /> 템플릿·규칙
      </button>
      <div className="menu-label">내 템플릿 · 그림 요청 앞에 붙습니다</div>
      {mine.length ? (
        mine.map((template) => (
          <div key={template.id} className="draw-mine" title={template.prompt}>
            <span className="draw-mine-name">{template.name}</span>
            <button type="button" className="link danger" onClick={() => void save({ ...templates, templates: templates.templates.filter((entry) => entry.id !== template.id) }, `「${template.name}」을(를) 지웠습니다.`)}>
              지우기
            </button>
          </div>
        ))
      ) : (
        <div className="draw-note">아직 없습니다. 스타일·색·형식을 적어 두면 그림마다 앞에 붙습니다.</div>
      )}
      <form
        className="draw-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim() || !prompt.trim()) return;
          void save({ ...templates, templates: [...templates.templates, { id: "", name: name.trim(), prompt: prompt.trim() }] }, `「${name.trim()}」을(를) 더했습니다.`).then((ok) => {
            if (ok) {
              setName("");
              setPrompt("");
            }
          });
        }}
      >
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="이름 (예: 강의 슬라이드)" maxLength={40} aria-label="템플릿 이름" />
        <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={3} placeholder="스타일·색·형식 (예: 16:9 slide illustration, calm colors, no text)" aria-label="템플릿 내용" />
        <button type="submit" className="button small" disabled={!name.trim() || !prompt.trim()}>
          템플릿 더하기
        </button>
      </form>
      <div className="menu-label">항상 붙일 규칙 · 모든 그림 끝에</div>
      <form
        className="draw-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save({ ...templates, rules }, "규칙을 저장했습니다.");
        }}
      >
        <textarea value={rules} onChange={(event) => setRules(event.target.value)} rows={2} placeholder="예: No text inside the image. No watermark." aria-label="항상 붙일 규칙" />
        <button type="submit" className="button small" disabled={rules === templates.rules}>
          규칙 저장
        </button>
      </form>
      {note ? <div className="draw-note">{note}</div> : null}
    </div>
  );
}

/** Above the input while drawing is on: what will be drawn how, and by whom. */
export function DrawChip({ state, provider, value, onClear }: { state: State; provider: Provider; value: DrawState; onClear: () => void }) {
  const templates = useTemplates();
  const template = templates?.templates.find((entry) => entry.id === value.choice.templateId);
  const detail = [template?.name, value.choice.aspect !== "auto" ? ASPECT_LABEL[value.choice.aspect] : null, value.choice.transparent ? "투명 배경" : null].filter(Boolean).join(" · ");
  return (
    <span className="draw-chip">
      <Icon name="image" size={12} /> 그림{detail ? ` · ${detail}` : ""}
      {provider === "claude" || value.via ? (
        <span className="draw-chip-via">
          <EngineMark provider="codex" size={12} /> {drawerLabel(state, provider, value.via)}이 그리고, 그림은 이 대화에 보입니다
        </span>
      ) : null}
      <button type="button" onClick={onClear} aria-label="그림 끄기" title="그림 끄기">
        <Icon name="x" size={11} />
      </button>
    </span>
  );
}

/** The picture full size over the app (Esc or a click outside closes it). */
function ImageViewer({ info, url, onClose }: { info: ImageInfo; url: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  // Over everything, inside the app element so the look's colors still apply.
  return createPortal(
    <div className="image-viewer" role="dialog" aria-label={`그림 · ${firstLine(info.brief)}`} onClick={onClose}>
      <img src={url} alt={info.brief} onClick={(event) => event.stopPropagation()} />
      <div className="image-viewer-bar" onClick={(event) => event.stopPropagation()}>
        <span className="image-viewer-name" title={info.path ?? ""}>
          {info.relPath} · {info.width}×{info.height}
        </span>
        {inDesktop && info.path ? (
          <button type="button" className="button small" onClick={() => void openInApp(info.path!)}>
            앱으로 열기
          </button>
        ) : null}
        <button type="button" className="button small" onClick={onClose}>
          닫기 <kbd>Esc</kbd>
        </button>
      </div>
    </div>,
    document.querySelector(".app") ?? document.body,
  );
}

/**
 * A picture in a conversation: drawing (who draws, "멈춤"), drawn (the picture, "열기", "경로
 * 복사", "현재 문서에 넣기", "다시 그리기"), or failed (why, "다시 그리기").
 */
export function ImageCard({ item, viewer, compact }: { item: ImageItem; viewer: string; compact?: boolean }) {
  const { state, actions } = useDocs();
  useDocVersion();
  const info = item.image;
  const picture = usePicture(info.status === "done" ? info.workId : null, info.relPath ?? info.path, info.workspaceId);
  const [viewing, setViewing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const drawer = state.sessions[info.drawSessionId];
  const origin = state.sessions[info.originSessionId];
  const docId = currentDoc(info.workId);
  const doc = docId ? state.artifacts[docId] : undefined;
  const target = doc && doc.format === "markdown" && doc.workId === info.workId ? doc : undefined;
  const say = (text: string) => {
    setNote(text);
    window.setTimeout(() => setNote((current) => (current === text ? null : current)), 2600);
  };
  const again = async () => {
    try {
      await drawImage(info.originSessionId, {
        requestId: newRequestId(),
        brief: info.brief,
        templateId: info.templateId ?? null,
        aspect: info.aspect,
        transparent: info.transparent,
        via: info.drawSessionId !== info.originSessionId ? info.drawSessionId : null,
      });
    } catch (error) {
      say(error instanceof Error ? error.message : String(error));
    }
  };
  const shape = info.aspect === "landscape" ? "3 / 2" : info.aspect === "portrait" ? "2 / 3" : "1 / 1";
  const status = info.status === "drawing" ? (drawer?.status === "awaitingApproval" ? "Codex 세션이 승인을 기다립니다" : "그리는 중…") : info.status === "failed" ? "그리지 못했습니다" : "그림";
  const meta = [info.template, info.aspect !== "auto" ? ASPECT_LABEL[info.aspect] : null, info.transparent ? "투명" : null, info.width ? `${info.width}×${info.height}` : null].filter(Boolean).join(" · ");
  return (
    <figure className={`image-card status-${info.status}${compact ? " compact" : ""}`} data-image-id={info.id}>
      <div className="image-card-head">
        <Icon name="image" size={14} />
        <span className="image-card-status">{status}</span>
        {meta ? <span className="image-card-meta">{meta}</span> : null}
      </div>
      {info.status === "done" ? (
        <button type="button" className="image-card-picture" onClick={() => picture.url && setViewing(true)} title="크게 보기">
          {picture.url ? <img src={picture.url} alt={info.brief} /> : <span className="image-card-wait">{picture.error ?? ""}</span>}
        </button>
      ) : info.status === "drawing" ? (
        <div className="image-card-wait drawing" style={{ aspectRatio: shape }}>
          <span className="spinner" /> GPT Image
        </div>
      ) : (
        <div className="image-card-error">{info.error ?? "그리지 못했습니다."}</div>
      )}
      <figcaption className="image-card-brief" title={info.revisedPrompt ? `그린 프롬프트: ${info.revisedPrompt}` : info.prompt}>
        {info.brief}
      </figcaption>
      {info.drawSessionId !== viewer && drawer ? (
        <div className="image-card-via">
          <EngineMark provider="codex" size={13} /> 「{drawer.purpose}」 Codex 세션이 그림
          <button type="button" className="link" onClick={() => actions.openSession(drawer.id)}>
            세션 열기
          </button>
        </div>
      ) : info.originSessionId !== viewer && origin ? (
        <div className="image-card-via">
          <EngineMark provider={origin.provider} size={13} /> 「{origin.purpose}」 대화에서 요청한 그림
          <button type="button" className="link" onClick={() => actions.openSession(origin.id)}>
            대화 열기
          </button>
        </div>
      ) : null}
      <div className="image-card-actions">
        {info.status === "done" && info.path ? (
          <>
            <button type="button" className="button small" onClick={() => picture.url && setViewing(true)} disabled={!picture.url}>
              열기
            </button>
            {compact ? null : (
              <button type="button" className="button small" onClick={() => void copyText(info.path!).then(() => say("경로를 복사했습니다."))}>
                경로 복사
              </button>
            )}
            <button
              type="button"
              className="button small"
              disabled={!target}
              title={target ? `「${target.name}」의 커서 자리에 넣습니다` : "마크다운 문서를 한 번 열면 그 문서에 넣을 수 있습니다"}
              onClick={() => {
                if (!target) return;
                const block = markdownImageLink(firstLine(info.brief), relativePath(dirOf(target.path), info.path!));
                if (putInDoc(target.id, block) === "queued") actions.openArtifact(target.id);
                say(`「${target.name}」에 넣었습니다.`);
              }}
            >
              현재 문서에 넣기
            </button>
          </>
        ) : null}
        {info.status === "drawing" && drawer ? (
          <button type="button" className="button small" onClick={() => void stopSession(drawer.id).catch((error: Error) => say(error.message))}>
            멈춤
          </button>
        ) : null}
        {info.status !== "drawing" && !compact ? (
          <button type="button" className="text-button" onClick={() => void again()} title="같은 요청·템플릿으로 한 장 더">
            <Icon name="refresh" size={13} /> 다시 그리기
          </button>
        ) : null}
        {note ? <span className="image-card-note" role="status">{note}</span> : null}
      </div>
      {viewing && picture.url ? <ImageViewer info={info} url={picture.url} onClose={() => setViewing(false)} /> : null}
    </figure>
  );
}

/** A picture a Markdown document links to, read from the work folder (relative to the document). */
function DocPicture({ workId, docDir, src, alt, ...rest }: { workId: string; docDir: string } & ImgHTMLAttributes<HTMLImageElement>) {
  const raw = String(src ?? "");
  const external = /^(https?:|data:|blob:)/i.test(raw);
  let path: string | null = null;
  if (!external && raw) {
    try {
      path = resolvePath(docDir, decodeURI(raw));
    } catch {
      path = resolvePath(docDir, raw);
    }
  }
  const picture = usePicture(external ? null : workId, path);
  if (external) return <img src={raw} alt={alt} {...rest} />;
  if (picture.url) return <img src={picture.url} alt={alt} {...rest} />;
  return <span className="doc-picture-missing">{picture.error ? `그림을 열 수 없습니다: ${raw}` : alt}</span>;
}

/** Markdown components that show a document's pictures from its work folder. */
export function docPictureComponents(base: Components, workId: string, docPath: string): Components {
  const docDir = dirOf(docPath);
  return {
    ...base,
    img: (props) => {
      const { node, ...rest } = props;
      void node;
      return <DocPicture workId={workId} docDir={docDir} {...rest} />;
    },
  };
}
