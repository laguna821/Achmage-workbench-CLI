import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { usePhoneWidth } from "../mobile-layout.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { restoreSurfaceFocus } from "./controls/menu-navigation.ts";
import "../styles/settings.css";

// 설정 (release unit B): ONE place, sized like Linear's settings — a left list of sections and a
// right pane of rows. The rail's foot, the top bar's ⋯ › 설정 and Ctrl+, open it; it reopens on the
// section seen last. Every control the old ⋯ pile held has a row here (rel-b report: old → new).

export type SettingsSection = "general" | "screen" | "engines" | "devices" | "messenger" | "vault" | "documents" | "advanced" | "about";

export const SETTINGS_SECTIONS: { id: SettingsSection; label: string; icon: IconName }[] = [
  { id: "general", label: "일반", icon: "settings" },
  { id: "screen", label: "화면", icon: "palette" },
  { id: "engines", label: "AI 엔진", icon: "bolt" },
  { id: "devices", label: "휴대폰과 다른 기기", icon: "link" },
  { id: "messenger", label: "메신저", icon: "chat" },
  { id: "vault", label: "비밀 보관함", icon: "shield" },
  { id: "documents", label: "문서 도구", icon: "file" },
  { id: "advanced", label: "고급", icon: "layers" },
  { id: "about", label: "정보", icon: "info" },
];

export const readSettingsSection = (value: unknown): SettingsSection =>
  SETTINGS_SECTIONS.some((entry) => entry.id === value) ? (value as SettingsSection) : "general";

export function SettingsSheet({ section, onSection, onClose, sections = SETTINGS_SECTIONS, listFirst = false, children }: {
  section: SettingsSection;
  onSection(next: SettingsSection): void;
  onClose(): void;
  /** The sections this window can show (a phone joined to another PC has no 메신저 or 비밀 보관함 here). */
  sections?: typeof SETTINGS_SECTIONS;
  /** Opened as "설정" (not on a named section): on a phone the section list is the first screen. */
  listFirst?: boolean;
  /** The chosen section's rows. */
  children: ReactNode;
}) {
  // On a phone (< 40rem) 설정 is two screens: the section list, then one section with a back key to the list.
  const phone = usePhoneWidth();
  const [stage, setStage] = useState<"list" | "section">(listFirst ? "list" : "section");
  const showList = phone && stage === "list";
  const dialog = useRef<HTMLDialogElement>(null), opener = useRef<Element | null>(document.activeElement);
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    const surface = dialog.current;
    if (surface && !surface.open) surface.showModal?.();
    // The chosen section's place in the list takes the focus: arrows move through the sections.
    // On a phone opened straight on a section, its title takes it (the list is the other screen).
    if (surface?.querySelector(".settings-nav")?.hasAttribute("hidden")) heading.current?.focus({ preventScroll: true });
    else surface?.querySelector<HTMLElement>('.settings-nav [aria-current="page"]')?.focus({ preventScroll: true });
    return () => restoreSurfaceFocus(opener.current, surface);
  }, []);
  const current = sections.find((entry) => entry.id === section) ?? sections[0]!;
  const move = (step: number, from: number) => {
    const next = sections[(from + step + sections.length) % sections.length]!;
    onSection(next.id);
    requestAnimationFrame(() => dialog.current?.querySelector<HTMLElement>(`.settings-nav [data-section="${next.id}"]`)?.focus());
  };
  const back = () => { setStage("list"); requestAnimationFrame(() => dialog.current?.querySelector<HTMLElement>(`.settings-nav [data-section="${current.id}"]`)?.focus()); };
  return <dialog ref={dialog} className="settings-dialog" data-stage={phone ? stage : undefined} aria-labelledby="settings-title" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <nav className="settings-nav" aria-labelledby="settings-title" hidden={phone && !showList}>
      <div className="settings-nav-head">
        <h2 id="settings-title">설정</h2>
        {showList ? <button type="button" className="icon-button settings-close" aria-label="설정 닫기" title="설정 닫기 (Esc)" onClick={onClose}><Icon name="x" size={18} /></button> : null}
      </div>
      <ul>
        {sections.map((entry, index) => <li key={entry.id}>
          <button type="button" data-section={entry.id} aria-current={entry.id === current.id ? "page" : undefined} tabIndex={entry.id === current.id ? 0 : -1}
            onClick={() => { onSection(entry.id); setStage("section"); requestAnimationFrame(() => heading.current?.focus({ preventScroll: true })); }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") { event.preventDefault(); move(1, index); }
              else if (event.key === "ArrowUp") { event.preventDefault(); move(-1, index); }
              else if (event.key === "Home") { event.preventDefault(); move(0, 0); }
              else if (event.key === "End") { event.preventDefault(); move(0, sections.length - 1); }
            }}>
            <Icon name={entry.icon} size={16} /><span>{entry.label}</span>
          </button>
        </li>)}
      </ul>
    </nav>
    <section className="settings-pane" aria-labelledby="settings-section-title" data-section={current.id} hidden={showList}>
      <header className="settings-pane-head">
        {phone ? <button type="button" className="icon-button settings-back" aria-label="설정 목록으로" title="설정 목록으로" onClick={back}><Icon name="chevronLeft" size={18} /></button> : null}
        <h2 id="settings-section-title" ref={heading} tabIndex={-1}>{current.label}</h2>
        <button type="button" className="icon-button settings-close" aria-label="설정 닫기" title="설정 닫기 (Esc)" onClick={onClose}><Icon name="x" size={18} /></button>
      </header>
      <div className="settings-body" key={current.id}>{children}</div>
    </section>
  </dialog>;
}

