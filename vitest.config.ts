import { defineConfig } from "vitest/config";
import { pdfPlatformResolve } from "./scripts/pdf-platform.mjs";
import { officeProviderResolve } from "./scripts/office-provider-platform.mjs";
import { officeFileParseResolve } from "./scripts/office-file-parse-platform.mjs";

export default defineConfig({
  plugins: [{ name: "workbench-pdf-platform", enforce: "pre", resolveId: pdfPlatformResolve },
    { name: "workbench-office-provider-platform", enforce: "pre", resolveId: officeProviderResolve },
    { name: "workbench-office-file-parse", enforce: "pre", resolveId: officeFileParseResolve }],
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/host/src/**/*.test.ts", "apps/web/src/**/*.test.tsx", "apps/design/**/*.test.ts"],
  },
});
