import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import { createRequire } from "node:module";
import { openStage } from "./app-e2e/launch.ts";

const run = promisify(execFile), repo = resolve(import.meta.dirname, "..");
const { PNG } = createRequire(import.meta.url)("pngjs") as { PNG: { sync: { read(bytes: Buffer): { width: number; height: number; data: Buffer } } } };
const out = resolve(process.argv[2] ?? "/tmp/workbench-cli-check"); mkdirSync(out, { recursive: true });
const only = process.argv.find(arg => arg.startsWith("--only="))?.slice(7).split(",") ?? ["docx", "docx-2", "docx-blank", "docx-12", "pptx", "xlsx", "csv", "csv-legacy", "xls-html", "md", "html", "docx-html", "html-docx"];
const binary = join(repo, "apps/desktop/src-tauri/target/debug/achmage-workbench");
const cli = process.argv.find(arg => arg.startsWith("--cli="))?.slice(6);
const ieumCli = process.argv.find(arg => arg.startsWith("--ieum-cli="))?.slice(11);
const xlsFixture = process.argv.find(arg => arg.startsWith("--xls-fixture="))?.slice(14);
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const binarySha256 = hash(binary);
const checks: { name: string; passed: boolean; detail?: unknown }[] = [];
const check = (name: string, passed: boolean, detail?: unknown) => { checks.push({ name, passed, detail }); if (!passed) throw new Error(name); };
const stage = await openStage(out);
const env = { ...process.env };
for (const key of ["WAYLAND_DISPLAY", "WAYLAND_SOCKET", "DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "DBUS_STARTER_ADDRESS", "DBUS_STARTER_BUS_TYPE", "GNOME_KEYRING_CONTROL", "GNOME_KEYRING_PID"]) delete env[key];
const profile = join(stage.root, "existing-user-data"), temp = join(stage.root, "cli-temp");
mkdirSync(profile); mkdirSync(temp); writeFileSync(join(profile, "sentinel.json"), '{"preserve":"기존 설정"}\n');
const sentinel = hash(join(profile, "sentinel.json"));
Object.assign(env, {
  GDK_BACKEND: "broadway", BROADWAY_DISPLAY: stage.display, XDG_RUNTIME_DIR: stage.runtimeDir,
  GTK_MODULES: join(stage.root, "libwb-dpi.so"), NO_AT_BRIDGE: "1",
  XDG_DATA_HOME: join(stage.root, "xdg-data"), XDG_CONFIG_HOME: join(stage.root, "xdg-config"), XDG_CACHE_HOME: join(stage.root, "xdg-cache"), TMPDIR: temp,
  WORKBENCH_DATA_DIR: profile, WORKBENCH_PORT: "1", WORKBENCH_EDITORS_PORT: "1", WORKBENCH_TOKEN: "must-not-be-used",
  WORKBENCH_IEUM_CLI: ieumCli ?? join(stage.root, "no-legacy-ieum"),
  GENOFFICE_APP_BIN: binary,
  WORKBENCH_CLI_TRACE_DIR: join(out, "native-export"),
  WORKBENCH_CODEX_BIN: join(repo, "scripts/fixtures/fake-codex.mjs"), WORKBENCH_CLAUDE_BIN: join(repo, "scripts/fixtures/fake-claude.mjs"),
});
mkdirSync(env.WORKBENCH_CLI_TRACE_DIR!, { recursive: true });
try {
  const dir = join(out, "documents"); mkdirSync(dir, { recursive: true });
  const zip = await JSZip.loadAsync(readFileSync(join(repo, "vendor/ieumoffice/fixtures/generated/simple.docx")));
  zip.file("word/document.xml", (await zip.file("word/document.xml")!.async("string")).replace("标题", "CLI 문서 출력").replace("第一段。", "NATIVE CLI DOCX 한글 본문").replace("第二段。", "원본 보존 확인"));
  writeFileSync(join(dir, "docx.docx"), await zip.generateAsync({ type: "nodebuffer" }));
  const docxXml = await zip.file("word/document.xml")!.async("string");
  for (const [name, breaks] of [["docx-2", 1], ["docx-blank", 2], ["docx-12", 11]] as const) {
    zip.file("word/document.xml", docxXml.replace('<w:p><w:r><w:t>원본 보존 확인', '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'.repeat(breaks) + '<w:p><w:r><w:t>원본 보존 확인'));
    writeFileSync(join(dir, `${name}.docx`), await zip.generateAsync({ type: "nodebuffer" }));
  }
  const sheet = await JSZip.loadAsync(readFileSync(join(repo, "vendor/ieumoffice/apps/shell/build/shell-new/blank.xlsx")));
  sheet.file("xl/styles.xml", (await sheet.file("xl/styles.xml")!.async("string")).replaceAll('val="Calibri"', 'val="Pretendard"'));
  sheet.file("xl/worksheets/sheet1.xml", (await sheet.file("xl/worksheets/sheet1.xml")!.async("string")).replace('<sheetData></sheetData>', '<cols><col min="1" max="1" width="70" customWidth="1"/></cols><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>NATIVE CLI XLSX 한글 본문</t></is></c></row></sheetData>'));
  writeFileSync(join(dir, "xlsx.xlsx"), await sheet.generateAsync({ type: "nodebuffer" }));
  writeFileSync(join(dir, "csv.csv"), "이름,번호\r\n가나다,0007\r\nCSV,42\r\n");
  writeFileSync(join(dir, "csv-legacy.csv"), Buffer.concat([Buffer.from("name,code\r\n"), Buffer.from([0xb0,0xa1,0xb3,0xaa,0xb4,0xd9]), Buffer.from(",0007\r\n")]));
  writeFileSync(join(dir, "xls-html.xls"), '<html><meta charset="utf-8"><table><tr><td colspan="2">성적표</td></tr><tr><td>가나다</td><td>95</td></tr></table></html>');
  if (xlsFixture) copyFileSync(xlsFixture, join(dir, "xls.xls"));
  copyFileSync(join(repo, "vendor/ieumoffice/packages/pptx-engine/tests/fixtures/05_unicode_cjk_emoji.pptx"), join(dir, "pptx.pptx"));
  writeFileSync(join(dir, "md.md"), "# CLI 문서 출력\n\nNATIVE CLI MARKDOWN 한글 본문\n");
  writeFileSync(join(dir, "html.html"), '<!doctype html><html><meta charset="utf-8"><style>body{font-family:sans-serif}h1{color:#176d88}</style><h1>CLI 문서 출력</h1><p>NATIVE CLI HTML 한글 본문</p></html>');
  writeFileSync(join(dir, "html-docx.html"), '<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif}table{border-collapse:collapse}td{border:1px solid #333;padding:8px}</style></head><body><h1>HTML 원본 변환</h1><p>NATIVE HTML DOCX 한글 본문</p><table><tr><td>이름</td><td>번호</td></tr><tr><td>가나다</td><td>0007</td></tr></table><p id="script"></p><canvas id="chart" width="240" height="80"></canvas><svg xmlns="http://www.w3.org/2000/svg" width="120" height="1600"><rect width="120" height="800" fill="#e03030"/><rect y="800" width="120" height="800" fill="#30b060"/></svg><script>document.getElementById("script").textContent="스크립트 생성 내용";const c=document.getElementById("chart").getContext("2d");c.fillStyle="#176d88";c.fillRect(0,0,240,80);</script></body></html>');
  writeFileSync(join(dir, "linked.css"), '#linked{color:#123456}');
  writeFileSync(join(dir, "linked.js"), 'document.getElementById("linked").textContent="외부 파일 내용";');
  writeFileSync(join(dir, "linked.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#0055ff"/></svg>');
  const htmlDocx = join(dir, "html-docx.html");
  writeFileSync(htmlDocx, readFileSync(htmlDocx, "utf8").replace("</head>", '<base href="./"><link rel="stylesheet" href="linked.css"><script defer src="linked.js"></script></head>').replace("</body>", '<p id="linked"></p><img src="linked.svg" width="40" height="40"></body>'));
  writeFileSync(htmlDocx, readFileSync(htmlDocx, "utf8").replace("</body>", '<p id="initial"></p><script>document.getElementById("initial").textContent="INITIAL VIEWPORT "+innerWidth+"x"+innerHeight;</script></body>'));
  for (const name of only) {
    const format = name.split("-")[0]!;
    const input = join(dir, name === "docx-html" ? "docx.docx" : `${name}.${format}`);
    const target = name === "docx-html" ? "html" : name === "html-docx" ? "docx" : "pdf", output = join(out, `${name}.${target}`), before = hash(input);
    let result: { stdout: string; stderr: string; code: number | string | undefined };
    const stdoutPath = join(out, `${name}.stdout.log`), stderrPath = join(out, `${name}.stderr.log`);
    writeFileSync(stdoutPath, ""); writeFileSync(stderrPath, "");
    const previousTraces = new Set(readdirSync(env.WORKBENCH_CLI_TRACE_DIR!));
    try {
      const command = cli ? [process.execPath, cli, "convert"] : [binary, "--headless-export"];
      const running = run("dbus-run-session", ["--config-file", join(stage.root, "bus.conf"), "--", ...command, input, "--to", target, "--out", output, "--json"], { env, encoding: "utf8", timeout: 190_000, maxBuffer: 4_000_000 });
      running.child.stdout?.on("data", chunk => appendFileSync(stdoutPath, chunk));
      running.child.stderr?.on("data", chunk => appendFileSync(stderrPath, chunk));
      const value = await running;
      result = { ...value, code: 0 };
    } catch (error) { const failed = error as { stdout?: string; stderr?: string; code?: number | string }; result = { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", code: failed.code }; }
    writeFileSync(stdoutPath, result.stdout); writeFileSync(stderrPath, result.stderr);
    const envelope = result.stdout.trim().split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).at(-1);
    check(`${name}: native JSON and exit`, result.code === 0 && envelope?.status === "ok" && existsSync(output), { code: result.code, envelope });
    const traces = readdirSync(env.WORKBENCH_CLI_TRACE_DIR!).filter(file => !previousTraces.has(file)).map(file => readFileSync(join(env.WORKBENCH_CLI_TRACE_DIR!, file), "utf8"));
    check(`${name}: renderer diagnostic IPC actually authorized`, traces.some(text => ["parent-script", "job-received", "document-opened", "editor-granted", "export-done"].every(stage => text.split("\n").includes(stage))));
    check(`${name}: source preserved`, hash(input) === before);
    check(`${name}: user data preserved`, readdirSync(profile).join() === "sentinel.json" && hash(join(profile, "sentinel.json")) === sentinel);
    check(`${name}: owned temporary profile removed`, !readdirSync(temp).some(name => name.startsWith("workbench-export-")));
    if (target === "pdf") {
      const textPath = join(out, `${name}.txt`); await run("pdftotext", [output, textPath]);
      const text = readFileSync(textPath, "utf8");
      const expectedText = format === "csv" ? ["가나다", "0007"] : name === "xls-html" ? ["성적표", "가나다", "95"] : name === "xls" ? ["sheetjs", "foo", "bar", "baz", "qux"] : [`NATIVE CLI ${format === "md" ? "MARKDOWN" : format.toUpperCase()}`];
      check(`${name}: real document text`, name === "pptx" ? text.trim().length > 10 : expectedText.every(value => text.includes(value)), text.slice(0, 400));
      const info = (await run("pdfinfo", [output])).stdout;
      const expectedPages = name === "docx-2" ? 2 : name === "docx-blank" ? 3 : name === "docx-12" ? 12 : 1;
      check(`${name}: original page count`, Number(info.match(/^Pages:\s+(\d+)/m)?.[1]) === expectedPages, info);
      if (name === "docx-blank") {
        const pages = text.split("\f");
        check(`${name}: intentional blank page retained`, pages[1]?.trim() === "" && pages[2]?.includes("원본 보존 확인"));
      }
      if (name === "docx-12") check(`${name}: original chunk merge and final page`, text.split("\f")[11]?.includes("원본 보존 확인") === true);
      if (format === "xlsx") check(`${name}: original bundled font embedded`, (await run("pdffonts", [output])).stdout.includes("Pretendard"));
      await run("pdftoppm", ["-f", "1", "-singlefile", "-scale-to", "1200", "-png", output, join(out, `${name}-page`)]);
    } else if (target === "docx") {
      const doc = await JSZip.loadAsync(readFileSync(output)), body = await doc.file("word/document.xml")!.async("string");
      check(`${name}: editable text and script-generated content`, ["NATIVE HTML DOCX", "한글 본문", "스크립트 생성 내용"].every(text => body.includes(text)), body.slice(0, 500));
      check(`${name}: native Word table`, body.includes("<w:tbl>") && body.includes("가나다") && body.includes("0007"));
      check(`${name}: authored scripts see the original viewport`, body.includes("INITIAL VIEWPORT 794x1123"));
      check(`${name}: relative script and stylesheet retained`, body.includes("외부 파일 내용") && body.includes('val="123456"'));
      const media = await Promise.all(Object.values(doc.files).filter(file => /^word\/media\/.*\.png$/.test(file.name)).map(async file => ({ name: file.name, bytes: await file.async("nodebuffer") })));
      check(`${name}: real graphics captured`, media.length >= 2, media.map(file => file.name));
      let tallHeight = 0, red = false, green = false, canvasColor = false, linkedImage = false;
      for (const file of media) {
        const png = PNG.sync.read(file.bytes); writeFileSync(join(out, file.name.split("/").at(-1)!), file.bytes);
        if (png.width === 240) {
          const pixel = (ratio: number) => [...png.data.subarray((Math.floor(png.height * ratio) * png.width + Math.floor(png.width / 2)) * 4, (Math.floor(png.height * ratio) * png.width + Math.floor(png.width / 2)) * 4 + 4)];
          for (const p of [pixel(0.1), pixel(0.9)]) {
            red ||= p[0]! > 180 && p[1]! < 100 && p[3] === 255;
            green ||= p[0]! < 100 && p[1]! > 120 && p[3] === 255;
          }
          tallHeight += png.height;
        } else if (png.width === 480 && png.height === 160) {
          const offset = (80 * png.width + 240) * 4;
          canvasColor = png.data[offset] === 23 && png.data[offset + 1] === 109 && png.data[offset + 2] === 136 && png.data[offset + 3] === 255;
        } else if (png.width === 80 && png.height === 80) {
          const offset = (40 * png.width + 40) * 4;
          linkedImage = png.data[offset] === 0 && png.data[offset + 1] === 85 && png.data[offset + 2] === 255 && png.data[offset + 3] === 255;
        }
      }
      check(`${name}: script-painted canvas pixels retained`, canvasColor);
      check(`${name}: relative image pixels retained`, linkedImage);
      check(`${name}: original graphic slices retain total height and both colors`, tallHeight === 3200 && red && green, { tallHeight, red, green });
    } else check(`${name}: standalone original HTML`, readFileSync(output, "utf8").includes("NATIVE CLI DOCX") && !readFileSync(output, "utf8").includes("blob:"));
    console.log(`${name}: passed`);
  }
} finally {
  await stage.close();
  writeFileSync(join(out, "verification.json"), JSON.stringify({ binary, binarySha256, cli, ieumCli, xlsFixture, xlsFixtureSha256: xlsFixture ? hash(xlsFixture) : undefined, checks }, null, 2));
}