/** A group of rows under a quiet head (13 px, 600, muted): no box around it, hairlines between rows. */
export function SettingsGroup({ title, children, action }: { title?: string; children: ReactNode; action?: ReactNode }) {
  return <section className="settings-group" aria-label={title}>
    {title || action ? <div className="settings-group-head">{title ? <h3>{title}</h3> : <span />}{action}</div> : null}
    <div className="settings-rows">{children}</div>
  </section>;
}

/**
 * One row: the label, one line of explanation, and the control at the end. `detail` holds what
 * needs more than one line (a list, a form, a path behind 경로 보기) under the row's text.
 */
export function SettingsRow({ label, hint, control, detail, state, mark, className = "" }: {
  label: ReactNode; hint?: ReactNode; control?: ReactNode; detail?: ReactNode;
  /** One state word after the label (연결됨, 로그인 필요 …): tone ok/warn or none. */
  state?: { text: string; tone?: "" | "ok" | "warn" };
  /** A leading 16 px mark (an engine's own mark). */
  mark?: ReactNode;
  className?: string;
}) {
  return <div className={`settings-row ${className}`.trim()}>
    {mark ? <span className="settings-row-mark" aria-hidden>{mark}</span> : null}
    <div className="settings-row-text">
      <div className="settings-row-label">{label}{state ? <span className={`settings-state${state.tone ? ` ${state.tone}` : ""}`}>{state.text}</span> : null}</div>
      {hint ? <div className="settings-row-hint">{hint}</div> : null}
    </div>
    {control ? <div className="settings-row-control">{control}</div> : null}
    {detail ? <div className="settings-row-detail">{detail}</div> : null}
  </div>;
}

/** A raw path or a developer fact, only when asked for (j5): "경로 보기". */
export function PathDetail({ value, label = "경로 보기" }: { value: string | null | undefined; label?: string }) {
  if (!value) return null;
  return <details className="settings-path"><summary>{label}</summary><code>{value}</code></details>;
}

/** A switch row's control: a checkbox drawn as a switch, named by the row's label. */
export function SettingsSwitch({ checked, onChange, label, disabled }: { checked: boolean; onChange(next: boolean): void; label: string; disabled?: boolean }) {
  return <label className="check-row switch-row settings-switch" data-component="toggle">
    <input type="checkbox" role="switch" checked={checked} disabled={disabled} aria-label={label} onChange={(event) => onChange(event.target.checked)} />
  </label>;
}
