import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeAtomic } from "./atomic-write.ts";
import { physicalPath, resolvedPath } from "./directory-operations.ts";
import { HttpError } from "./errors.ts";

// Replacing a file a person also has open elsewhere (Obsidian, a sync client): whole or not at all.

const dirs: string[] = [];
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-atomic-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("writeAtomic", () => {
  it("replaces the file with the new bytes, keeping its mode, and leaves nothing else in the folder", () => {
    const dir = folder();
    const path = join(dir, "노트.md");
    writeFileSync(path, "옛 글\n");
    // A mode the usual umask would narrow if the new file were merely made with it.
    chmodSync(path, 0o666);
    const inode = statSync(path).ino;
    writeAtomic(path, "새 글\n");
    expect(readFileSync(path, "utf8")).toBe("새 글\n");
    expect(statSync(path).mode & 0o777).toBe(0o666);
    expect(statSync(path).ino).not.toBe(inode);
    expect(readdirSync(dir)).toEqual(["노트.md"]);
    writeAtomic(path, Buffer.from([0xea, 0xb0, 0x80]));
    expect(readFileSync(path, "utf8")).toBe("가");
  });

  it("makes a file that was not there", () => {
    const dir = folder();
    writeAtomic(join(dir, "새 노트.md"), "첫 글\n");
    expect(readFileSync(join(dir, "새 노트.md"), "utf8")).toBe("첫 글\n");
    expect(readdirSync(dir)).toEqual(["새 노트.md"]);
  });

  it("follows a link: the link stays, its target is replaced, the temporary file is made beside the target", () => {
    const dir = folder();
    mkdirSync(join(dir, "real"));
    mkdirSync(join(dir, "link"));
    const real = join(dir, "real", "노트.md");
    const link = join(dir, "link", "노트.md");
    writeFileSync(real, "옛 글\n");
    symlinkSync(real, link);
    writeAtomic(link, "새 글\n");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toBe("새 글\n");
    expect(readdirSync(join(dir, "link"))).toEqual(["노트.md"]);
    expect(readdirSync(join(dir, "real"))).toEqual(["노트.md"]);
  });

  it("uses a hidden temporary name that fits beside a note with the longest name", () => {
    const dir = folder();
    // 80 Hangul syllables + ".md" is 243 bytes of a 255-byte name limit.
    const path = join(dir, `${"가".repeat(80)}.md`);
    writeFileSync(path, "옛 글\n");
    writeAtomic(path, "새 글\n");
    expect(readFileSync(path, "utf8")).toBe("새 글\n");
  });

  it("leaves the old bytes and no temporary file when the replacement cannot be put in place", () => {
    const dir = folder();
    // The target is a folder with something in it: the rename over it fails after the bytes were written.
    const path = join(dir, "노트.md");
    mkdirSync(path);
    writeFileSync(join(path, "안.txt"), "그대로\n");
    expect(() => writeAtomic(path, "새 글\n")).toThrow();
    expect(readdirSync(dir)).toEqual(["노트.md"]);
    expect(readFileSync(join(path, "안.txt"), "utf8")).toBe("그대로\n");
    // The folder takes no new file: nothing is made, the file is as it was.
    const locked = join(dir, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "노트.md"), "옛 글\n");
    chmodSync(locked, 0o555);
    try {
      expect(() => writeAtomic(join(locked, "노트.md"), "새 글\n")).toThrow();
      expect(readdirSync(locked)).toEqual(["노트.md"]);
      expect(readFileSync(join(locked, "노트.md"), "utf8")).toBe("옛 글\n");
    } finally {
      chmodSync(locked, 0o755);
    }
    expect(existsSync(join(locked, "노트.md"))).toBe(true);
  });

  // Review round 5.
  const refusal = (run: () => void): HttpError => {
    try {
      run();
    } catch (error) {
      if (error instanceof HttpError) return error;
      throw new Error(`not a plain refusal: ${String(error)}`);
    }
    throw new Error("was not refused");
  };

  it("refuses a file that is read-only, as writing it in place would: the rename is no way around the flag", () => {
    const dir = folder();
    const path = join(dir, "노트.md");
    writeFileSync(path, "옛 글\n");
    chmodSync(path, 0o444);
    const error = refusal(() => writeAtomic(path, "새 글\n"));
    expect(error.status).toBe(409);
    expect(error.message).toContain("노트.md");
    expect(error.message).toMatch(/쓸 수 없습니다.*바꾸지 않았습니다/);
    expect(readFileSync(path, "utf8")).toBe("옛 글\n");
    expect(statSync(path).mode & 0o777).toBe(0o444);
    expect(readdirSync(dir)).toEqual(["노트.md"]);
  });

  it("refuses a link whose target is missing instead of putting a regular file in its place", () => {
    const dir = folder();
    const link = join(dir, "노트.md");
    symlinkSync(join(dir, "없는 곳", "실제.md"), link);
    const error = refusal(() => writeAtomic(link, "새 글\n"));
    expect(error.status).toBe(409);
    expect(error.message).toContain("노트.md");
    expect(error.message).toMatch(/링크.*바꾸지 않았습니다/);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readdirSync(dir)).toEqual(["노트.md"]);
  });

  it("says in a plain sentence that a folder took no new file (which file, nothing changed), not the raw system error", () => {
    const dir = folder();
    const locked = join(dir, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "노트.md"), "옛 글\n");
    chmodSync(locked, 0o555);
    try {
      const error = refusal(() => writeAtomic(join(locked, "노트.md"), "새 글\n"));
      expect(error.status).toBe(409);
      expect(error.message).toContain("노트.md");
      expect(error.message).toMatch(/쓸 수 없습니다.*바꾸지 않았습니다/);
      expect(error.message).not.toMatch(/EACCES|\.tmp/);
      expect(readFileSync(join(locked, "노트.md"), "utf8")).toBe("옛 글\n");
      expect(readdirSync(locked)).toEqual(["노트.md"]);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  describe("on Windows (the win32 branch forced; not run on Windows)", () => {
    const actual = process.platform;
    const asWindows = <T,>(run: () => T): T => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      try {
        return run();
      } finally {
        Object.defineProperty(process, "platform", { value: actual, configurable: true });
      }
    };

    it("compares paths in lower case but resolves the path to write with its own case", () => {
      const dir = folder();
      const path = join(dir, "Weekly Plan.md");
      writeFileSync(path, "옛 글\n");
      expect(asWindows(() => physicalPath(path))).toBe(path.toLowerCase());
      expect(asWindows(() => resolvedPath(path))).toBe(path);
      expect(resolvedPath(path)).toBe(path);
    });

    it("writes the file under its own name, not a lower-cased one", () => {
      const dir = folder();
      const path = join(dir, "Weekly Plan.md");
      writeFileSync(path, "옛 글\n");
      asWindows(() => writeAtomic(path, "새 글\n"));
      expect(readdirSync(dir)).toEqual(["Weekly Plan.md"]);
      expect(readFileSync(path, "utf8")).toBe("새 글\n");
    });
  });
});
