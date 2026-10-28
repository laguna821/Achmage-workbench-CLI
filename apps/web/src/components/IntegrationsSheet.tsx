import { useCallback, useEffect, useState } from "react";
import type { IntegrationsView, McpDefinition } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { Icon } from "./Icon.tsx";

type Engine = "claude" | "codex";
const ENGINE_LABEL: Record<Engine, string> = { claude: "Claude", codex: "Codex" };

function describe(definition: McpDefinition) {
  if (definition.type !== "stdio") return definition.url ?? definition.type;
  const env = Object.keys(definition.env);
  return `${[definition.command, ...definition.args].join(" ")}${env.length ? ` · 환경변수 ${env.join(", ")}` : ""}`;
}

/** Servers that live inside the Codex app or one of its plugins: they only work there. */
function codexBuiltIn(definition: McpDefinition | null) {
  if (!definition) return false;
  const text = [definition.command ?? "", ...definition.args].join(" ");
  return /\/\.codex\/plugins\/|\/usr\/lib\/chatgpt\/|\$CODEX_|ChatGPT\.app|OpenAI\\Codex/.test(text);
}

function Cell({ present, enabled }: { present: boolean; enabled?: boolean }) {
  return <span className={`integration-cell ${present ? (enabled === false ? "off" : "on") : "none"}`}>{present ? (enabled === false ? "꺼짐" : "있음") : "없음"}</span>;
}

/**
 * MCP servers and skills of Claude Code and Codex, side by side. Workbench keeps no list of its
 * own: this is the engines' configuration. Copying to the other engine happens only on a click,
 * after showing where it will be written, through the engine's own command.
 */
