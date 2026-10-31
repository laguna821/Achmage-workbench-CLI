import { readFileSync } from "node:fs";
import type { Plugin } from "vite";
import { TEMPLATE_FONTS, TEMPLATE_FONT_FILES } from "../../vendor/ieumoffice/packages/ui/src/template-fonts.ts";

/** Keep original filenames and license texts: the user can install these same faces. */
export function templateFonts(folder: string): Plugin {
  const files = [...new Set([...TEMPLATE_FONT_FILES, ...TEMPLATE_FONTS.map((font) => font.licenseFile), "README.md"])];
  return {
    name: "workbench-template-fonts",
    generateBundle() {
      for (const file of files) this.emitFile({ type: "asset", fileName: `template-fonts/${file}`, source: readFileSync(`${folder}/${file}`) });
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        let file: string;
        try { file = decodeURIComponent((req.url ?? "").split("?")[0]!.replace(/^\/office\/template-fonts\//, "")); } catch { next(); return; }
        if (!files.includes(file)) { next(); return; }
        res.setHeader("content-type", /\.(ttf|otf)$/.test(file) ? "font/otf" : "text/plain; charset=utf-8");
        res.end(readFileSync(`${folder}/${file}`));
      });
    },
  };
}
