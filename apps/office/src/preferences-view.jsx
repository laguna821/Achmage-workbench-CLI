import React, { useEffect, useState } from "../../../vendor/ieumoffice/node_modules/react/index.js";
import { Dropdown } from "@ieum/packages/ui/src/dropdown.tsx";
import { aiPanelFontPx, aiPanelStartOf, aiPanelStartPatch, DEFAULT_AI_PANEL_PREFS } from "@ieum/packages/ui/src/ai-panel-prefs.ts";
import { ipcRenderer } from "./platform/electron-renderer.ts";

// The original General settings' fields, dropdowns, translations and preference rules.
// The Workbench parent owns application theme/paths; this section edits document preferences.
export function DocumentPreferences({ t }) {
  const [panel, setPanel] = useState(DEFAULT_AI_PANEL_PREFS), [author, setAuthor] = useState({ value: "", fallback: "" });
  const [theme, setTheme] = useState("follow"), [autoSave, setAutoSave] = useState(false), [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const error = reason => window.dispatchEvent(new CustomEvent("workbench:settings-error", { detail: reason instanceof Error ? reason.message : String(reason) }));
  const invoke = (channel, ...args) => ipcRenderer.invoke(`home:${channel}`, ...args);
  useEffect(() => { let alive = true;
    void Promise.all([invoke("get-ai-panel-prefs"), invoke("get-author-name"), invoke("get-document-theme"), invoke("get-auto-save-default")]).then(([p, a, theme, save]) => {
      if (!alive) return; setPanel(p); setAuthor(a); setTheme(theme); setAutoSave(save.on); setReady(true);
    }).catch(error);
    return () => { alive = false; };
  }, []);
  const update = async (channel, value, apply) => { setBusy(true); try { apply(await invoke(channel, value)); } catch (reason) { error(reason); } finally { setBusy(false); } };
  const updatePanel = patch => update("set-ai-panel-prefs", patch, setPanel);
  const field = (label, control, desc) => <div className="set-field"><div className="set-field-text"><div className="set-field-label">{t(label)}</div>{desc && <div className="set-field-desc">{t(desc)}</div>}</div>{control}</div>;
  const choices = (value, label, options, pick) => <Dropdown className="set-dd" value={value} ariaLabel={t(label)} options={options.map(([value, key]) => ({ value, label: t(key) }))} onPick={pick} />;
  return <fieldset className="wb-document-preferences" disabled={!ready || busy}><legend>문서 표시와 편집</legend>
    {field("documentTheme", choices(theme, "documentTheme", [["follow", "docThemeFollowApp"], ["light", "themeLight"], ["dark", "themeDark"]], value => update("set-document-theme", value, setTheme)))}
    {field("setAiPanelSide", choices(panel.side, "setAiPanelSide", [["left", "aiPanelSideLeft"], ["right", "aiPanelSideRight"]], side => updatePanel({ side })))}
    {field("setAiFontSize", <><Dropdown className="set-dd" value={panel.fontSize} ariaLabel={t("setAiFontSize")} options={[["default", "aiFontSizeDefault"], ["large", "aiFontSizeLarge"], ["xlarge", "aiFontSizeXLarge"], ["custom", "aiFontSizeCustom"]].map(([value, key]) => ({ value, label: t(key) }))}
      onPick={fontSize => updatePanel(fontSize === "custom" && panel.fontSize !== "custom" ? { fontSize, customFontSize: aiPanelFontPx(panel) } : { fontSize })} />
      {panel.fontSize === "custom" && <input className="set-input wb-font-size" type="number" min="10" max="32" aria-label={t("aiFontSizeCustom")} value={panel.customFontSize} onChange={event => setPanel(previous => ({ ...previous, customFontSize: event.target.value }))} onBlur={() => updatePanel({ customFontSize: panel.customFontSize })} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />}</>)}
    {field("setAiSpellcheck", <button className="set-switch" type="button" role="switch" aria-label={t("setAiSpellcheck")} aria-checked={panel.spellcheck} onClick={() => updatePanel({ spellcheck: !panel.spellcheck })} />, "setAiSpellcheckDesc")}
    {field("setAiPanelStart", choices(aiPanelStartOf(panel), "setAiPanelStart", [["off", "aiPanelStartOff"], ["collapsed", "aiPanelStartCollapsed"], ["last", "aiPanelStartLast"]], start => updatePanel(aiPanelStartPatch(start))), "setAiPanelStartDesc")}
    {field("setAuthorName", <input id="set-author-name" className="set-input" type="text" aria-label={t("setAuthorName")} value={author.value} placeholder={author.fallback} maxLength={120} spellCheck={false} autoComplete="off"
      onChange={event => setAuthor(previous => ({ ...previous, value: event.target.value }))} onBlur={() => update("set-author-name", author.value, setAuthor)} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />, "setAuthorNameDesc")}
    {field("setAutoSave", <button className="set-switch" type="button" role="switch" aria-label={t("setAutoSave")} aria-checked={autoSave} onClick={() => update("set-auto-save-default", !autoSave, value => setAutoSave(value.on))} />, "setAutoSaveDesc")}
  </fieldset>;
}
