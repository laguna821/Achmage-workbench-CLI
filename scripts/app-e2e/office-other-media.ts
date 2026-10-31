import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { ServerResponse } from "node:http";
import JSZip from "jszip";
import { shot, until, type Ctx } from "./scenarios.ts";

type Format = "md" | "html" | "xmind" | "hwpx" | "pdf" | "xlsx";
type Tool = { name: string; input: object } | null;

/** Original image tools across the other six editors; only the remote provider is synthetic. */
export function otherMediaFixture(format: Format, edit: (body: any, marker: string) => Tool) {
  const { PNG } = createRequire(import.meta.url)("pngjs");
  const png: Buffer = PNG.sync.write({ width: 96, height: 64, data: Buffer.alloc(96 * 64 * 4, Buffer.from([0, 120, 135, 255])) });
  const requests: { url: string; authorized: boolean; body: any }[] = [];
  return {
    settings: (port: number) => ({ imageProvider: "openai", analysisProvider: "openai", providers: { openai: { apiKey: "media-fixture-key", imageModel: "gpt-image-1", analysisModel: "gpt-4o", baseUrl: `http://127.0.0.1:${port}/media/v1` } } }),
    respond(url: string, authorized: boolean, body: any, res: ServerResponse) {
      requests.push({ url, authorized, body });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
    },
    tool(count: number, body: any, marker: string): Tool {
      const output = body.messages.filter((message: any) => message.role === "tool").map((message: any) => String(message.content)).join("\n");
      if (count === 1) return { name: "generate_image", input: { prompt: "A landscape teal rectangle", ...(format === "xmind" ? { topicId: "root-1" } : format === "hwpx" ? { where: "end", width_pt: 120 } : {}) } };
      if (format === "xlsx") {
        if (count === 2) return { name: "get_workbook_context", input: {} };
        if (count !== 3) return null;
        const path = /Image generated: (\S+)/.exec(output)?.[1], sheetId = /Active sheet: .*?\(id=([^,)]+)/.exec(output)?.[1];
        if (!path || !sheetId) throw new Error("No original Sheets image URL or sheet ID");
        return { name: "propose_operations", input: { operations: [{ op: "add_image", sheetId, path, anchorCell: "A4" }, { op: "set_cell", sheetId, address: "A1", value: marker, expectedValue: "Original text." }], summary: "Insert generated image and edit cell" } };
      }
      if (format === "pdf" && count === 2) {
        const url = /Generated image URL: (\S+)/.exec(output)?.[1];
        if (!url) throw new Error("No original PDF image URL");
        return { name: "insert_image", input: { page: 1, url, x: 40, y: 180, width: 120 } };
      }
      return count === (format === "pdf" ? 3 : 2) ? edit(body, marker) : null;
    },
    async observe(ctx: Ctx) {
      await ctx.app.wd.execute(`window.__officeMediaDiagnostics=[]; const error=console.error;
        console.error=(...args)=>{window.__officeMediaDiagnostics.push(args.map(value=>value instanceof Error ? value.stack||value.message : String(value))); return error(...args);};`);
      if (format === "xmind") await ctx.app.wd.execute(`for(const name of ['save','setDirty','sendCloseSaveResult']) {
        const call=window.mindmapApi[name]; window.mindmapApi[name]=(...args)=>{
          window.__officeMediaDiagnostics.push({name,at:performance.now(),args:name==='save'?{mode:args[0].mode,bytes:args[0].bytes.length}:args});
          const result=call(...args); if(result?.then) return result.then(value=>{window.__officeMediaDiagnostics.push({name,result:value,at:performance.now()});return value;}); return result;
        };
      }`);
    },
    async check(ctx: Ctx, file: string) {
      const S = `Office ${format} 미디어`, bytes = readFileSync(file);
      let persisted = false;
      const entries: string[] = [];
      if (format === "md" || format === "html") {
        const sources = format === "md" ? [...bytes.toString().matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(match => match[1]) : [...bytes.toString().matchAll(/<img[^>]+src=["']([^"']+)/g)].map(match => match[1]);
        for (const src of sources) {
          entries.push(src);
          if (src.startsWith("data:image/png;base64,")) persisted ||= Buffer.from(src.split(",")[1], "base64").equals(png);
          else if (!/^[a-z]+:/i.test(src)) {
            try { persisted ||= readFileSync(resolve(dirname(file), decodeURIComponent(src.replace(/&amp;/g, "&")))).equals(png); } catch { /* A broken reference is a failed persistence check. */ }
          }
        }
      } else if (format === "pdf") {
        const { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } = createRequire(new URL("../../vendor/ieumoffice/package.json", import.meta.url))("pdf-lib");
        const doc = await PDFDocument.load(bytes);
        for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
          if (!(object instanceof PDFRawStream) || object.dict.get(PDFName.of("Subtype"))?.toString() !== "/Image") continue;
          entries.push(String(ref));
          if (object.dict.get(PDFName.of("Width"))?.asNumber() !== 96 || object.dict.get(PDFName.of("Height"))?.asNumber() !== 64) continue;
          const rgb = Buffer.from(decodePDFRawStream(object).decode());
          persisted ||= rgb.equals(Buffer.alloc(96 * 64 * 3, Buffer.from([0, 120, 135])));
        }
      } else {
        const zip = await JSZip.loadAsync(bytes);
        for (const entry of Object.values(zip.files)) if (!entry.dir && /\.(png|jpe?g|gif)$/i.test(entry.name)) {
          entries.push(entry.name); persisted ||= (await entry.async("nodebuffer")).equals(png);
        }
      }
      writeFileSync(ctx.report.path(`suite-${format}-media.json`), JSON.stringify({ requests, entries, persisted }, null, 2));
      ctx.report.check(S, "원본 생성 엔진에 문서 설정과 제공자 키 전달", requests.length === 1 && requests[0].authorized && requests[0].url.endsWith("/images/generations"));
      ctx.report.check(S, "생성 이미지 실제 바이트를 문서 또는 상대 자원에 저장", persisted, JSON.stringify(entries));
    },
    async preview(ctx: Ctx, reopened = false) {
      let path = "", teal = 0;
      const shown = await until(async () => {
        path = await shot(ctx, `suite-${format}-media${reopened ? "-reopened" : ""}.png`);
        const pixels = PNG.sync.read(readFileSync(path)); teal = 0;
        for (let i = 0; i < pixels.data.length; i += 4) if (pixels.data[i] === 0 && pixels.data[i + 1] === 120 && pixels.data[i + 2] === 135) teal++;
        return teal > 1000;
      }, 10000);
      ctx.report.check(`Office ${format} 미디어`, reopened ? "저장 후 다시 연 문서에 생성 이미지 표시" : "실제 편집 화면에 생성 이미지 표시", shown, `${teal} teal pixels`, path);
    },
  };
}
