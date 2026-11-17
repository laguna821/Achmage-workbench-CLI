// A gateway stand-in for scripts/engine-scope-unit-check.sh: run as a transient user SERVICE, it does what the gateway
// does at start (probe, sweep what this unit's previous run left, wrapping on) and starts one engine stand-in through
// the real wrapper — a stubborn one that ignores the end of its input and SIGHUP (the worst case) — then waits.
// Usage: node engine-scope-gateway.mjs <engine-scope.ts> <out folder>
import { appendFileSync } from "node:fs";
const [moduleFile, out] = process.argv.slice(2);
const scope = await import(moduleFile);
const probe = await scope.probeScope("linux", process.env);
if (!probe?.systemdRun) { appendFileSync(`${out}/log`, `no scopes ${JSON.stringify(probe)}\n`); process.exit(3); }
const swept = await scope.sweepEngineScopes(scope.engineScope.owner, 1_000);
scope.engineScope.enabled = true;
const engine = scope.spawnEngine(process.execPath, ["-e", "process.on('SIGHUP',()=>{}); process.stdout.write('up'); process.stdin.resume(); setInterval(()=>{},1000)"], { env: process.env }, "unitcheck", false);
engine.stdout.once("data", () => appendFileSync(`${out}/log`, `${process.pid} owner=${scope.engineScope.owner} swept=${swept} engine=${engine.pid}\n`));
setInterval(() => {}, 1000);
