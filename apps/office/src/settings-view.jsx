import React, { useEffect, useState } from "../../../vendor/ieumoffice/node_modules/react/index.js";
import { createRoot } from "../../../vendor/ieumoffice/node_modules/react-dom/client.js";
import { AiSection } from "@ieum/apps/shell/src/renderer/src/SettingsAiSection.tsx";
import { McpServerSection } from "@ieum/apps/shell/src/renderer/src/McpServerSection.tsx";
import { DriveSettingsCard } from "@ieum/apps/shell/src/renderer/src/DriveSettingsCard.tsx";
import { DrivePanel, useDriveState } from "@ieum/apps/shell/src/renderer/src/DrivePanel.tsx";
import { DrivePickerWindow } from "@ieum/apps/shell/src/renderer/src/drive-picker/DrivePickerWindow.tsx";
import { ipcRenderer } from "./platform/electron-renderer.ts";
import { DocumentPreferences } from "./preferences-view.jsx";
import { AiModelPane, AiMediaPane } from "@ieum/apps/shell/src/renderer/src/SettingsModal.tsx";
import { LocaleProvider, useI18n } from "@ieum/apps/shell/src/renderer/src/locale.tsx";
import { useSubscriptionConnection } from "@ieum/apps/shell/src/renderer/src/subscription-client.ts";
import "@ieum/packages/ui/src/tokens.css";
import "@ieum/packages/ui/src/dropdown.css";
import "@ieum/packages/ui/src/ai-usage.css";
import "@ieum/apps/shell/src/renderer/src/home.css";
import "@ieum/apps/shell/src/renderer/src/settings.css";
import "./settings.css";
import "@ieum/apps/shell/src/renderer/src/drive-picker/drive-picker.css";

const request = (channel, args = []) => ipcRenderer.invoke(channel, ...args);
const pickerApi = { list: (listing, pageToken) => request("drive:list", [listing, pageToken]),
  choose: picks => request("drive-picker:choose", [picks]), cancel: () => request("drive-picker:cancel") };
function Drive() {
  const state = useDriveState();
  return <main className="wb-office-settings set-pane">
    {state?.state === "unavailable" ? <p role="status">이 설치본에는 Google Drive 연결이 설정돼 있지 않습니다.</p> : <>
      <div id="drive-connection"><DriveSettingsCard /></div>
      <DrivePanel lang="ko" dateLocale="ko-KR" onOpenSettings={() => document.getElementById("drive-connection")?.scrollIntoView()} />
    </>}
  </main>;
}

function Settings() {
  const { t, lang } = useI18n(), connection = useSubscriptionConnection();
  const [error, setError] = useState(null), [legacy, setLegacy] = useState(0);
  useEffect(() => {
    const failed = (e) => setError(e.detail), changed = (e) => setLegacy(e.detail);
    window.addEventListener("workbench:settings-error", failed); window.addEventListener("workbench:settings-legacy", changed);
    return () => { window.removeEventListener("workbench:settings-error", failed); window.removeEventListener("workbench:settings-legacy", changed); };
  }, []);
  return <main className="wb-office-settings set-pane">
    {error && <div className="wb-settings-notice" role="alert"><span>{error}</span><button onClick={() => setError(null)} aria-label="알림 닫기">×</button></div>}
    {legacy > 0 && <p className="wb-settings-notice" role="status">이전 앱에서 보관한 키 {legacy}개를 유지하고 있습니다. 연결하려면 해당 키를 다시 입력해 주세요.</p>}
    <DocumentPreferences t={t} />
    <AiSection t={t} lang={lang} connection={connection} advanced={(tab) => tab === "model" ? <AiModelPane t={t} /> : <AiMediaPane t={t} lang={lang} codexImageAvailable={connection.codexImageAvailable} />} />
    <McpServerSection t={t} />
    <DriveSettingsCard />
  </main>;
}
const view = new URLSearchParams(location.search).get("view");
createRoot(document.getElementById("root")).render(<LocaleProvider initial="ko">{view === "drive" ? <Drive /> : view === "drive-picker" ? <DrivePickerWindow lang="ko" api={pickerApi} /> : <Settings />}</LocaleProvider>);
