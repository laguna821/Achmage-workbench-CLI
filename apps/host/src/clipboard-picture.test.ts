import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clipboardPicture } from "./clipboard-picture.ts";

// The desktop clipboard's picture, through a stand-in wl-paste that answers like the real one.

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 7)]);

function standIn(types: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "wb-wl-paste-"));
  writeFileSync(join(dir, "picture.png"), PNG);
  const script = join(dir, "wl-paste");
  writeFileSync(
    script,
    types === null
      ? '#!/bin/sh\necho "Nothing is copied" >&2\nexit 1\n'
      : `#!/bin/sh\nif [ "$1" = "--list-types" ]; then printf '${types}'; exit 0; fi\nif [ "$1" = "--no-newline" ] && [ "$2" = "--type" ] && [ "$3" = "image/png" ]; then cat "${join(dir, "picture.png")}"; exit 0; fi\nexit 1\n`,
  );
  chmodSync(script, 0o755);
  return { WAYLAND_DISPLAY: "wayland-test", WORKBENCH_WL_PASTE: script, PATH: process.env.PATH };
}

describe("the desktop clipboard's picture", () => {
  it("is read as the picture type the clipboard offers", async () => {
    expect(await clipboardPicture(standIn("text/plain\\nimage/png\\nimage/bmp\\n"))).toEqual({ data: PNG, type: "image/png" });
  });

  it("is nothing for text, an empty clipboard, or a desktop without a tool", async () => {
    expect(await clipboardPicture(standIn("text/plain;charset=utf-8\\ntext/html\\n"))).toBeNull();
    expect(await clipboardPicture(standIn(null))).toBeNull();
    expect(await clipboardPicture({ PATH: "/nonexistent" })).toBeNull();
  });
});
