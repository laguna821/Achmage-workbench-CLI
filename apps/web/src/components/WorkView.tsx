import { useCallback, useState } from "react";
import { EFFORT_LABEL, PROVIDER_LABEL, type Provider, type Session, type Work } from "@workbench/contracts";
import { folderPath, isBusy, sessionsOf, type State } from "../state.ts";
import { sessionLabel, statusText, statusTone } from "../format.ts";
import { Composer } from "./Composer.tsx";
import { EditableText } from "./EditableText.tsx";
import { ModelPicker, type ModelChoice } from "./ModelPicker.tsx";
import { Icon } from "./Icon.tsx";
import { MenuItem, Popover } from "./Popover.tsx";
import { EngineToggle, useEngineChoice } from "./StartView.tsx";
import { Transcript } from "./Transcript.tsx";

export type WorkActions = {
  send: (session: Session, text: string) => Promise<boolean>;
  interrupt: (session: Session) => void;
  answer: (session: Session, itemId: string, decision: "accept" | "decline") => void;
  newSession: (work: Work, provider: Provider, choice?: ModelChoice) => Promise<Session | null>;
  selectSession: (work: Work, session: Session) => void;
  renameSession: (session: Session, purpose: string) => void;
  setModel: (session: Session, choice: ModelChoice) => void;
  moveWork: (work: Work, folderId: string | null) => void;
  openFinder: () => void;
};

function StatusDot({ tone }: { tone: string }) {
  return <span className={`dot dot-${tone}`} aria-hidden />;
}

function TargetPicker({
  sessions,
  active,
  hostLabel,
  onSelect,
  onNew,
}: {
  sessions: Session[];
  active: Session | null;
  hostLabel: string;
  onSelect: (session: Session) => void;
  onNew: (provider: Provider) => void;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <div className="anchor">
      <button type="button" className="select-button" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>
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
            {sessionLabel(session)}
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
            새 {PROVIDER_LABEL[provider]} 세션
          </MenuItem>
        ))}
      </Popover>
    </div>
  );
}

export function WorkView({ state, work, actions }: { state: State; work: Work; actions: WorkActions }) {
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

  const [engine, setEngine] = useEngineChoice();
  const [draftChoice, setDraftChoice] = useState<ModelChoice>({ model: null, effort: null });
  const pickerProvider = active?.provider ?? engine;
  const models = state.providers[pickerProvider]?.models ?? [];
  const [statusOpen, setStatusOpen] = useState(false);
  const closeStatus = useCallback(() => setStatusOpen(false), []);
  const [folderOpen, setFolderOpen] = useState(false);
  const closeFolder = useCallback(() => setFolderOpen(false), []);
  const [renaming, setRenaming] = useState<string | null>(null);

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
    <main className="work-view">
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
        {active ? (
          <div className="anchor">
            <button type="button" className="status-pill" onClick={() => setStatusOpen(!statusOpen)} aria-expanded={statusOpen}>
              <StatusDot tone={statusTone(active)} />
              <span>{statusText(active)}</span>
              <span className="status-sep">·</span>
              <span>{PROVIDER_LABEL[active.provider]}</span>
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
          {sessions.map((session) =>
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
                onClick={() => actions.selectSession(work, session)}
                onDoubleClick={() => setRenaming(session.id)}
                title="두 번 눌러 이름 바꾸기"
              >
                {isBusy(session) ? <StatusDot tone={statusTone(session)} /> : null}
                {sessionLabel(session)}
              </button>
            ),
          )}
        </nav>
      ) : null}

      {active ? (
        <Transcript
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
        <Composer
          draftKey={`work:${work.id}:${active?.id ?? "none"}`}
          placeholder="이 작업에 이어서 요청하기"
          busy={busy}
          waiting={working}
          autoFocus
          onSend={async (text) => {
            if (active) return actions.send(active, text);
            const created = await actions.newSession(work, engine, draftChoice);
            return created ? actions.send(created, text) : false;
          }}
          onStop={active ? () => actions.interrupt(active) : undefined}
          target={
            <>
            <ModelPicker
              models={models}
              value={active ? { model: active.model, effort: active.effort } : draftChoice}
              onChange={(choice) => (active ? actions.setModel(active, choice) : setDraftChoice(choice))}
            />
            {!active ? (
              <EngineToggle
                value={engine}
                onChange={(next) => {
                  setEngine(next);
                  setDraftChoice({ model: null, effort: null });
                }}
              />
            ) : (
            <TargetPicker
              sessions={sessions}
              active={active}
              hostLabel={state.hostLabel}
              onSelect={(session) => actions.selectSession(work, session)}
              onNew={(provider) => void actions.newSession(work, provider)}
            />
            )}
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
