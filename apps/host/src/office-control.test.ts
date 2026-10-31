import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { OfficeControl } from "./office-control.mjs";
import { EventBus } from "./bus.ts";
import type { SessionManager } from "./sessions.ts";

it("uses the existing writer's tab across project aliases and accepts only its window's reply", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-office-control-")), path = join(dir, "source.pdf");
  writeFileSync(path, "%PDF fixture");
  const artifacts = [{ id: "old", path, format: "pdf" }, { id: "live", path, format: "pdf" }];
  const view = { artifactId: "live", viewId: "view-live", windowId: "window-live", mode: "write" };
  const manager = { documents: { list: () => artifacts, get: (id: string) => artifacts.find(artifact => artifact.id === id), registry: { forArtifact: () => [view] } } } as unknown as SessionManager;
  const bus = new EventBus(), control = new OfficeControl(manager, bus, dir);
  const seen: string[] = [];
  const stop = bus.subscribe(() => {
    const { commands } = control.list("window-live", false);
    for (const command of commands) {
      const reply = { status: "ok" as const, result: command.kind === "open" ? { opened: path } : { page: 2 } };
      expect(control.reply(command.id, "window-wrong", reply).accepted).toBe(false);
      expect(() => control.reply(command.id, "window-live", { status: "ok" })).toThrow();
      if (command.kind === "open") { expect(command.artifact.id).toBe("live"); seen.push("existing tab"); }
      else { expect(command.viewId).toBe("view-live"); expect(command.request).toEqual({ cmd: "goto", target: { kind: "page", page: 2 } }); seen.push("original renderer"); }
      control.reply(command.id, "window-live", reply);
    }
  });
  try {
    expect(await control.handle({ cmd: "open", path, target: { kind: "page", page: 2 } })).toEqual({ ok: true, result: { page: 2 } });
    expect(seen).toEqual(["existing tab", "original renderer"]);
    expect(await control.handle({ cmd: "open", path, target: { kind: "slide", slide: 0 } })).toMatchObject({ ok: false, error: { reason: "unsupported" } });
    expect(await control.handle({ cmd: "open", path: dir })).toMatchObject({ ok: false, error: { reason: "unsupported" } });
  } finally { stop(); control.close(); rmSync(dir, { recursive: true, force: true }); }
});

it("an unopened document is not treated as an available GUI selection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-control-closed-")), path = join(dir, "source.pdf");
  writeFileSync(path, "%PDF fixture");
  const manager = { documents: { list: () => [{ id: "stored", path, format: "pdf" }], registry: { forArtifact: () => [] } } } as unknown as SessionManager;
  const control = new OfficeControl(manager, new EventBus(), dir);
  try { expect(await control.handle({ cmd: "selection", path })).toMatchObject({ ok: false, error: { reason: "file_not_open_in_gui" } }); }
  finally { control.close(); rmSync(dir, { recursive: true, force: true }); }
});
