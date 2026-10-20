import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The design page the Workbench UI embeds (iframe at /design/). `@` is the vendored doory source, used
// unchanged; this app only supplies the adapter, fonts and the bridge to the Workbench window.
const vendor = fileURLToPath(new URL("../../vendor/doory/src", import.meta.url));
const hostUrl = process.env.WORKBENCH_HOST_URL ?? "http://127.0.0.1:47820";

export default defineConfig({
  base: "/design/",
  plugins: [react()],
  resolve: { alias: { "@": vendor } },
  optimizeDeps: { include: ["mp4-muxer", "webm-muxer", "gifenc"] },
  server: {
    port: 5174,
    fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] },
    proxy: { "/api": { target: hostUrl }, "/fonts": { target: hostUrl } },
  },
  build: {
    // Served by the gateway from the web UI folder, next to the main app.
    outDir: fileURLToPath(new URL("../web/dist/design", import.meta.url)),
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      output: { manualChunks: (id) => (id.includes("/node_modules/fabric/") ? "fabric" : undefined) },
    },
  },
});
