import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import type { AttentionPayload } from "@workbench/contracts";

type Result = { status: "sent" | "unavailable" | "unknown"; detail?: string };
type Command = { file: string; args: string[]; env?: NodeJS.ProcessEnv; opensAttention: boolean };

// User text never becomes a script. OS payloads are generic; argv/env carry only the fixed copy.
export function notificationCommand(platform: NodeJS.Platform, payload: AttentionPayload, desktopBinary: string | null): Command | null {
  if (!/^[a-f0-9]{64}$/.test(payload.attentionId)) return null;
  if (platform === "linux") return { file: "notify-send", args: ["--app-name=Achmage Workbench", "--icon=achmage-workbench", "--expire-time=10000",
    ...(desktopBinary ? ["--wait", "--action=default=열기"] : []), "--", payload.title, payload.body], opensAttention: Boolean(desktopBinary) };
  if (platform === "darwin") return { file: "/usr/bin/osascript", args: ["-e", "on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run", payload.title, payload.body], opensAttention: false };
  if (platform === "win32") {
    // Windows' installed AppUserModelID is also the Tauri identifier. A missing registration
    // becomes unavailable, leaving the in-app record and foreground fallback intact.
    const script = `$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$toastXml = New-Object Windows.Data.Xml.Dom.XmlDocument
$toastXml.LoadXml('<toast><visual><binding template="ToastGeneric"><text></text><text></text></binding></visual></toast>')
$nodes = $toastXml.GetElementsByTagName('text')
$nodes.Item(0).InnerText = $env:WORKBENCH_ALERT_TITLE
$nodes.Item(1).InnerText = $env:WORKBENCH_ALERT_BODY
$toast = [Windows.UI.Notifications.ToastNotification]::new($toastXml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('kr.achmage.workbench').Show($toast)`;
    return { file: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      env: { ...process.env, WORKBENCH_ALERT_TITLE: payload.title, WORKBENCH_ALERT_BODY: payload.body }, opensAttention: false };
  }
  return null;
}

/** A daemon can submit desktop notifications without a renderer. No listener/process is adopted. */
export function systemNotifier(binary: string | null) {
  const desktopBinary = binary && existsSync(binary) ? binary : null;
  const children = new Set<ChildProcess>();
  let closed = false;
  const deliver = (payload: AttentionPayload): Promise<Result> => {
    if (closed || children.size >= 16) return Promise.resolve({ status: "unavailable", detail: "운영체제 알림을 지금 표시할 수 없습니다. 앱의 알림 목록에서 확인해 주세요." });
    const command = notificationCommand(process.platform, payload, desktopBinary);
    if (!command) return Promise.resolve({ status: "unavailable", detail: "이 환경에서는 운영체제 알림을 보낼 수 없습니다." });
    return new Promise(resolve => {
      const worker = execFile(command.file, command.args, { env: command.env, windowsHide: true, timeout: 20_000, maxBuffer: 4096 }, (error, stdout) => {
        children.delete(worker);
        if (error) {
          resolve(error.killed ? { status: "unknown", detail: "운영체제 알림 표시 결과를 확인하지 못했습니다." }
            : { status: "unavailable", detail: "운영체제 알림 서비스나 앱 등록을 사용할 수 없습니다." });
          return;
        }
        resolve({ status: "sent" });
        if (!closed && command.opensAttention && desktopBinary && stdout.trim() === "default") {
          // The app resolves this opaque ID against its own authenticated host before navigation.
          const child = spawn(desktopBinary, ["--attention", payload.attentionId], { detached: true, stdio: "ignore", windowsHide: true });
          child.on("error", () => undefined); child.unref();
        }
      });
      children.add(worker);
    });
  };
  return Object.assign(deliver, { close() { closed = true; for (const child of children) child.kill("SIGTERM"); children.clear(); } });
}
