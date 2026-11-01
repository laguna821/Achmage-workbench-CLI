import { useEffect, useState } from "react";
import type { Api } from "../api.ts";
import type { OfficeDriveAttachments, OfficeDriveNotice, OfficeDrivePrompt } from "../../../../packages/contracts/src/office-drive.ts";
import { OfficeSettings } from "./OfficeSettings.tsx";

type Pick = { finish(value: OfficeDriveAttachments): void; signal: AbortSignal; context: { artifactId: string; editorToken: string } };
/** This event stays in the trusted parent; no document receives Drive listing authority. */
export function pickOfficeDrive(signal: AbortSignal, context: Pick["context"]): Promise<OfficeDriveAttachments> {
  return new Promise(resolve => {
    const cancel = () => finish({ ok: false, reason: "cancelled" });
    const finish = (value: OfficeDriveAttachments) => { signal.removeEventListener("abort", cancel); resolve(value); };
    if (signal.aborted) return cancel();
    signal.addEventListener("abort", cancel, { once: true });
    window.dispatchEvent(new CustomEvent<Pick>("workbench:drive-pick", { detail: { signal, finish, context } }));
  });
}

/** Synchronization belongs to the app, even while the person is in another tab. */
export function OfficeDrive({ api, theme }: { api: Api; theme: "light" | "dark" }) {
  const [pick, setPick] = useState<Pick | null>(null), [activity, setActivity] = useState<{ prompts: OfficeDrivePrompt[]; notices: OfficeDriveNotice[] }>({ prompts: [], notices: [] });
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  useEffect(() => {
    let current: Pick | null = null;
    const receive = (event: Event) => {
      const next = (event as CustomEvent<Pick>).detail;
      if (current) { next.finish({ ok: false, reason: "busy" }); return; }
      const end = next.finish;
      const done = (value: OfficeDriveAttachments) => { next.signal.removeEventListener("abort", cancel); current = null; setPick(null); end(value); };
      const cancel = () => done({ ok: false, reason: "cancelled" });
      current = { ...next, finish: done }; next.signal.addEventListener("abort", cancel, { once: true }); setPick(current);
    };
    window.addEventListener("workbench:drive-pick", receive);
    return () => { window.removeEventListener("workbench:drive-pick", receive); current?.finish({ ok: false, reason: "cancelled" }); };
  }, []);
  useEffect(() => {
    let live = true, pending = false;
    const refresh = async () => {
      if (pending) return; pending = true;
      try { const next = await api.request<typeof activity>("GET", "/api/office-drive/activity"); if (live) setActivity(next); }
      catch { /* Gateway readiness/reconnect follows the app's existing status. */ }
      finally { pending = false; }
    };
    void refresh(); const timer = setInterval(refresh, 1500);
    return () => { live = false; clearInterval(timer); };
  }, [api]);
  const prompt = activity.prompts[0], notice = activity.notices[0];
  const answer = async (id: string, value?: string) => {
    setBusy(true); setError(null);
    try {
      await api.request("POST", "/api/office-drive/answer", { id, value });
      setActivity(current => ({ prompts: current.prompts.filter(item => item.id !== id), notices: current.notices.filter(item => item.id !== id) }));
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  return <>
    {pick && <OfficeSettings api={api} theme={theme} mode="drive-picker" attachmentContext={pick.context} onClose={() => pick.finish({ ok: false, reason: "cancelled" })} onPicked={pick.finish} />}
    {(prompt || notice) && <div className="office-settings-overlay"><section className="office-drive-question" role="dialog" aria-modal="true" aria-label="Google Drive 저장">
      <h2>Google Drive</h2><p>{prompt?.message ?? notice?.message}</p>{prompt && <p>{prompt.detail}</p>}
      {error && <p role="alert">{error}</p>}
      <div className="office-drive-choices">{prompt ? prompt.choices.map(choice => <button key={choice.value} type="button" disabled={busy} autoFocus={choice.value === "copy"} onClick={() => void answer(prompt.id, choice.value)}>{choice.label}</button>) : <button type="button" disabled={busy} onClick={() => void answer(notice!.id)}>확인</button>}</div>
    </section></div>}
  </>;
}
