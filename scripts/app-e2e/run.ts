// Real-app end-to-end checks of Achmage Workbench: the actual Tauri binary (Rust shell, WebKitGTK,
// the bundled gateway) driven through WebDriver (tauri-driver + WebKitWebDriver) on a private
// Broadway display and D-Bus session, with temporary data folders. See docs/app-e2e.md.
// Usage: node scripts/app-e2e/run.ts [binary] [outDir] [--only=start] [--engines=stand-in|real]

import { mkdirSync } from "node:fs";
import { openStage, type Stage } from "./launch.ts";
import { Report } from "./report.ts";
import { startScenario, type Ctx } from "./scenarios.ts";
import { panesScenario } from "./panes.ts";
import { pkmScenario } from "./pkm.ts";
import { workspacesScenario } from "./workspaces.ts";
import { navigationScenario } from "./navigation.ts";
import { tabsScenario } from "./tabs.ts";
import { documentsScenario } from "./documents.ts";
import { parseArgs } from "./args.ts";

const { binary, outDir, only, engines } = parseArgs(process.argv.slice(2));
mkdirSync(outDir, { recursive: true });
const wants = (name: string) => only.includes(name);

const report = new Report(outDir);
let stage: Stage | null = null;
const stop = async () => {
  await stage?.close();
  stage = null;
};
process.once("SIGINT", () => void stop().then(() => process.exit(130)));
process.once("SIGTERM", () => void stop().then(() => process.exit(143)));

try {
  stage = await openStage(outDir);
  console.log(`app ${binary}\nout ${outDir}\nBroadway ${stage.display} (http://127.0.0.1:${stage.broadwayPort}/) · tmp ${stage.root}`);
  if (only.length) {
    const app = await stage.launch({ name: engines, binary, engines, profile: "native" });
    const ctx: Ctx = { stage, app, report };
    try {
      await startScenario(ctx);
      if (wants("panes")) await panesScenario(ctx, { binary, engines, profile: "native" });
      if (wants("pkm")) await pkmScenario(ctx);
      if (wants("workspaces")) await workspacesScenario(ctx);
      if (wants("navigation")) await navigationScenario(ctx);
      if (wants("tabs")) await tabsScenario(ctx, { binary, engines, profile: "native" });
      if (wants("documents")) await documentsScenario(ctx);
    } catch (error) {
      const screenshot = report.path("failure.png");
      await ctx.app.wd.screenshot(screenshot).catch(() => undefined);
      report.check("실행", `${engines}: ${error instanceof Error ? error.message : String(error)}`, false, error instanceof Error ? error.stack : undefined, screenshot);
    } finally {
      await ctx.app.close();
    }
  }
} catch (error) {
  report.check("준비", error instanceof Error ? error.message : String(error), false);
} finally {
  await stop().catch((error: unknown) => report.check("종료", String(error), false));
  report.write({ binary, outDir, engines, requestedScenarios: only });
  console.log(report.summary());
  process.exitCode = !report.steps.length || report.steps.some((step) => !step.ok) ? 1 : 0;
}
