import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parseArgs } from "../../../scripts/app-e2e/args.ts";

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-e2e-args-"));
  roots.push(dir);
  const binary = join(dir, "app");
  writeFileSync(binary, "test executable\n");
  chmodSync(binary, 0o755);
  return { dir, binary };
};

it("uses the default executable for an empty argument and isolates engines by default", () => {
  const { dir, binary } = fixture();
  expect(parseArgs(["", dir], binary)).toMatchObject({ binary, outDir: dir, only: ["start", "panes", "pkm", "workspaces"], engines: "stand-in" });
});

it("refuses directories and unimplemented scenarios before starting any process", () => {
  const { dir, binary } = fixture();
  expect(() => parseArgs([dir])).toThrow(/must be a file/);
  expect(() => parseArgs([binary, "--only=models"])).toThrow(/not implemented/);
  expect(() => parseArgs([binary, "--only="])).toThrow(/not implemented/);
});
