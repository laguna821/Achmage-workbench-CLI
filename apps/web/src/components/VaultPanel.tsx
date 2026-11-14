import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { CredentialHandoffView, CredentialKind, CredentialSummary, CredentialsState } from "@workbench/contracts";
import type { Api } from "../api.ts";
import { featureError } from "./FeatureDialog.tsx";
import { Segmented } from "./ui/Hig.tsx";
import "../styles/vault-panel.css";

// "비밀 보관함" (휴대폰 메신저 → 비밀 보관함; design §6.5, §11): what this PC keeps so that its AI can
// log in, call a service or pay without seeing the value. Names, kinds, sites and last use; add with
// masked fields; rename; delete (and bring back for ten minutes); 매번 묻기; and the conversations
// waiting for something only the person has. A value is typed into a field that is never filled
// back, sent once, and gone with the form: no answer of the gateway carries one.

const KIND_LABEL: Record<CredentialKind, string> = { login: "로그인", "api-key": "API 키", card: "카드", other: "기타" };
const KIND_WORD: Record<CredentialKind, string> = { login: "로그인 정보", "api-key": "API 키", card: "카드 정보", other: "값" };
/** The fields of each kind, and whether each is a secret (masked, hidden in conversations) or not (a login's 아이디). */
const FIELDS: Record<CredentialKind, { name: string; secret: boolean }[]> = {
  login: [{ name: "아이디", secret: false }, { name: "비밀번호", secret: true }],
  "api-key": [{ name: "키", secret: true }],
  card: [{ name: "카드번호", secret: true }, { name: "유효기간", secret: true }, { name: "CVC", secret: true }],
  other: [{ name: "값", secret: true }],
};
const KINDS = (Object.keys(KIND_LABEL) as CredentialKind[]).map((value) => ({ value, label: KIND_LABEL[value] }));
const POLL_MS = 2_000;
const NO_KEYRING = "이 PC에는 보안 저장소가 없어 저장하지 않았습니다. 이번 한 번만 쓰고 버립니다.";

/** 을/를, 이/가 after a word as it is read (by its last syllable's final consonant). */
function particle(word: string, pair: "을/를" | "이/가"): string {
  const [withFinal, without] = pair.split("/") as [string, string];
  const last = [...word.trim()].at(-1) ?? "";
  const code = last.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 ? withFinal : without;
  if (/[0-9]/.test(last)) return "013678".includes(last) ? withFinal : without;
  return `${withFinal}(${without})`;
}
const day = (at: number) => new Date(at).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
const Name = ({ children }: { children: string }) => <bdi>{children}</bdi>;

type Said = { text: string; restore?: string };

