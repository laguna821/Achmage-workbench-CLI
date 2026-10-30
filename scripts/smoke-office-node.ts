// Real pinned Ieum CLI, synthetic files and private state; no provider/network requests.
// Usage: node scripts/smoke-office-node.ts <new evidence dir> <xlsx-sidecar path>
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { IeumOffice } from "../apps/host/src/ieumoffice.ts";

const root = resolve(process.argv[2] ?? "");
assert(process.argv[2] && !existsSync(root), "Supply a new dedicated evidence directory");
mkdirSync(root, { recursive: true });
const allowed = join(root, "allowed"); mkdirSync(allowed);
process.env.GENOFFICE_HOME = join(root, "cli-home");
process.env.GENOFFICE_USER_DATA = join(root, "user-data");
process.env.GENOFFICE_AUDIT_LOG = "off";
process.env.ELECTRON_RUN_AS_NODE = "1"; // Must be removed by the Workbench command bridge.
if (process.argv[3]) process.env.XLSX_SIDECAR_PATH = resolve(process.argv[3]);
const script = resolve("vendor/ieumoffice/packages/cli/dist/genoffice.cjs");
assert(existsSync(script), "Build the pinned CLI before this check");
const invoked = join(root, "legacy-app-was-invoked.txt"), app = join(root, "forbidden-electron-app");
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
assert(process.platform !== "win32", "This process sentinel uses a POSIX shell; Windows packaging verification is separate");
writeFileSync(app, `#!/bin/sh\nprintf 'legacy-export' > ${quote(invoked)}\nexit 99\n`, { mode: 0o755 });
const office = new IeumOffice({ script, app, launcher: script, bundled: false });
const checks: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: unknown) => { assert(ok, name); checks.push({ name, ok: true }); console.log(`PASS ${name}`); };
const run = (args: string[]) => office.run(args, [allowed]);
const md = join(allowed, "source.md"), docx = join(allowed, "document.docx");
writeFileSync(md, "# NODE DOCUMENT\n\nOriginal paragraph.\n");
check("CLI version on shared Node", await office.version() === "0.12.7");
await run(["create", "--type", "docx", "--from", md, "--out", docx]);
check("DOCX creation and text extraction", (await office.textView(docx, "docx")).includes("NODE DOCUMENT"));
const ops = join(allowed, "ops.json");
writeFileSync(ops, JSON.stringify([{ op: "insert_content", afterBlockIndex: 0, html: "<p>EDITED BY NODE</p>" }]));
await run(["docs", "apply", docx, "--ops", ops]);
check("Original DOCX edit operations and reread", (await office.textView(docx, "docx")).includes("EDITED BY NODE"));
const spec = join(allowed, "deck.json"), pptx = join(allowed, "deck.pptx");
writeFileSync(spec, JSON.stringify({ pages: [{ background: "#ffffff", elements: [{ type: "text", x: 80, y: 100, w: 900, h: 80, paragraphs: [{ runs: [{ text: "NODE SLIDES", sizePt: 32, color: "#112233" }] }] }] }] }));
await run(["create", "--type", "pptx", "--spec", spec, "--out", pptx]);
check("PPTX creation and full slide text", (await office.textView(pptx, "pptx")).includes("NODE SLIDES"));
const table = join(allowed, "table.json"), xlsx = join(allowed, "book.xlsx");
writeFileSync(table, JSON.stringify([["item", "qty"], ["Apple", 2], ["Pear", 3], ["Total", "=SUM(B2:B3)"]]));
await run(["create", "--type", "xlsx", "--from", table, "--out", xlsx]);
const sheet = await run(["sheet", "read", xlsx]);
check("XLSX creation and native formula calculation", JSON.stringify(sheet.detail).includes('"Total",5'));
check("Workbook text view", (await office.textView(xlsx, "xlsx")).includes("Apple"));
const forbidden = join(root, "outside.docx");
await assert.rejects(() => run(["create", "--type", "docx", "--from", md, "--out", forbidden]));
check("Allowed-root enforcement without output mutation", !existsSync(forbidden));
check("No Electron app launched for document commands", !existsSync(invoked));
// This dependency is deliberately still visible until native layout/export replaces it.
await assert.rejects(() => office.render(docx, join(allowed, "render")));
check("Remaining legacy render dependency is explicit", existsSync(invoked));
writeFileSync(join(root, "results.json"), JSON.stringify({ runtime: process.execPath, node: process.version, cliSha256: createHash("sha256").update(readFileSync(script)).digest("hex"), checks, remaining: ["Native layout/export replacement", "sealed-secret/control paths", "Electron payload removal", "Windows/macOS/Node24 verification"] }, null, 2) + "\n");
