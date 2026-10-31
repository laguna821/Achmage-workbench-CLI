import { spawn } from "node:child_process";

/** Explicit external-open action. Normal document tabs use the embedded editors. */
export function openWithDesktop(file: string) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  const child = spawn(opener, [file], { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}
