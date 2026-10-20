import { useCallback, useState } from "react";
import { EFFORT_LABEL, PROVIDER_LABEL, type DocRef, type Provider, type Session, type Work } from "@workbench/contracts";
import { folderPath, isBusy, sessionsOf, type State } from "../state.ts";
import { sessionLabel, statusText, statusTone } from "../format.ts";
import { Composer } from "./Composer.tsx";
import { EditableText } from "./EditableText.tsx";
import { ModelPicker, type ModelChoice } from "./ModelPicker.tsx";
import { Icon } from "./Icon.tsx";
import { MenuItem, Popover } from "./Popover.tsx";
import { EngineMark } from "./EngineMark.tsx";
import { EngineTabs } from "./StartView.tsx";
import { accentStyle, useAppearance } from "../appearance.ts";
import { useUnseen } from "./Overview.tsx";
import { Transcript } from "./Transcript.tsx";

export type WorkActions = {
  send: (session: Session, text: string, refs?: DocRef[]) => Promise<boolean>;
  handoff: (source: Session, target: Session, text: string, refs?: DocRef[]) => Promise<boolean>;
  pickSession: (work: Work, exclude: Session | null) => Promise<Session | null>;
  openArtifact: (artifactId: string) => void;
  openFile: (work: Work, path: string) => Promise<void>;
  newDesign: (work: Work, preset: string) => Promise<void>;
  interrupt: (session: Session) => void;
  answer: (session: Session, itemId: string, decision: "accept" | "decline") => void;
  newSession: (work: Work, provider: Provider, choice?: ModelChoice) => Promise<Session | null>;
  selectSession: (work: Work, session: Session) => void;
  renameSession: (session: Session, purpose: string) => void;
  setModel: (session: Session, choice: ModelChoice) => void;
  moveWork: (work: Work, folderId: string | null) => void;
  openFinder: () => void;
  openOverview: (work?: Work) => void;
};

/** Sizes a new design starts with (the gateway knows the same ids). */
const DESIGN_PRESETS = [
  { id: "square", label: "정사각 (SNS)", size: "1080×1080" },
  { id: "portrait", label: "카드뉴스", size: "1080×1350" },
  { id: "story", label: "세로 (스토리)", size: "1080×1920" },
  { id: "wide", label: "가로 (썸네일·화면)", size: "1920×1080" },
  { id: "a4", label: "A4 문서", size: "794×1123" },
];

/** Tabs that stay readable with many sessions: the active one and the latest few, the rest behind "+N". */
const MAX_TABS = 5;

function StatusDot({ tone }: { tone: string }) {
  return <span className={`dot dot-${tone}`} aria-hidden />;
}

