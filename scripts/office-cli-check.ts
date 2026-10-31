import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import { openStage } from "./app-e2e/launch.ts";

const run = promisify(execFile), repo = resolve(import.meta.dirname, "..");
const out = resolve(process.argv[2] ?? "/tmp/workbench-cli-check"); mkdirSync(out, { recursive: true });
const only = process.argv.find(arg => arg.startsWith("--only="))?.slice(7).split(",") ?? ["docx", "docx-2", "docx-blank", "docx-12", "pptx", "xlsx", "csv", "csv-legacy", "xls-html", "md", "html", "docx-html"];
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
  WORKBENCH_CODEX_BIN: join(repo, "scripts/fixtures/fake-codex.mjs"), WORKBENCH_CLAUDE_BIN: join(repo, "scripts/fixtures/fake-claude.mjs"),
});
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
  for (const name of only) {
    const format = name.split("-")[0]!;
    const input = join(dir, name === "docx-html" ? "docx.docx" : `${name}.${format}`);
    const target = name === "docx-html" ? "html" : "pdf", output = join(out, `${name}.${target}`), before = hash(input);
    let result: { stdout: string; stderr: string; code: number | string | undefined };
    const stdoutPath = join(out, `${name}.stdout.log`), stderrPath = join(out, `${name}.stderr.log`);
    writeFileSync(stdoutPath, ""); writeFileSync(stderrPath, "");
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
    } else check(`${name}: standalone original HTML`, readFileSync(output, "utf8").includes("NATIVE CLI DOCX") && !readFileSync(output, "utf8").includes("blob:"));
    console.log(`${name}: passed`);
  }
} finally {
  await stage.close();
  writeFileSync(join(out, "verification.json"), JSON.stringify({ binary, binarySha256, cli, ieumCli, xlsFixture, xlsFixtureSha256: xlsFixture ? hash(xlsFixture) : undefined, checks }, null, 2));
}
