import { runHwpTool } from "./hwp-tool.ts";
try {
  const result = await runHwpTool(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  process.stderr.write(JSON.stringify({ status: "error", message: error instanceof Error ? error.message : String(error), ...(error && typeof error === "object" && "detail" in error ? { detail: error.detail } : {}) }) + "\n");
  process.exitCode = 1;
}
