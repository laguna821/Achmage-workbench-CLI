import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the host runs separately (WORKBENCH_HOST_URL); in the app it serves this build.
const hostUrl = process.env.WORKBENCH_HOST_URL ?? "http://127.0.0.1:47820";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { "/api": { target: hostUrl, changeOrigin: false } } },
  build: { outDir: "dist", target: "es2022", sourcemap: false },
});
