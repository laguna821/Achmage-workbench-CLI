import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { readToken } from "./api.ts";
import { applyFirstPaintTheme } from "./theme.ts";
import "./styles.css";

readToken();
applyFirstPaintTheme();

// Report UI errors to the local gateway log so failures in the desktop webview are visible.
function report(message: string) {
  const token = sessionStorage.getItem("workbench.token");
  if (!token) return;
  void fetch("/api/client-log", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ message }),
  }).catch(() => undefined);
}
window.addEventListener("error", (event) => report(`error: ${event.message} @ ${event.filename}:${event.lineno}`));
window.addEventListener("unhandledrejection", (event) => report(`unhandled: ${String(event.reason?.stack ?? event.reason)}`));
report(`ui started: ${navigator.userAgent} secure=${window.isSecureContext} uuid=${typeof crypto.randomUUID}`);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
