import { useEffect, useMemo, useState } from "react";
import type { WorksDirView } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { entryClient } from "../entry.ts";
import { PathDetail, SettingsRow } from "./SettingsSheet.tsx";
import "../styles/entry.css";

/**
 * 설정 › 일반 › 프로젝트 기본 폴더: where a project started without a folder gets its own
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

  const choose = () => {
    setMessage(null);
    if (pickFolder)
      void pickFolder(view?.path).then((picked) => {
        if (picked) void save(picked);
      });
    else setTyping(view?.path ?? "");
  };
  return (
    <SettingsRow
      className="works-dir"
      label="프로젝트 기본 폴더"
      state={view ? { text: view.custom ? "고른 폴더" : "기본 폴더" } : { text: "확인 중" }}
      hint="폴더를 고르지 않고 만든 프로젝트가 이 안에 생깁니다. 이미 있는 프로젝트는 옮기지 않습니다."
      control={typing === null ? <>
        <button type="button" className="button small" disabled={busy} onClick={choose}>다른 폴더 고르기…</button>
        {view?.custom ? <button type="button" className="text-button" disabled={busy} onClick={() => void apply(() => client.resetWorksDir(), "기본 폴더로 되돌렸습니다.")}>기본으로</button> : null}
      </> : undefined}
      detail={<>
        {view?.problem ? <p className="settings-note warn">지금은 이 폴더를 쓸 수 없습니다: {view.problem} 다른 폴더를 고르세요.</p> : null}
        {typing !== null ? (
          <form
            className="works-dir-form settings-inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (typing.trim()) void save(typing.trim());
            }}
          >
            <input value={typing} onChange={(event) => setTyping(event.target.value)} placeholder="/home/…/프로젝트" aria-label="새 프로젝트 폴더 경로" spellCheck={false} autoFocus />
            <button type="submit" className="button primary small" disabled={busy || !typing.trim()}>저장</button>
            <button type="button" className="text-button" onClick={() => setTyping(null)}>취소</button>
          </form>
        ) : null}
        {message ? <p className={`settings-note${message.error ? " warn" : ""}`} role={message.error ? "alert" : "status"}>{message.text}</p> : null}
        <PathDetail value={view?.path} />
      </>}
    />
  );
}
