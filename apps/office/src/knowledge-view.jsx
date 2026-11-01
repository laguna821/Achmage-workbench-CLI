import React, { useEffect, useState } from "../../../vendor/ieumoffice/node_modules/react/index.js";
import { createRoot } from "../../../vendor/ieumoffice/node_modules/react-dom/client.js";
import { KbAskPanel } from "@ieum/apps/shell/src/renderer/src/KbAskPanel.tsx";
import { LocaleProvider } from "@ieum/apps/shell/src/renderer/src/locale.tsx";
import { useSubscriptionConnection } from "@ieum/apps/shell/src/renderer/src/subscription-client.ts";
import { FirstConnectionDialog, useFirstConnectionNotice } from "@ieum/apps/shell/src/renderer/src/FirstConnectionNotice.tsx";
import { homeRequest } from "./knowledge-transport.ts";
import "@ieum/packages/ui/src/tokens.css";
import "@ieum/packages/ui/src/dropdown.css";
import "@ieum/packages/ui/src/ai-usage.css";
import "@ieum/apps/shell/src/renderer/src/home.css";
import "@ieum/apps/shell/src/renderer/src/settings.css";
import "./knowledge-home.css";

function Knowledge() {
  const connection = useSubscriptionConnection(), notice = useFirstConnectionNotice(connection.statuses);
  const [error, setError] = useState(null);
  useEffect(() => {
    const failed = event => setError(event.detail);
    window.addEventListener("workbench:knowledge-error", failed);
    return () => window.removeEventListener("workbench:knowledge-error", failed);
  }, []);
  const request = (channel, args) => void homeRequest(channel, args).catch(reason => setError(reason.message));
  return <main className="wb-knowledge-home">
    {error && <div className="wb-knowledge-error" role="alert"><span>{error}</span><button onClick={() => setError(null)} aria-label="알림 닫기">×</button></div>}
    <KbAskPanel connection={connection} aiSettings={notice.settings} noticeDue={notice.due}
      onOpenPath={path => request("home:open-path", [path])}
      onGoToRecents={() => request("home:knowledge-manage", [])}
      onOpenAiSettings={() => request("home:knowledge-settings", [])} />
    {notice.due && <FirstConnectionDialog onAcknowledge={notice.acknowledge} />}
  </main>;
}
createRoot(document.getElementById("root")).render(<LocaleProvider initial="ko"><Knowledge /></LocaleProvider>);
