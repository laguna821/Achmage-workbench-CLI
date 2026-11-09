#!/usr/bin/env node
import { readFileSync } from "node:fs";
import type { SubmitCommand, TaskCommand } from "@workbench/contracts";
import { WorkbenchClient } from "./index.ts";
import { connection } from "./config.ts";

const args = process.argv.slice(2), command = args.shift();
const fixtureAt = args.indexOf("--fixture"), fixture = fixtureAt >= 0 ? args.splice(fixtureAt, 2)[1] : undefined;
const payload = () => JSON.parse(readFileSync(args[0] && args[0] !== "-" ? args[0] : 0, "utf8"));
try {
  if (!command || command === "help" || command === "--help") console.log("workbench-client snapshot | tasks [workId] | profiles | submit <command.json|-> | command <command.json|-> | receipt <commandId>\nWORKBENCH_URL and WORKBENCH_TOKEN select the authorized host. --fixture <local-host.json> supplies a test host connection. A lost response must be looked up by receipt ID, never blindly resubmitted.");
  else {
    const client = new WorkbenchClient(connection(fixture));
    const result = command === "snapshot" ? await client.snapshot() : command === "tasks" ? await client.tasks(args[0]) : command === "profiles" ? await client.profiles()
      : command === "submit" ? await client.submit(payload() as SubmitCommand) : command === "command" ? await client.command(payload() as TaskCommand)
      : command === "receipt" && args[0] ? await client.receipt(args[0]) : (() => { throw Error("알 수 없는 명령입니다. help를 확인하세요."); })();
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
