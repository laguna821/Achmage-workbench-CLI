import { existsSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { thirdPartyNotices } from "./notices.ts";

// IeumOffice's editor screens, built from vendor/ieumoffice (scripts/fetch-ieum.sh) and served by
// the gateway at /office/. Each page installs a bridge in place of IeumOffice's Electron preload,
// then loads the editor unchanged. The editors resolve their own packages from the vendored
// node_modules, so React and the rest come from IeumOffice's lockfile.
const ieum = fileURLToPath(new URL("../../vendor/ieumoffice", import.meta.url));
if (!existsSync(`${ieum}/node_modules`)) throw new Error("vendor/ieumoffice is missing: run scripts/fetch-ieum.sh first");
const packages = `${ieum}/packages`;

/**
 * TipTap's React binding (@tiptap/react 3.31, EditorInstanceManager.scheduleDestroy) destroys an
 * editor that is not mounted 1 ms after it was made. WebKit runs that timer before React's first
 * effects, so the Word editor's first instance is destroyed while it is being mounted and the page
 * crashes on it. Wait 10 s instead: the guard only exists to clean up editors that never mount.
 * Applied at build time; the vendored source is not edited.
 */
function tiptapMountGrace(): Plugin {
  const pattern = /(this\.scheduledDestructionTimeout = setTimeout\(\(\) => \{[\s\S]*?\}, )1(\);)/;
  return {
    name: "workbench-tiptap-mount-grace",
    transform(code, id) {
      if (!/[/\\]@tiptap[/\\]react[/\\]dist[/\\]index\.js$/.test(id)) return null;
      if (!pattern.test(code)) this.error("@tiptap/react changed: check the mount-grace patch in apps/office/vite.config.ts");
      return code.replace(pattern, (_, head: string, tail: string) => `${head}10000${tail}`);
    },
  };
}

export default defineConfig({
  base: "/office/",
  plugins: [
    react(),
    tiptapMountGrace(),
    thirdPartyNotices([
      { title: "IeumOffice / GenOffice (Apache License 2.0)", files: [`${ieum}/NOTICE`, `${ieum}/LICENSE`] },
      { title: "Unicode data used by IeumOffice", files: [`${ieum}/LICENSE-UNICODE.txt`] },
      {
        title: "Fonts bundled with the Word editor",
        files: [`${ieum}/apps/docs/src/renderer/fonts/README.md`, `${packages}/ui/src/fonts/README.md`, `${ieum}/apps/docs/src/renderer/fonts/LICENSE-OFL.txt`],
      },
    ]),
  ],
  resolve: {
    alias: {
      "@ieum": ieum,
      // The Word editor reads these workspace packages from source (as its own build does).
      "@genoffice/docx-engine/lazy-media": `${packages}/docx-engine/src/lazy-media.ts`,
      "@genoffice/docx-engine/zip-splice": `${packages}/docx-engine/src/zip-splice.ts`,
      "@genoffice/docx-engine": `${packages}/docx-engine/src/index.ts`,
      "@genoffice/odt-engine": `${packages}/odt-engine/src/index.ts`,
    },
  },
  server: { port: 5175, fs: { allow: [fileURLToPath(new URL("../..", import.meta.url))] } },
  build: {
    outDir: fileURLToPath(new URL("../web/dist/office", import.meta.url)),
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
    rollupOptions: { input: { docs: fileURLToPath(new URL("./docs.html", import.meta.url)) } },
  },
});