export function VaultPanel({ api }: { api: Api }) {
  const [state, setState] = useState<CredentialsState | null>(null);
  const [error, setError] = useState(""), [said, setSaid] = useState<Said | null>(null), [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<{ handoff: CredentialHandoffView | null } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const live = useRef(true);

  const load = useCallback(async () => {
    const next = await api.request<CredentialsState>("GET", "/api/channels/credentials");
    if (live.current) setState(next);
    return next;
  }, [api]);
  useEffect(() => {
    live.current = true;
    // Opening the panel is a need for the store: one try to open it (the keyring may ask to be unlocked).
    void load().then(async (first) => {
      if (!first.locked) return;
      const next = await api.request<CredentialsState>("POST", "/api/channels/credentials/unlock");
      if (live.current) setState(next);
    }).catch((reason) => { if (live.current) setError(featureError(reason)); });
    // A conversation may start waiting at any time: looked at again while the panel is open.
    const timer = setInterval(() => { void load().catch(() => undefined); }, POLL_MS);
    return () => { live.current = false; clearInterval(timer); };
  }, [load]);

  const act = async (run: () => Promise<CredentialsState>, after?: (next: CredentialsState) => Said | null) => {
    if (busy) return;
    setBusy(true); setError(""); setSaid(null);
    try {
      const next = await run();
      if (!live.current) return;
      setState(next);
      setSaid(after?.(next) ?? null);
    } catch (reason) { if (live.current) setError(featureError(reason)); }
    finally { if (live.current) setBusy(false); }
  };
  const base = "/api/channels/credentials";
  const at = (id: string) => `${base}/${encodeURIComponent(id)}`;

  if (!state) return <section className="vault" aria-label="비밀 보관함">{error ? <p className="notice notice-error" role="alert">{error}</p> : <p className="muted">불러오는 중…</p>}</section>;
  return <section className="vault" aria-label="비밀 보관함">
    <p className="pm-hint">AI가 값을 보지 않고 쓰도록 이 PC에 봉인해 둡니다. 값은 어디에도 다시 보여 주지 않습니다. 바꾸려면 새로 넣으세요.</p>
    {error ? <p className="notice notice-error" role="alert">{error}</p> : null}
    {state.locked ? <p className="notice notice-error vault-locked" role="alert">PC의 키링이 잠겨 있습니다 · 저장한 값을 쓸 수 없습니다.
      <button type="button" className="text-button" disabled={busy} onClick={() => void act(() => api.request("POST", `${base}/unlock`))}>다시 시도</button></p> : null}
    {state.waiting.length ? <div className="vault-waiting" role="group" aria-label="기다리는 요청">
      {state.waiting.map((handoff) => <div key={handoff.id} className="vault-wait">
        <p className="vault-where">{handoff.sessionLabel ?? "대화"}</p>
        <p>{handoff.mode === "use"
          ? <>'<Name>{handoff.name}</Name>'{particle(handoff.name, "을/를")} 쓰려고 합니다.</>
          : <>'<Name>{handoff.name}</Name>' {KIND_WORD[handoff.kind]}{particle(KIND_WORD[handoff.kind], "이/가")} 필요합니다.</>}{handoff.site ? <span className="vault-site"> {handoff.site}</span> : null}</p>
        {handoff.inChat ? <p className="pm-hint">휴대폰에서도 물었습니다.</p> : null}
        <div className="feature-actions">
          {handoff.mode === "use" ? <>
            <button type="button" className="button small primary" disabled={busy} onClick={() => void act(() => api.request("POST", `${base}/handoffs/${encodeURIComponent(handoff.id)}`, { use: true }), () => ({ text: "쓰도록 했습니다. 기다리던 대화가 이어집니다." }))}>쓰기</button>
            <button type="button" className="button small" disabled={busy} onClick={() => void act(() => api.request("POST", `${base}/handoffs/${encodeURIComponent(handoff.id)}`, { use: false }), () => ({ text: "쓰지 않았습니다." }))}>안 쓰기</button>
          </> : <button type="button" className="button small primary" disabled={busy} onClick={() => { setAdding({ handoff }); setSaid(null); }}>넣기</button>}
        </div>
      </div>)}
    </div> : null}
    {adding ? <EntryForm key={adding.handoff?.id ?? "new"} handoff={adding.handoff} busy={busy} onCancel={() => setAdding(null)} onSubmit={async (body) => {
      // The form (and what was typed) stays until the gateway has kept it.
      if (busy) return false;
      setBusy(true); setError(""); setSaid(null);
      try {
        const next = await api.request<CredentialsState>("POST", base, body);
        if (!live.current) return true;
        setState(next);
        setAdding(null);
        const added = next.entries.find((candidate) => candidate.name === body.name);
        setSaid(added?.held === "memory" ? { text: NO_KEYRING } : { text: `「${body.name}」${particle(body.name, "을/를")} 봉인해 두었습니다.${adding.handoff ? " 기다리던 대화가 이어집니다." : ""}` });
        return true;
      } catch (reason) {
        if (live.current) setError(featureError(reason));
        return false;
      } finally { if (live.current) setBusy(false); }
    }} />
      : <div className="feature-actions"><button type="button" className="button small" disabled={busy} onClick={() => { setAdding({ handoff: null }); setSaid(null); }}>항목 추가</button></div>}
    {state.entries.length ? <ul className="vault-list">
      {state.entries.map((entry) => <Row key={entry.id} entry={entry} busy={busy} renaming={renaming === entry.id}
        onAsk={(on) => void act(() => api.request("PATCH", at(entry.id), { askEachTime: on }))}
        onDropHost={(host) => void act(() => api.request("PATCH", at(entry.id), { hosts: (entry.hosts ?? []).filter((other) => other !== host) }))}
        onRename={() => setRenaming(entry.id)} onRenamed={(name) => void act(async () => { const next = await api.request<CredentialsState>("PATCH", at(entry.id), { name }); setRenaming(null); return next; })} onCancelRename={() => setRenaming(null)}
        onDelete={() => void act(() => api.request("DELETE", at(entry.id)), () => ({ text: `「${entry.name}」${particle(entry.name, "을/를")} 지웠습니다.`, ...(entry.held === "sealed" ? { restore: entry.id } : {}) }))} />)}
    </ul> : <p className="muted">비어 있습니다. AI가 로그인이나 키가 필요하면 여기와 휴대폰에서 넣게 됩니다.</p>}
    {said ? <p className="pm-said vault-said" role="status">{said.text}{said.restore ? <> <button type="button" className="text-button" disabled={busy} onClick={() => void act(() => api.request("POST", `${at(said.restore!)}/restore`), () => ({ text: "되살렸습니다." }))}>되살리기</button></> : null}</p> : null}
  </section>;
}

function Row({ entry, busy, renaming, onAsk, onDropHost, onRename, onRenamed, onCancelRename, onDelete }: {
  entry: CredentialSummary; busy: boolean; renaming: boolean; onAsk(on: boolean): void; onDropHost(host: string): void; onRename(): void; onRenamed(name: string): void; onCancelRename(): void; onDelete(): void;
}) {
  const field = useRef<HTMLInputElement>(null), id = useId();
  return <li className="vault-row">
    <div className="vault-main">
      <strong><Name>{entry.name}</Name></strong>
      <span className="vault-meta">{[KIND_LABEL[entry.kind], entry.site, entry.lastUsedAt ? `마지막 사용 ${day(entry.lastUsedAt)}` : "쓰지 않음"].filter(Boolean).join(" · ")}{entry.held === "memory" ? " · 이번 한 번만(보안 저장소 없음)" : ""}</span>
      {entry.hosts?.length ? <span className="vault-meta">다른 주소: {entry.hosts.map((host, index) => <span key={host}>{index ? ", " : ""}{host} <button type="button" className="text-button" disabled={busy} aria-label={`${host} 빼기`} onClick={() => onDropHost(host)}>빼기</button></span>)}</span> : null}
    </div>
    <label className="feature-check vault-ask"><input type="checkbox" checked={entry.askEachTime} disabled={busy} onChange={(event) => onAsk(event.target.checked)} />매번 묻기</label>
    {renaming ? <form className="vault-rename" onSubmit={(event) => { event.preventDefault(); const name = field.current?.value.trim(); if (name) onRenamed(name); }}>
      <label htmlFor={id}>새 이름</label>
      <div className="vault-rename-row">
        <input id={id} ref={field} type="text" defaultValue={entry.name} maxLength={40} autoFocus />
        <button type="submit" className="button small primary" disabled={busy}>저장</button>
        <button type="button" className="button small" onClick={onCancelRename}>취소</button>
      </div>
    </form> : <div className="feature-actions vault-actions">
      <button type="button" className="button small" disabled={busy} onClick={onRename}>이름 바꾸기</button>
      <button type="button" className="text-button vault-delete" disabled={busy} onClick={onDelete}>지우기</button>
    </div>}
  </li>;
}

/**
 * Name, kind, site and the fields. The fields are not React state: their values are read once, on
 * submit, and cleared once kept. A secret field is masked (보기 shows it while typing); 아이디 is not.
 */
function EntryForm({ handoff, busy, onSubmit, onCancel }: {
  handoff: CredentialHandoffView | null; busy: boolean; onCancel(): void;
  onSubmit(body: { name: string; kind: CredentialKind; site: string; values: Record<string, string>; secret: Record<string, boolean> }): Promise<boolean>;
}) {
  const [kind, setKind] = useState<CredentialKind>(handoff?.kind ?? "login");
  const [problem, setProblem] = useState("");
  const [shown, setShown] = useState<Set<string>>(new Set());
  const name = useRef<HTMLInputElement>(null), site = useRef<HTMLInputElement>(null);
  const fields = handoff?.fields.length ? handoff.fields.map((field) => ({ name: field, secret: handoff.secret?.[field] !== false })) : FIELDS[kind];
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const flip = (field: string) => setShown((before) => { const next = new Set(before); if (next.has(field)) next.delete(field); else next.add(field); return next; });
  return <form className="vault-form" aria-label="비밀 넣기" onSubmit={(event) => {
    event.preventDefault();
    const values: Record<string, string> = {};
    for (const field of fields) values[field.name] = inputs.current.get(field.name)?.value ?? "";
    const named = name.current?.value.trim() ?? "";
    if (!named || Object.values(values).some((value) => !value)) { setProblem("이름과 모든 칸을 넣어 주세요."); return; }
    setProblem("");
    void onSubmit({ name: named, kind, site: site.current?.value.trim() ?? "", values, secret: Object.fromEntries(fields.map((field) => [field.name, field.secret])) }).then((kept) => {
      if (kept) for (const input of inputs.current.values()) input.value = "";
    });
  }}>
    <label>이름<input ref={name} type="text" defaultValue={handoff?.name ?? ""} readOnly={Boolean(handoff)} maxLength={40} autoComplete="off" /></label>
    {handoff ? null : <Segmented label="종류" value={kind} onChange={setKind} options={KINDS} />}
    <label>사이트<input ref={site} type="text" defaultValue={handoff?.site ?? ""} maxLength={200} autoComplete="off" placeholder="예: nid.naver.com" /></label>
    {fields.map((field) => <div key={`${kind}:${field.name}`} className="vault-field">
      <label>{field.name}<input ref={(input) => { if (input) inputs.current.set(field.name, input); else inputs.current.delete(field.name); }}
        type={field.secret && !shown.has(field.name) ? "password" : "text"} autoComplete={field.secret ? "new-password" : "off"} spellCheck={false} /></label>
      {field.secret ? <button type="button" className="button small vault-show" aria-pressed={shown.has(field.name)} aria-label={`${field.name} 보기`} onClick={() => flip(field.name)}>{shown.has(field.name) ? "숨기기" : "보기"}</button> : null}
    </div>)}
    {problem ? <p className="notice notice-error" role="alert">{problem}</p> : null}
    <div className="feature-actions">
      <button type="submit" className="button small primary" disabled={busy}>넣기</button>
      <button type="button" className="button small" disabled={busy} onClick={onCancel}>취소</button>
    </div>
  </form>;
}
