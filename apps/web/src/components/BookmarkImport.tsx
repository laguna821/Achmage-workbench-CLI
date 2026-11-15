import { useEffect, useState } from "react";
import type { BookmarkSource } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { bookmarksOf, countBookmarks, useBookmarks } from "../bookmarks.ts";
import { SettingsGroup, SettingsRow, SettingsSwitch } from "./SettingsSheet.tsx";

// Bringing a browser's bookmarks in (bookmarks unit, 0.5.1): the first run's fourth step and 설정 › 일반
// show the same keys — one per browser found on this PC, each naming its browser ("Chrome에서 가져오기").
// Nothing of a browser is read until its key is pressed; then only its bookmarks. One line says what came in.

type Requester = Pick<Api, "request">;
type Way = { key: string; source: BookmarkSource; profile: { id: string; name: string }; several: boolean };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
export const BOOKMARKS_ONLY = "즐겨찾기만 읽습니다. 암호, 방문 기록, 로그인 정보는 읽지 않습니다.";
export const NO_BROWSER = "이 PC에서 즐겨찾기를 가져올 브라우저를 찾지 못했습니다.";

/** The browsers found (null while looking), and the import of one of them. */
function useBookmarkImport(api: Requester | undefined) {
  const [sources, setSources] = useState<BookmarkSource[] | null>(api ? null : []);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => {
    if (!api) return;
    let live = true;
    // A window that cannot ask (a phone joined to another PC) simply has no browser to offer.
    void bookmarksOf(api).sources().then(found => { if (live) setSources(found); }, () => { if (live) setSources([]); });
    return () => { live = false; };
  }, [api]);
  const ways: Way[] = (sources ?? []).flatMap(source => source.profiles.map(profile => ({ key: `${source.id}:${profile.id}`, source, profile, several: source.profiles.length > 1 })));
  const run = (way: Way) => {
    if (!api || busy) return;
    setBusy(way.key); setSaid(null);
    void bookmarksOf(api).importFrom(way.source.id, way.profile.id)
      .then(result => setSaid({ text: result.message, error: false }), reason => setSaid({ text: message(reason), error: true }))
      .finally(() => setBusy(null));
  };
  return { looking: sources === null, ways, busy, said, run };
}

const keyLabel = (way: Way, busy: boolean) => busy ? "가져오는 중…" : `${way.source.label}에서 가져오기`;
const keyName = (way: Way) => way.several ? `${way.source.label} ${way.profile.name}에서 가져오기` : `${way.source.label}에서 가져오기`;

/** The first run's 즐겨찾기 step: the browsers found, one key each; none found is said in one line. */
export function BookmarkImportStep({ api }: { api?: Requester }) {
  const { looking, ways, busy, said, run } = useBookmarkImport(api);
  return <>
    {looking ? <p className="onboarding-note" role="status">브라우저를 찾고 있습니다…</p>
      : ways.length ? <ul className="onboarding-ways">
        {ways.map(way => <li key={way.key} data-browser={way.source.id}>
          <div><strong>{way.source.label}</strong>{way.several ? <span>{way.profile.name}</span> : null}</div>
          <button type="button" className="button small" aria-label={keyName(way)} aria-busy={busy === way.key || undefined} disabled={Boolean(busy)} onClick={() => run(way)}>{keyLabel(way, busy === way.key)}</button>
        </li>)}
      </ul>
      : <p className="onboarding-note">{NO_BROWSER} 건너뛰어도 됩니다.</p>}
    {said ? <p className="onboarding-note" role={said.error ? "alert" : "status"}>{said.text}</p> : null}
    {ways.length ? <p className="onboarding-note">{BOOKMARKS_ONLY} 나중에 설정의 일반에서도 가져올 수 있습니다.</p> : null}
  </>;
}

/** 설정 › 일반 › 웹 즐겨찾기: 즐겨찾기 줄 보이기, the same import keys, 모두 지우기 behind a confirmation. */
export function BookmarkSettings({ api }: { api: Requester }) {
  const [data, client] = useBookmarks(api);
  const { looking, ways, busy, said, run } = useBookmarkImport(api);
  const [asking, setAsking] = useState(false), [clearing, setClearing] = useState(false), [error, setError] = useState("");
  const total = countBookmarks(data?.items ?? []);
  const act = (action: Promise<unknown>) => { setError(""); return action.catch(reason => setError(message(reason))); };
  return <SettingsGroup title="웹 즐겨찾기">
    <SettingsRow label="즐겨찾기 줄 보이기" hint="웹 탭의 주소 바로 아래에 즐겨찾기를 한 줄로 보여 줍니다. Ctrl+Shift+B로도 켜고 끕니다."
      control={<SettingsSwitch label="즐겨찾기 줄 보이기" checked={data?.showBar !== false} disabled={!data} onChange={next => void act(client.showBar(next))} />} />
    <SettingsRow label="브라우저에서 가져오기" hint={looking ? "브라우저를 찾고 있습니다…" : ways.length ? BOOKMARKS_ONLY : NO_BROWSER}
      detail={ways.length || said ? <>
        {ways.length ? <div className="browser-tools-actions">
          {ways.map(way => <button key={way.key} type="button" className="button small" aria-label={keyName(way)} aria-busy={busy === way.key || undefined} disabled={Boolean(busy)} onClick={() => run(way)}>{busy === way.key ? "가져오는 중…" : way.several ? `${way.source.label} (${way.profile.name})에서 가져오기` : keyLabel(way, false)}</button>)}
        </div> : null}
        {said ? <p className={`settings-note${said.error ? " warn" : ""}`} role={said.error ? "alert" : "status"}>{said.text}</p> : null}
      </> : undefined} />
    <SettingsRow label="즐겨찾기 모두 지우기" hint={total.items || total.folders ? `지금 즐겨찾기 ${total.items}개, 폴더 ${total.folders}개가 있습니다.` : "지금은 즐겨찾기가 없습니다."}
      control={asking ? undefined : <button type="button" className="button small danger" disabled={!total.items && !total.folders} onClick={() => setAsking(true)}>모두 지우기</button>}
      detail={asking || error ? <>
        {asking ? <div className="browser-tools-actions" role="group" aria-label="즐겨찾기 모두 지우기 확인">
          <span>즐겨찾기 {total.items}개와 폴더 {total.folders}개를 모두 지웁니다. 되돌릴 수 없습니다.</span>
          <button type="button" className="button small" disabled={clearing} autoFocus onClick={() => setAsking(false)}>취소</button>
          <button type="button" className="button small danger" aria-busy={clearing || undefined} disabled={clearing} onClick={() => { setClearing(true); void act(client.clear()).finally(() => { setClearing(false); setAsking(false); }); }}>{clearing ? "지우는 중…" : "모두 지우기"}</button>
        </div> : null}
        {error ? <p className="settings-note warn" role="alert">{error}</p> : null}
      </> : undefined} />
  </SettingsGroup>;
}
