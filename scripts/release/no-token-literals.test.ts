// The repository is public and GitHub scans every push: a stand-in that has the SHAPE of a real
// credential (a Google API key, a GitHub token, a Slack or Telegram bot token …) raises a secret
// alert for the owner although it is fake (2026-11-14: a sample in a redactor test did). Tests that
// need such a sample put it together in code ("AIza" + "Sy…"), so no whole one sits in a file.
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHAPES = [
  "AIza[0-9A-Za-z_-]{35}",
  "gh[pousr]_[A-Za-z0-9]{36,}",
  "github_pat_[A-Za-z0-9_]{40,}",
  "sk-ant-[A-Za-z0-9_-]{20,}",
  "xox[abprs]-[0-9]+-[0-9]+-[A-Za-z0-9]{20,}",
  "xapp-[0-9]-[A-Z0-9]+-[0-9]+-[a-f0-9]{20,}",
  "[0-9]{8,10}:AA[A-Za-z0-9_-]{33}",
  "sk_live_[A-Za-z0-9]{20,}",
  "npm_[A-Za-z0-9]{36}",
  "glpat-[A-Za-z0-9_-]{20}",
  "hf_[A-Za-z0-9]{30,}",
];

it("no file holds a whole string shaped like a real credential", () => {
  let found = "";
  try {
    found = execFileSync("git", ["grep", "-n", "-I", "-E", SHAPES.join("|"), "--", "apps", "packages", "scripts", "docs", ".github"], { cwd: root, encoding: "utf8" });
  } catch (error) {
    // git grep exits 1 when nothing matches.
    if ((error as { status?: number }).status !== 1) throw error;
  }
  // Only where it is, never the value.
  expect(found.split("\n").filter(Boolean).map((line) => line.split(":").slice(0, 2).join(":"))).toEqual([]);
});