export function IntegrationsSheet({ api, onClose, onToast }: { api: Api; onClose: () => void; onToast: (message: string) => void }) {
  const [view, setView] = useState<IntegrationsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // What a click would write, shown before anything is written.
  const [pending, setPending] = useState<{ key: string; text: string; action: () => Promise<IntegrationsView>; done: string } | null>(null);

  const load = useCallback(() => {
    api
      .integrations()
      .then(setView)
      .catch((reason: Error) => setError(reason.message));
  }, [api]);
  useEffect(load, [load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const act = (key: string, confirmText: string, action: () => Promise<IntegrationsView>, done: string) => setPending({ key, text: confirmText, action, done });
  const confirm = async () => {
    if (!pending) return;
    setBusy(pending.key);
    try {
      setView(await pending.action());
      onToast(pending.done);
    } catch (reason) {
      onToast(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
      setPending(null);
    }
  };

  return (
    <aside className="appearance-sheet integrations-sheet" aria-label="MCP와 스킬">
      <div className="sheet-head">
        <h2>MCP · 스킬</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="닫기">
          <Icon name="x" size={18} />
        </button>
      </div>
      <div className="sheet-body">
        <p className="sheet-hint">
          터미널의 Claude Code·Codex와 같은 설정입니다. Workbench는 따로 목록을 두지 않고, 누를 때만 각 엔진의 공식 명령으로 추가합니다.
        </p>
        {error ? <div className="notice notice-error compact">{error}</div> : null}
        {pending ? (
          <div className="integration-confirm" role="alertdialog" aria-label="쓰기 확인">
            <pre>{pending.text}</pre>
            <div className="integration-confirm-actions">
              <button type="button" className="button small primary" disabled={busy !== null} onClick={() => void confirm()}>
                {busy ? "쓰는 중…" : "그대로 쓰기"}
              </button>
              <button type="button" className="button small" disabled={busy !== null} onClick={() => setPending(null)}>
                취소
              </button>
            </div>
          </div>
        ) : null}
        {!view ? (
          <div className="sheet-hint">읽는 중…</div>
        ) : (
          <>
            <section className="sheet-section">
              <div className="sheet-label">MCP 서버</div>
              <div className="integration-head">
                <span />
                <span>Claude</span>
                <span>Codex</span>
              </div>
              {view.mcp.map((server) => {
                const builtIn = !server.claude && codexBuiltIn(server.codex);
                const missing: Engine | null = server.claude && !server.codex ? "codex" : !server.claude && server.codex && !builtIn ? "claude" : null;
                const source = server.claude ?? server.codex;
                return (
                  <div key={server.name} className="integration-row">
                    <span className="integration-name" title={source ? describe(source) : undefined}>
                      {server.name}
                      {source ? <span className="integration-detail">{describe(source)}</span> : null}
                    </span>
                    <Cell present={Boolean(server.claude)} enabled={server.claude?.enabled} />
                    <Cell present={Boolean(server.codex)} enabled={server.codex?.enabled} />
                    {missing ? (
                      <button
                        type="button"
                        className="button small"
                        disabled={busy !== null}
                        onClick={() =>
                          act(
                            `mcp:${server.name}`,
                            `${ENGINE_LABEL[missing]}에도 MCP 서버 '${server.name}'을(를) 추가합니다.\n\n쓰는 곳: ${missing === "claude" ? view.paths.claudeConfig : view.paths.codexConfig}\n방법: ${missing === "claude" ? "claude mcp add-json --scope user" : "codex mcp add"}`,
                            () => api.copyMcp(server.name, missing),
                            `${ENGINE_LABEL[missing]}에 ${server.name}을(를) 추가했습니다. 새 세션부터 쓸 수 있습니다.`,
                          )
                        }
                      >
                        {ENGINE_LABEL[missing]}에도 추가
                      </button>
                    ) : builtIn ? (
                      <span className="integration-note">Codex 앱 내장</span>
                    ) : (
                      <span />
                    )}
                  </div>
                );
              })}
            </section>

            <section className="sheet-section">
              <div className="sheet-label">스킬</div>
              <div className="integration-head">
                <span />
                <span>Claude</span>
                <span>Codex</span>
              </div>
              {view.skills.map((skill) => {
                const missing: Engine | null = skill.claude && !skill.codex ? "codex" : !skill.claude && skill.codex ? "claude" : null;
                return (
                  <div key={skill.name} className="integration-row">
                    <span className="integration-name" title={skill.description ?? undefined}>
                      {skill.name}
                      {skill.description ? <span className="integration-detail">{skill.description}</span> : null}
                    </span>
                    <Cell present={Boolean(skill.claude)} />
                    <Cell present={Boolean(skill.codex)} />
                    {missing ? (
                      <button
                        type="button"
                        className="button small"
                        disabled={busy !== null}
                        onClick={() =>
                          act(
                            `skill:${skill.name}`,
                            `스킬 '${skill.name}' 폴더를 ${ENGINE_LABEL[missing]}에도 복사합니다.\n\n쓰는 곳: ${missing === "claude" ? view.paths.claudeSkills : view.paths.codexSkills}/${skill.name}\n이미 있으면 덮어쓰지 않습니다.`,
                            () => api.copySkill(skill.name, missing),
                            `${ENGINE_LABEL[missing]}에 ${skill.name} 스킬을 복사했습니다.`,
                          )
                        }
                      >
                        {ENGINE_LABEL[missing]}에도 복사
                      </button>
                    ) : (
                      <span />
                    )}
                  </div>
                );
              })}
            </section>

            <section className="sheet-section">
              <div className="sheet-label">추천</div>
              {view.ieumSkill ? (
                <div className="integration-preset">
                  <div>
                    <strong>이음오피스 사용법 스킬</strong>
                    <div className="sheet-hint">엔진이 Workbench 밖에서도 ieumoffice 도구로 워드·PPT·엑셀을 다루게 하는 이음오피스의 공식 안내서입니다.</div>
                  </div>
                  {(["claude", "codex"] as const).map((engine) =>
                    view.ieumSkill![engine] ? (
                      <span key={engine} className="integration-cell on">
                        {ENGINE_LABEL[engine]} 있음
                      </span>
                    ) : (
                      <button
                        key={engine}
                        type="button"
                        className="button small"
                        disabled={busy !== null}
                        onClick={() =>
                          act(
                            `ieum:${engine}`,
                            `이음오피스 사용법 스킬을 ${ENGINE_LABEL[engine]}에 넣습니다.\n\n원본: ${view.ieumSkill!.source}\n쓰는 곳: ${engine === "claude" ? view.paths.claudeSkills : view.paths.codexSkills}/ieumoffice`,
                            () => api.installIeumSkill(engine),
                            `${ENGINE_LABEL[engine]}에 이음오피스 스킬을 넣었습니다.`,
                          )
                        }
                      >
                        {ENGINE_LABEL[engine]}에 넣기
                      </button>
                    ),
                  )}
                </div>
              ) : (
                <div className="sheet-hint">이음오피스를 설치하면 워드·PPT·엑셀용 사용법 스킬을 엔진에 넣을 수 있습니다.</div>
              )}
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
