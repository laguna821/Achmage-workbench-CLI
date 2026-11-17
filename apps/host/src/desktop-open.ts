import { spawn } from "node:child_process";
import { guiEnvironment } from "./gui-env.ts";

/** Explicit external-open action. Normal document tabs use the embedded editors. */
export function openWithDesktop(file: string) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  const child = spawn(opener, [file], { detached: true, stdio: "ignore", env: guiEnvironment() });
  child.on("error", () => undefined);
  child.unref();
}
