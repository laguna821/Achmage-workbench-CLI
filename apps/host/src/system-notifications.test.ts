import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attentionArgs, notificationCommand, opensOn, systemNotifier } from "./system-notifications.ts";

// 0.5.3 window-ux: a Linux notification's click (its body, or its 열기 button) opens THAT conversation in the app,
// whenever it comes; the daemon's activation token travels with it. A stand-in notify-send plays the daemon.

const id = "a".repeat(64);
const payload = { title: "Achmage Workbench", body: "작업이 완료되었습니다.", attentionId: id };
const dirs: string[] = [];
const path = process.env.PATH;
afterEach(() => { process.env.PATH = path; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function rig(notifySend: string) {
  const dir = mkdtempSync(join(tmpdir(), "wb-notify-")); dirs.push(dir);
  writeFileSync(join(dir, "notify-send"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/notify-args"\n${notifySend}\n`); chmodSync(join(dir, "notify-send"), 0o755);
  writeFileSync(join(dir, "app"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/app-args"\n`); chmodSync(join(dir, "app"), 0o755);
  process.env.PATH = `${dir}:${path}`;
  return { dir, app: join(dir, "app"), opened: async () => { for (let i = 0; i < 50 && !existsSync(join(dir, "app-args")); i++) await new Promise(done => setTimeout(done, 40)); return existsSync(join(dir, "app-args")) ? readFileSync(join(dir, "app-args"), "utf8").trim().split("\n") : null; } };
}

describe("a Linux notification's click", () => {
  it("offers both the body click and a 열기 button, prints its id and hands over the activation token", () => {
    const command = notificationCommand("linux", payload, "/opt/app")!;
    expect(command.args).toEqual(expect.arrayContaining(["--print-id", "--action=default=열기", "--action=open=열기", "--activation-token-fd=3"]));
    expect(command.args.slice(-3)).toEqual(["--", payload.title, payload.body]);
    expect(notificationCommand("linux", payload, null)!.args).not.toContain("--print-id");
    expect([opensOn("default"), opensOn("open"), opensOn("7"), opensOn("")]).toEqual([true, true, false, false]);
    expect(attentionArgs(id, "tok-1")).toEqual(["--attention", id, "--activation-token", "tok-1"]);
    expect(attentionArgs(id, "bad token\n")).toEqual(["--attention", id]);
    expect(attentionArgs(id, null)).toEqual(["--attention", id]);
  });

  it.runIf(process.platform === "linux")("is 'sent' once shown, and a click on the body opens its conversation with the token", async () => {
    const { app, opened } = rig("echo 41\nsleep 0.2\nprintf 'xdg-token-9' >&3\necho default");
    const deliver = systemNotifier(app);
    expect(await deliver(payload)).toEqual({ status: "sent" });
    expect(await opened()).toEqual(["--attention", id, "--activation-token", "xdg-token-9"]);
    deliver.close();
  });

  it.runIf(process.platform === "linux")("the 열기 button does the same; a notification closed without a click opens nothing", async () => {
    const button = rig("echo 42\necho open");
    const deliver = systemNotifier(button.app);
    await deliver(payload);
    expect(await button.opened()).toEqual(["--attention", id]);
    deliver.close();
    const dismissed = rig("echo 43");
    const other = systemNotifier(dismissed.app);
    expect(await other(payload)).toEqual({ status: "sent" });
    expect(await dismissed.opened()).toBeNull();
    other.close();
  });

  it.runIf(process.platform === "linux")("a click that comes after the old 20 s limit still opens it (the waiter is not killed)", async () => {
    const late = rig("echo 44\nsleep 0.3\necho default");
    const deliver = systemNotifier(late.app);
    const shown = Date.now();
    expect(await deliver(payload)).toEqual({ status: "sent" });
    expect(Date.now() - shown).toBeLessThan(250); // "sent" at the id, not at the click
    expect(await late.opened()).toEqual(["--attention", id]);
    deliver.close();
  });
});
