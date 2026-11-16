// The detached update helper (app-update): `node update-helper.mjs <plan.json>`, started by the gateway
// from a copy in <data>/updates/helper. It outlives the app and the gateway, installs, starts the app
// again and leaves one result file (app-update/install.ts).
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { readPlan, runInstall, systemDeps, takeLock, writeResult } from "./app-update/install.ts";

const planFile = process.argv[2];
if (!planFile) { console.error("사용법: update-helper <plan.json>"); process.exit(2); }
const plan = readPlan(planFile);
const logFile = join(plan.dataDir, "updates", "helper.log");
const log = (line: string) => { try { appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 }); } catch { /* the result file still says it */ } };
const release = takeLock(plan.dataDir);
if (!release) {
  log("another helper is running");
  writeResult(plan.dataDir, { ok: false, version: plan.version, from: plan.from, kind: plan.kind, message: "다른 업데이트가 이미 진행 중이었습니다. 아무것도 바뀌지 않았습니다.", at: Date.now() });
  process.exit(1);
}
try {
  log(`start ${plan.kind} ${plan.from} -> ${plan.version}`);
  const result = await runInstall(plan, systemDeps(log));
  process.exitCode = result.ok ? 0 : 1;
} finally { release(); }
