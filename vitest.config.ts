import { defineConfig } from "vitest/config";
import { pdfPlatformResolve } from "./scripts/pdf-platform.mjs";
import { officeProviderResolve } from "./scripts/office-provider-platform.mjs";
import { officeFileParseResolve } from "./scripts/office-file-parse-platform.mjs";
import { hwpEngineResolve } from "./scripts/hwp-engine-platform.mjs";
import { ieumEarlierResolve } from "./scripts/ieum-earlier-source.mjs";
import { officeShellResolve } from "./scripts/office-shell-platform.mjs";

export default defineConfig({
  plugins: [{ name: "workbench-pdf-platform", enforce: "pre", resolveId: pdfPlatformResolve },
    { name: "workbench-office-provider-platform", enforce: "pre", resolveId: officeProviderResolve },
    { name: "workbench-office-file-parse", enforce: "pre", resolveId: officeFileParseResolve },
    { name: "workbench-hwp-engine", enforce: "pre", resolveId: hwpEngineResolve },
    { name: "workbench-ieum-earlier-source", enforce: "pre", resolveId: ieumEarlierResolve },
    { name: "workbench-office-shell-platform", enforce: "pre", resolveId: officeShellResolve }],
  test: {
    // The messenger tests wait on real timers; under load (a full run beside other work, a CI runner) a 5 s
    // limit has failed tests that pass alone. The limit is for a test that hangs, not for a slow machine.
    testTimeout: 15_000,
    // each test file in its own temp folder, removed after it (apps/host/src/test-temp-root.ts)
    setupFiles: ["apps/host/src/test-temp-root.ts"],
    globalSetup: ["apps/host/src/test-temp-global.ts"],
    include: ["packages/*/src/**/*.test.ts", "scripts/release/**/*.test.ts", "scripts/hwp-corpus/**/*.test.ts", "apps/host/src/**/*.test.ts", "apps/web/src/**/*.test.tsx", "apps/web/src/**/*.test.ts", "apps/design/**/*.test.ts", "apps/office/src/**/*.test.ts"],
  },
});
