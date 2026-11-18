import { runConvertJob } from "./office-convert-work.mjs";
import type { ConvertJob } from "./office-convert.ts";

// One conversion (office-convert.ts) in a process of its own, forked by the gateway: it answers once and
// exits. Its own limit (argv[2], ms) for when the parent cannot end it; it ends when the parent is gone.
const limit = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 185_000;
setTimeout(() => process.exit(1), limit).unref();
process.once("disconnect", () => process.exit(0));
process.once("message", (job: ConvertJob) => {
  void runConvertJob(job).then((reply) => process.send?.(reply), (error: unknown) => process.send?.({ ok: false, code: "failed", detail: error instanceof Error ? error.message : String(error) }))
    .finally(() => process.disconnect?.());
});
