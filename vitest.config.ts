import { defineConfig } from "vitest/config";
import { pdfPlatformResolve } from "./scripts/pdf-platform.mjs";

export default defineConfig({
  plugins: [{ name: "workbench-pdf-platform", enforce: "pre", resolveId: pdfPlatformResolve }],
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/host/src/**/*.test.ts", "apps/web/src/**/*.test.tsx"],
  },
});
