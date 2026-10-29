import { useEffect, useMemo, useState } from "react";
import type { WorksDirView } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { entryClient } from "../entry.ts";
import "../styles/entry.css";

/**
 * "새 프로젝트 폴더 위치" in "연결과 설정": where a project started without a folder gets its own
 * folder. Chosen with the system folder dialog (desktop) or typed; the gateway checks it takes
 * files. Only new projects go there: an engine continues a conversation only in its first folder.
 */
export function WorksDirRow({ api, pickFolder }: { api: Api; pickFolder: ((start: string | undefined) => Promise<string | null>) | null }) {
  const client = useMemo(() => entryClient(api), [api]);
  const [view, setView] = useState<WorksDirView | null>(null);
  const [typing, setTyping] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    let stale = false;
    void client
      .worksDir()
      .then((next) => !stale && setView(next))
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [client]);

  const apply = async (run: () => Promise<WorksDirView>, done: string) => {
    setBusy(true);
    try {
      setView(await run());
      setTyping(null);
      setMessage({ text: done, error: false });
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : String(error), error: true });
    } finally {
      setBusy(false);
    }
  };
  const save = (path: string) => apply(() => client.setWorksDir(path), "바꿨습니다. 다음 새 프로젝트부터 이 폴더 안에 만듭니다.");

  return (
    <>
      <div className="menu-divider" />
      <div className="menu-label">새 프로젝트 폴더 위치</div>
      <div className="connection works-dir">
        <div className="connection-meta mono works-dir-path" title={view?.path}>
          {view?.path ?? "확인 중…"}
        </div>
        <div className="connection-meta muted">
          {view?.custom ? "고른 위치" : "기본 위치"} · 폴더 없이 시작한 프로젝트가 이 안에 생깁니다. 이미 있는 작업은 옮기지 않습니다.
        </div>
        {view?.problem ? <div className="connection-meta warn">지금은 쓸 수 없습니다: {view.problem}</div> : null}
        {typing !== null ? (
          <form
            className="works-dir-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (typing.trim()) void save(typing.trim());
            }}
          >
            <input value={typing} onChange={(event) => setTyping(event.target.value)} placeholder="/home/…/프로젝트" aria-label="새 프로젝트 폴더 경로" spellCheck={false} autoFocus />
            <div className="works-dir-actions">
              <button type="submit" className="button primary small" disabled={busy || !typing.trim()}>
                저장
              </button>
              <button type="button" className="text-button" onClick={() => setTyping(null)}>
                취소
              </button>
            </div>
          </form>
        ) : (
          <div className="works-dir-actions">
            <button
              type="button"
              className="button small"
              disabled={busy}
              onClick={() => {
                setMessage(null);
                if (pickFolder)
                  void pickFolder(view?.path).then((picked) => {
                    if (picked) void save(picked);
                  });
                else setTyping(view?.path ?? "");
              }}
            >
              위치 바꾸기…
            </button>
            {view?.custom ? (
              <button type="button" className="text-button" disabled={busy} onClick={() => void apply(() => client.resetWorksDir(), "기본 위치로 되돌렸습니다.")}>
                기본으로
              </button>
            ) : null}
          </div>
        )}
        {message ? <div className={`connection-meta${message.error ? " warn" : ""}`}>{message.text}</div> : null}
      </div>
    </>
  );
}
