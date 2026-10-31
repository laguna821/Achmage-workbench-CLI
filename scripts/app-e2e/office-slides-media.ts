import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { ServerResponse } from "node:http";
import JSZip from "jszip";
import { shot, until, type Ctx } from "./scenarios.ts";

/** Original PPT model tools and provider protocols; synthetic imagery, real editor/worker/save. */
export function slidesMediaFixture() {
  const { PNG } = createRequire(import.meta.url)("pngjs");
  const png = (width: number, height: number, color: number[]) => PNG.sync.write({ width, height, data: Buffer.alloc(width * height * 4, Buffer.from(color)) }).toString("base64");
  const landscape = png(96, 64, [0, 120, 135, 255]), portrait = png(64, 96, [230, 90, 30, 255]);
  const requests: { url: string; authorized: boolean; body: any }[] = [];
  return {
    settings: (port: number) => ({ imageProvider: "openai", analysisProvider: "openai", providers: { openai: { apiKey: "media-fixture-key", imageModel: "gpt-image-1", analysisModel: "gpt-4o", baseUrl: `http://127.0.0.1:${port}/media/v1` } } }),
    respond(url: string, authorized: boolean, body: any, res: ServerResponse) {
      requests.push({ url, authorized, body });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ b64_json: requests.length === 1 ? landscape : portrait }] }));
    },
    tool(count: number, body: any, marker: string) {
      const outputs = body.messages.filter((message: any) => message.role === "tool").map((message: any) => String(message.content));
      const url = outputs.flatMap((output: string) => [...output.matchAll(/Image generated, URL: (\S+)/g)].map(match => match[1])).at(-1);
      if (count === 1 || count === 4) return { name: "generate_image", input: { prompt: count === 1 ? "A landscape teal rectangle" : "A portrait orange rectangle" } };
      if (count === 2) {
        if (!url) throw new Error("No original generation URL");
        return { name: "insert_web_image", input: { slideIndex: 0, url, x: 60, y: 120, w: 180, h: 180 } };
      }
      if (count === 3) return { name: "read_slide", input: { slideIndex: 0 } };
      if (count === 5) {
        const sourceId = /^(e_\w+) \| picture \| pos\(60,120\) size 180×180/m.exec(outputs.join("\n"))?.[1];
        if (!url || !sourceId) throw new Error("No original picture durable ID or replacement URL");
        return { name: "replace_image", input: { slideIndex: 0, sourceId, url } };
      }
      if (count === 6) return { name: "apply_ops", input: { ops: [{ op: "setNotes", target: { slide: 0 }, text: marker }] } };
      return null;
    },
    async observe(ctx: Ctx) {
      await ctx.app.wd.execute(`window.__slideMedia=[];
        for (const name of ['insertImageUrl','replacePictureUrl']) {
          const call=window.slidesApi[name]; window.slidesApi[name]=async(...args)=>{
            const result=await call(...args); window.__slideMedia.push({name,args,result:JSON.parse(JSON.stringify(result))}); return result;
          };
        }`);
    },
    async preview(ctx: Ctx, reopened = false) {
      const { wd } = ctx.app, S = "Office PPT 미디어";
      await wd.execute(`document.querySelectorAll('.ai-work-group-summary[aria-expanded="false"]').forEach(button => button.click());`);
      await wd.waitFor('.ai-step-title[data-tip="generate_image"]', 10000);
      await wd.execute(`document.querySelectorAll('.ai-step-title[data-tip="generate_image"][aria-expanded="false"]').forEach(button => button.click());`);
      const shown = await until(() => wd.execute<boolean>('return [...document.querySelectorAll(".ai-tool-output-img-btn img")].filter(img=>img.complete && img.naturalWidth>0 && img.src.startsWith("blob:")).length===2;'), 15000);
      ctx.report.check(S, reopened ? "다시 연 대화에서 생성 이미지 카드 복원" : "생성 이미지 결과 카드 썸네일 표시", shown);
      if (!shown) throw new Error("Generated image thumbnails missing");
      await wd.click(await wd.waitFor('.ai-tool-output-img-btn[aria-label="생성 이미지 크게 보기"]'));
      const preview = await wd.waitFor("dialog.workbench-generated-image[open] img");
      const dimensions = await wd.execute<number[]>("return [arguments[0].naturalWidth,arguments[0].naturalHeight];", preview);
      ctx.report.check(S, "문서 안에서 생성 이미지 원본 미리보기", dimensions[0] === 96 && dimensions[1] === 64, JSON.stringify(dimensions), await shot(ctx, `suite-pptx-generated-preview${reopened ? "-reopened" : ""}.png`));
      await wd.click(await wd.waitFor("dialog.workbench-generated-image[open] > button"));
    },
    async check(ctx: Ctx, file: string) {
      const S = "Office PPT 미디어", { wd } = ctx.app;
      const observed = await wd.execute<any[]>("return window.__slideMedia;");
      writeFileSync(ctx.report.path("suite-pptx-media.json"), JSON.stringify({ requests, observed }, null, 2));
      const insert = observed[0], replace = observed[1];
      const first = insert?.result?.slide?.nodes.find((node: any) => node.sourceId === insert.result.sourceId);
      const last = replace?.result?.nodes.find((node: any) => node.durableId === first?.durableId);
      const near = (n: number | undefined, expected: number) => n !== undefined && Math.abs(n - expected) < 0.0001;
      ctx.report.check(S, "생성 이미지 삽입·중앙 crop·비율 유지", requests.length === 2 && requests.every(request => request.authorized) && near(first?.srcRect?.l, 1 / 6) && near(first?.srcRect?.r, 1 / 6) && near(first?.srcRect?.t, 0));
      ctx.report.check(S, "durable ID로 교체·기존 프레임 유지·새 비율 crop", replace?.args[0].sourceId === first?.durableId && first?.durableId === last?.durableId && JSON.stringify(first?.box) === JSON.stringify(last?.box) && near(last?.srcRect?.t, 1 / 6) && near(last?.srcRect?.b, 1 / 6) && near(last?.srcRect?.l, 0));
      const zip = await JSZip.loadAsync(readFileSync(file));
      const images = await Promise.all(Object.values(zip.files).filter(entry => entry.name.startsWith("ppt/media/") && !entry.dir).map(entry => entry.async("base64")));
      ctx.report.check(S, "PPTX 파일에 교체 이미지 실제 바이트 저장", images.includes(portrait));
      const visible = await shot(ctx, "suite-pptx-media-visible.png"), pixels = PNG.sync.read(readFileSync(visible));
      let orange = 0;
      for (let i = 0; i < pixels.data.length; i += 4) if (pixels.data[i] === 230 && pixels.data[i + 1] === 90 && pixels.data[i + 2] === 30) orange++;
      ctx.report.check(S, "교체 이미지가 실제 PPT 화면에 표시", orange > 1000, `${orange} orange pixels`, visible);
      const invalid = await wd.execute(`return window.slidesApi.insertImageUrl({slideIndex:0,base64:btoa('<html>not an image</html>'),ext:'png',xPx:0,yPx:0,wPx:20,hPx:20,fitWidthPx:960});`);
      ctx.report.check(S, "PNG로 위장한 HTML을 그림으로 삽입하지 않음", invalid === null);
    },
  };
}
