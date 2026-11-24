#!/usr/bin/env node
// A STAND-IN for Google's Antigravity CLI installer, for checks only (WORKBENCH_AGY_INSTALLER): it never
// downloads anything. It copies the stand-in agy (scripts/fixtures/fake-agy.mjs) to $FAKE_AGY_INSTALL_TO,
// printing lines like an installer would, so the settings card's 설치 → terminal tab → 다시 확인 path
// can be checked without reaching Google.
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const to = process.env.FAKE_AGY_INSTALL_TO;
if (!to) { console.error("stand-in installer: FAKE_AGY_INSTALL_TO is not set"); process.exit(2); }
console.log("Antigravity CLI installer (Workbench stand-in — nothing is downloaded)");
mkdirSync(dirname(to), { recursive: true });
copyFileSync(join(dirname(fileURLToPath(import.meta.url)), "fake-agy.mjs"), to);
chmodSync(to, 0o755);
console.log(`Installed agy to ${to}`);
console.log("Done. Return to Workbench and press 다시 확인.");
