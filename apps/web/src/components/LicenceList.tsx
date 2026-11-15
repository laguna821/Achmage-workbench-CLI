import { useEffect, useState } from "react";
import { SettingsRow } from "./SettingsSheet.tsx";

// 설정 › 정보 › 오픈소스 라이선스: one row per component the app ships with — its name, the licence its own
// text grants, and a key that shows the full text. The list and the texts are generated at build
// time from the repository's notices (apps/web/licences.ts → licences/index.json, licences/<name>.txt).

export type LicenceItem = { name: string; licences: string[]; files: string[]; attribution?: string; href?: string };

/** Beside the app's own page (the desktop window and a phone reach it on the same origin). */
const fromApp = (path: string) => fetch(new URL(path, document.baseURI).toString());

export function LicenceList({ load = fromApp }: { load?: (path: string) => Promise<Response> }) {
  const [items, setItems] = useState<LicenceItem[] | null | "error">(null);
  const [open, setOpen] = useState<string | null>(null);
  const [texts, setTexts] = useState<Record<string, string | "error">>({});
  useEffect(() => {
    let live = true;
    load("licences/index.json")
      .then((response) => (response.ok ? response.json() as Promise<LicenceItem[]> : Promise.reject(new Error(String(response.status)))))
      .then((list) => { if (live) setItems(Array.isArray(list) ? list : "error"); })
      .catch(() => { if (live) setItems("error"); });
    return () => { live = false; };
  }, [load]);
  const toggle = (name: string) => {
    const next = open === name ? null : name;
    setOpen(next);
    if (!next || (texts[next] && texts[next] !== "error")) return;
    const item = Array.isArray(items) ? items.find((entry) => entry.name === next) : undefined;
    load(item?.href ?? `licences/${encodeURIComponent(next)}.txt`)
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error(String(response.status)))))
      .then((text) => setTexts((current) => ({ ...current, [next]: text })))
      .catch(() => setTexts((current) => ({ ...current, [next]: "error" })));
  };
  if (items === null) return <SettingsRow label="오픈소스 라이선스" hint="목록을 불러오는 중입니다." />;
  if (items === "error" || !items.length) {
    return <SettingsRow label="오픈소스 라이선스" hint="목록을 불러오지 못했습니다. 라이선스 전문은 앱과 함께 설치된 third_party 폴더에 있습니다." />;
  }
  return <div className="settings-rows licence-list">
    {items.map((item) => {
      const shown = open === item.name, text = texts[item.name];
      return <SettingsRow key={item.name} className="licence-row" label={item.name}
        hint={<>{item.licences.length ? item.licences.join(", ") : "고지문"}{item.attribution ? <span className="licence-attribution">{item.attribution}</span> : null}</>}
        control={<button type="button" className="button small" aria-expanded={shown} aria-controls={`licence-${item.name}`} onClick={() => toggle(item.name)}>{shown ? "전문 닫기" : "전문 보기"}</button>}
        detail={shown ? <pre id={`licence-${item.name}`} className="licence-text" tabIndex={0} aria-label={`${item.name} 라이선스 전문`}>
          {text === undefined ? "불러오는 중입니다." : text === "error" ? "전문을 불러오지 못했습니다. 다시 눌러 보세요." : text}
        </pre> : null} />;
    })}
  </div>;
}
