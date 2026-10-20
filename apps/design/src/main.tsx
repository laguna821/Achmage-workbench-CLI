import "@/styles/tokens.css";
import "./design.css";

// The design page of Workbench (iframe at /design/). `?mode=render` is the hidden thumbnail renderer;
// otherwise it waits for the Workbench window to say which design to open.

const mode = new URLSearchParams(location.search).get("mode");

function applyTheme(theme: "light" | "dark") {
  document.documentElement.dataset.theme = theme;
}

async function start() {
  const { listen, next, post } = await import("./bridge");
  if (mode === "render") {
    const { startRenderService } = await import("./render");
    startRenderService();
    return;
  }
  listen((message) => {
    if (message.type === "design:theme") applyTheme(message.theme);
  });
  const ready = next("design:init");
  post({ type: "design:ready" });
  const init = await ready;
  applyTheme(init.theme);
  // Labels are read when the editor's modules load, so the Korean overlay goes in first.
  (await import("./locale")).localizeEditor();
  const [{ createRoot }, { EditorHost }] = await Promise.all([import("react-dom/client"), import("./EditorHost")]);
  createRoot(document.getElementById("root")!).render(<EditorHost init={{ token: init.token, artifactId: init.artifactId, revision: init.revision, readOnly: init.readOnly }} />);
}

void start();
