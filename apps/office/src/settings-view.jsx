import React, { useEffect, useState } from "../../../vendor/ieumoffice/node_modules/react/index.js";
import { createRoot } from "../../../vendor/ieumoffice/node_modules/react-dom/client.js";
import { AiSection } from "@ieum/apps/shell/src/renderer/src/SettingsAiSection.tsx";
import { AiModelPane, AiMediaPane } from "@ieum/apps/shell/src/renderer/src/SettingsModal.tsx";
import { LocaleProvider, useI18n } from "@ieum/apps/shell/src/renderer/src/locale.tsx";
import { useSubscriptionConnection } from "@ieum/apps/shell/src/renderer/src/subscription-client.ts";
import "@ieum/packages/ui/src/tokens.css";
import "@ieum/packages/ui/src/dropdown.css";
import "@ieum/packages/ui/src/ai-usage.css";
import "@ieum/apps/shell/src/renderer/src/home.css";
import "@ieum/apps/shell/src/renderer/src/settings.css";
import "./settings.css";

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
    <AiSection t={t} lang={lang} connection={connection} advanced={(tab) => tab === "model" ? <AiModelPane t={t} /> : <AiMediaPane t={t} lang={lang} codexImageAvailable={connection.codexImageAvailable} />} />
  </main>;
}
createRoot(document.getElementById("root")).render(<LocaleProvider initial="ko"><Settings /></LocaleProvider>);