function TargetPicker({
  sessions,
  active,
  hostLabel,
  onSelect,
  onNew,
  onHandoff,
}: {
  sessions: Session[];
  active: Session | null;
  hostLabel: string;
  onSelect: (session: Session) => void;
  onNew: (provider: Provider) => void;
  onHandoff: () => void;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const { lookOf } = useAppearance();
  return (
    <div className="anchor">
      <button type="button" className="select-button" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>
        {active ? <EngineMark provider={active.provider} size={15} /> : null}
        {active ? `${PROVIDER_LABEL[active.provider]} · ${hostLabel}` : "엔진 선택"}
        <Icon name={open ? "chevronUp" : "chevronDown"} size={14} />
      </button>
      <Popover open={open} onClose={close} placement="above" align="right">
        {sessions.length ? <div className="menu-label">이 작업의 세션</div> : null}
        {sessions.map((session) => (
          <MenuItem
            key={session.id}
            active={session.id === active?.id}
            hint={statusText(session)}
            onSelect={() => {
              onSelect(session);
              close();
            }}
          >
            <span className="menu-engine" style={accentStyle(lookOf(session.provider))}>
              <EngineMark provider={session.provider} size={15} />
              {sessionLabel(session)}
            </span>
          </MenuItem>
        ))}
        {sessions.length ? <div className="menu-divider" /> : null}
        {(["claude", "codex"] as const).map((provider) => (
          <MenuItem
            key={provider}
            onSelect={() => {
              onNew(provider);
              close();
            }}
          >
            <span className="menu-engine" style={accentStyle(lookOf(provider))}>
              <EngineMark provider={provider} size={15} />
              새 {PROVIDER_LABEL[provider]} 세션
            </span>
          </MenuItem>
        ))}
        <div className="menu-divider" />
        <MenuItem
          hint="답은 이 작업으로"
          onSelect={() => {
            close();
            onHandoff();
          }}
        >
          <span className="menu-engine">
            <Icon name="send" size={15} /> 다른 세션에 보내기…
          </span>
        </MenuItem>
      </Popover>
    </div>
  );
}

export function WorkView({
  state,
  work,
  actions,
  engine,
  setEngine,
  pickFile,
}: {
  state: State;
  work: Work;
  actions: WorkActions;
  engine: Provider;
  setEngine: (provider: Provider) => void;
  pickFile: ((folder: string) => Promise<string | null>) | null;
}) {
  const { lookOf, openMenu } = useAppearance();
  const unseen = useUnseen();
  const sessions = sessionsOf(state, work.id);
  const active = (work.activeSessionId && state.sessions[work.activeSessionId]) || sessions[sessions.length - 1] || null;
  const transcript = active ? state.transcripts[active.id] : undefined;
  const path = folderPath(state, work.folderId);
  const busy = isBusy(active ?? undefined);
  // The engine itself is working (not waiting on the user's approval).
  const working = active?.status === "starting" || active?.status === "running";
  const otherActive = Object.values(state.works).filter(
    (other) => other.id !== work.id && sessionsOf(state, other.id).some((session) => isBusy(session)),
  ).length;

  const [draftChoice, setDraftChoice] = useState<ModelChoice>({ model: null, effort: null });
  const pickerProvider = active?.provider ?? engine;
  const models = state.providers[pickerProvider]?.models ?? [];
  const [statusOpen, setStatusOpen] = useState(false);
  const closeStatus = useCallback(() => setStatusOpen(false), []);
  const [folderOpen, setFolderOpen] = useState(false);
  const closeFolder = useCallback(() => setFolderOpen(false), []);
  const [renaming, setRenaming] = useState<string | null>(null);
  // "다른 세션에": the receiving session, and documents pinned to the next request.
  const [handoffTo, setHandoffTo] = useState<Session | null>(null);
  const [attached, setAttached] = useState<string[]>([]);
  const [docsOpen, setDocsOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const artifacts = Object.values(state.artifacts)
    .filter((artifact) => artifact.workId === work.id)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const recency = (session: Session) => Math.max(session.previewAt ?? 0, session.updatedAt);
  const keep = new Set(
    [...sessions]
      .sort((a, b) => Number(b.id === active?.id) - Number(a.id === active?.id) || Number(isBusy(b)) - Number(isBusy(a)) || recency(b) - recency(a))
      .slice(0, MAX_TABS - 1 + Number(sessions.length <= MAX_TABS))
      .map((session) => session.id),
  );
  const tabSessions = sessions.filter((session) => keep.has(session.id));
  const hiddenTabs = sessions.length - tabSessions.length;

  // Folders flattened in tree order for the "move to" menu.
  const folderOptions: { id: string; name: string; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    Object.values(state.folders)
      .filter((folder) => folder.parentId === parentId)
      .sort((a, b) => a.sort - b.sort)
      .forEach((folder) => {
        folderOptions.push({ id: folder.id, name: folder.name, depth });
        walk(folder.id, depth + 1);
      });
  };
  walk(null, 0);

  return (
    <main className="work-view" onContextMenu={(event) => openMenu(event, active?.provider ?? engine)}>
      <div className="column context-row">
        <div className="anchor breadcrumb-anchor">
          <button type="button" className="breadcrumb" onClick={() => setFolderOpen(!folderOpen)} title="분류 옮기기" aria-expanded={folderOpen}>
            {path.length ? path.map((folder) => folder.name).join(" / ") : <span className="muted">분류 없음</span>}
          </button>
          <Popover open={folderOpen} onClose={closeFolder} align="left">
            <div className="menu-label">분류 옮기기 · 실제 파일 위치는 그대로입니다</div>
            <MenuItem
              active={!work.folderId}
              onSelect={() => {
                actions.moveWork(work, null);
                closeFolder();
              }}
            >
              분류 없음
            </MenuItem>
            {folderOptions.map((option) => (
              <MenuItem
                key={option.id}
                active={work.folderId === option.id}
                onSelect={() => {
                  actions.moveWork(work, option.id);
                  closeFolder();
                }}
              >
                <span style={{ paddingLeft: option.depth * 14 }}>{option.name}</span>
              </MenuItem>
            ))}
            {!folderOptions.length ? <div className="menu-label">작업 찾기에서 폴더를 만들 수 있습니다.</div> : null}
          </Popover>
        </div>
        <div className="anchor">
          <button type="button" className="ghost-button docs-button" onClick={() => setDocsOpen(!docsOpen)} aria-expanded={docsOpen} title="이 작업의 문서">
            <Icon name="file" size={15} /> 문서 {artifacts.length ? artifacts.length : ""}
          </button>
          <Popover open={docsOpen} onClose={() => setDocsOpen(false)} align="left" className="docs-menu">
            <div className="menu-label">이 작업의 문서</div>
            {artifacts.map((artifact) => (
              <MenuItem
                key={artifact.id}
                hint={`r${artifact.revision}`}
                onSelect={() => {
                  setDocsOpen(false);
                  actions.openArtifact(artifact.id);
                }}
              >
                {artifact.name}
              </MenuItem>
            ))}
            {!artifacts.length ? <div className="menu-label">AI가 만든 문서나 연 파일이 여기에 모입니다.</div> : null}
            <div className="menu-divider" />
            <div className="menu-label">새 디자인</div>
            {DESIGN_PRESETS.map((preset) => (
              <MenuItem
                key={preset.id}
                hint={preset.size}
                onSelect={() => {
                  setDocsOpen(false);
                  void actions.newDesign(work, preset.id);
                }}
              >
                {preset.label}
              </MenuItem>
            ))}
            <div className="menu-divider" />
            {pickFile ? (
              <MenuItem
                onSelect={() => {
                  setDocsOpen(false);
                  void pickFile(work.cwd).then((path) => {
                    if (path) void actions.openFile(work, path);
                  });
                }}
              >
                파일 열기…
              </MenuItem>
            ) : (
              <form
                className="menu-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!pathInput.trim()) return;
                  setDocsOpen(false);
                  void actions.openFile(work, pathInput.trim());
                  setPathInput("");
                }}
              >
                <input value={pathInput} onChange={(event) => setPathInput(event.target.value)} placeholder="작업 폴더 기준 경로 (예: 강의.md)" />
              </form>
            )}
          </Popover>
        </div>
        {active ? (
          <div className="anchor">
            <button type="button" className="status-pill" onClick={() => setStatusOpen(!statusOpen)} aria-expanded={statusOpen}>
              <StatusDot tone={statusTone(active)} />
              <span>{statusText(active)}</span>
              <span className="status-sep">·</span>
              <span className="status-engine">
                <EngineMark provider={active.provider} size={14} />
                {PROVIDER_LABEL[active.provider]}
              </span>
              <span className="status-sep">·</span>
              <span>{state.hostLabel}</span>
              <Icon name={statusOpen ? "chevronUp" : "chevronDown"} size={14} />
            </button>
            <Popover open={statusOpen} onClose={closeStatus} align="left" className="status-detail">
              <dl>
                <dt>세션</dt>
                <dd>{sessionLabel(active)}</dd>
                <dt>모델</dt>
                <dd>{models.find((model) => model.id === active.model)?.label ?? active.model ?? "엔진 기본값"}</dd>
                <dt>추론 강도</dt>
                <dd>{active.effort ? (EFFORT_LABEL[active.effort] ?? active.effort) : "모델 기본값"}</dd>
                {active.engineModel ? (
                  <>
                    <dt>최근 응답</dt>
                    <dd className="mono">
                      {active.engineModel}
                      {active.engineEffort ? ` · ${EFFORT_LABEL[active.engineEffort] ?? active.engineEffort}` : ""}
                    </dd>
                  </>
                ) : null}
                <dt>실행 위치</dt>
                <dd>{state.hostLabel}</dd>
                <dt>작업 폴더</dt>
                <dd className="mono">{work.cwd}</dd>
                {active.lastError ? (
                  <>
                    <dt>마지막 오류</dt>
                    <dd>{active.lastError}</dd>
                  </>
                ) : null}
              </dl>
            </Popover>
          </div>
        ) : null}
      </div>

      {sessions.length > 1 ? (
        <nav className="column session-tabs" aria-label="세션">
          {tabSessions.map((session) =>
            renaming === session.id ? (
              <EditableText
                key={session.id}
                className="session-tab-edit"
                value={session.purpose}
                onSave={(purpose) => actions.renameSession(session, purpose)}
                onDone={() => setRenaming(null)}
              />
            ) : (
              <button
                key={session.id}
                type="button"
                className={`session-tab${session.id === active?.id ? " active" : ""}`}
                style={accentStyle(lookOf(session.provider))}
                onClick={() => actions.selectSession(work, session)}
                onDoubleClick={() => setRenaming(session.id)}
                onContextMenu={(event) => openMenu(event, session.provider)}
                title="두 번 눌러 이름 바꾸기 · 오른쪽 클릭으로 외형"
              >
                {isBusy(session) ? <StatusDot tone={statusTone(session)} /> : <EngineMark provider={session.provider} size={14} />}
                {sessionLabel(session)}
                {unseen.has(session.id) ? <span className="new-dot" title="새 답" /> : null}
              </button>
            ),
          )}
          {hiddenTabs ? (
            <button type="button" className="session-tab more" onClick={() => actions.openOverview(work)} title="이 작업의 모든 세션">
              +{hiddenTabs}
              {sessions.some((session) => unseen.has(session.id) && !tabSessions.includes(session)) ? <span className="new-dot" /> : null}
            </button>
          ) : null}
        </nav>
      ) : null}

      {active ? (
        <Transcript
          sessionId={active.id}
          items={transcript?.items ?? []}
          provider={active.provider}
          running={working}
          loading={!transcript}
          onAnswer={(itemId, decision) => actions.answer(active, itemId, decision)}
        />
      ) : (
        <div className="transcript">
          <div className="column transcript-inner">
            <div className="empty-hint">아래에서 엔진을 고르고 이 작업의 첫 요청을 보내세요.</div>
          </div>
        </div>
      )}

      <div className="column composer-area">
        {!active ? (
          <EngineTabs
            value={engine}
            onChange={(next) => {
              setEngine(next);
              setDraftChoice({ model: null, effort: null });
            }}
          />
        ) : null}
        <Composer
          draftKey={`work:${work.id}:${active?.id ?? "none"}`}
          placeholder="이 작업에 이어서 요청하기"
          busy={busy}
          waiting={working}
          autoFocus
          header={
            handoffTo || attached.length ? (
              <div className="doc-chips">
                {handoffTo ? (
                  <span className="target-chip" style={accentStyle(lookOf(handoffTo.provider))}>
                    <EngineMark provider={handoffTo.provider} size={13} /> @{handoffTo.purpose}
                    <button type="button" onClick={() => setHandoffTo(null)} aria-label="받는 세션 지우기">
                      <Icon name="x" size={11} />
                    </button>
                  </span>
                ) : null}
                {attached.map((artifactId) => {
                  const artifact = state.artifacts[artifactId];
                  return artifact ? (
                    <span key={artifactId} className="ref-chip">
                      <Icon name="file" size={12} /> {artifact.name} · r{artifact.revision}
                      <button type="button" onClick={() => setAttached(attached.filter((id) => id !== artifactId))} aria-label="문서 빼기">
                        <Icon name="x" size={11} />
                      </button>
                    </span>
                  ) : null;
                })}
                {handoffTo ? <span className="muted">회신: 이 작업</span> : null}
              </div>
            ) : null
          }
          onSend={async (text) => {
            // Attached documents travel as the revision they have now; handoffs are read-only.
            const refs: DocRef[] = attached
              .map((artifactId) => state.artifacts[artifactId])
              .filter((artifact): artifact is NonNullable<typeof artifact> => Boolean(artifact))
              .map((artifact) => ({ artifactId: artifact.id, revision: artifact.revision, mode: "review" as const, selection: null }));
            const source: Session | null = active ?? (await actions.newSession(work, engine, draftChoice));
            if (!source) return false;
            const sent = handoffTo ? await actions.handoff(source, handoffTo, text, refs) : await actions.send(source, text, refs);
            if (sent) {
              setHandoffTo(null);
              setAttached([]);
            }
            return sent;
          }}
          onStop={active ? () => actions.interrupt(active) : undefined}
          target={
            <>
            <ModelPicker
              models={models}
              value={active ? { model: active.model, effort: active.effort } : draftChoice}
              onChange={(choice) => (active ? actions.setModel(active, choice) : setDraftChoice(choice))}
            />
            {active ? (
              <TargetPicker
                sessions={sessions}
                active={active}
                hostLabel={state.hostLabel}
                onSelect={(session) => actions.selectSession(work, session)}
                onNew={(provider) => void actions.newSession(work, provider)}
                onHandoff={() => void actions.pickSession(work, active).then((picked) => picked && picked.id !== active.id && setHandoffTo(picked))}
              />
            ) : null}
            <div className="anchor">
              <button type="button" className="icon-button" onClick={() => setAttachOpen(!attachOpen)} title="문서 붙이기" aria-label="문서 붙이기">
                <Icon name="file" size={17} />
              </button>
              <Popover open={attachOpen} onClose={() => setAttachOpen(false)} placement="above" align="right">
                <div className="menu-label">요청에 붙일 문서 · 지금 판으로 고정</div>
                {artifacts.map((artifact) => (
                  <MenuItem
                    key={artifact.id}
                    active={attached.includes(artifact.id)}
                    hint={`r${artifact.revision}`}
                    onSelect={() => {
                      setAttached(attached.includes(artifact.id) ? attached.filter((id) => id !== artifact.id) : [...attached, artifact.id]);
                      setAttachOpen(false);
                    }}
                  >
                    {artifact.name}
                  </MenuItem>
                ))}
                {!artifacts.length ? <div className="menu-label">이 작업에 문서가 아직 없습니다.</div> : null}
              </Popover>
            </div>
            </>
          }
        />
        <div className="footer-line">
          {otherActive ? (
            <>
              다른 작업 {otherActive}개 진행 중 ·{" "}
              <button type="button" className="link" onClick={actions.openFinder}>
                전체 보기
              </button>
            </>
          ) : null}
        </div>
      </div>
    </main>
  );
}
