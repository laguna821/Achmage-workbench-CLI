import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { promisify } from "node:util";
import { buildDesktopHostFontCatalog, type LocalFontEntry } from "../../../third_party/hop/host-font-catalog.ts";
import { HttpError } from "./errors.ts";

const exec = promisify(execFile);
const MAX_FONT_BYTES = 64 * 1024 * 1024;
type Catalog = ReturnType<typeof buildDesktopHostFontCatalog> & { signatures: Map<string, string> };
let pending: Promise<Catalog> | null = null;
const signature = (path: string) => { const s = statSync(path); return `${s.size}:${s.mtimeMs}:${s.ctimeMs}`; };

async function entries(): Promise<LocalFontEntry[]> {
  const binary = process.env.WORKBENCH_APP_BIN;
  if (binary) {
    const result = await exec(binary, ["--office-font-catalog"], { windowsHide: true, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
    const list: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(list) || list.length > 100_000) throw new Error("설치된 글꼴 목록이 올바르지 않습니다.");
    return list as LocalFontEntry[];
  }
  // Source-only Linux development has no desktop process. Use the same OS font registry.
  if (process.platform !== "linux") throw new Error("데스크톱 앱에서 설치된 글꼴을 사용할 수 있습니다.");
  const result = await exec("fc-list", ["--format", "%{file}\\t%{index}\\t%{family}\\t%{postscriptname}\\t%{weight}\\t%{slant}\\n"], { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
  const weights = [[0,100],[40,200],[50,300],[80,400],[100,500],[180,600],[200,700],[205,800],[210,900]];
  return result.stdout.split("\n").flatMap(line => {
    const [path, index, families, ps, rawWeight, slant] = line.split("\t");
    if (!path || !families) return [];
    const weight = weights.reduce((a,b) => Math.abs(b[0]! - Number(rawWeight)) < Math.abs(a[0]! - Number(rawWeight)) ? b : a)[1]!;
    return families.split(",").map(family => ({ family, path, postScriptName: ps ?? "", weight, style: Number(slant) === 100 ? "italic" : Number(slant) === 110 ? "oblique" : "normal", sourceKind: "system-installed" as const, faceIndex: Number(index) & 0xffff }));
  });
}

async function catalog() {
  if (!pending) pending = entries().then(list => {
    const value = buildDesktopHostFontCatalog(list);
    const signatures = new Map<string, string>();
    for (const [id, source] of value.sources) {
      try { signatures.set(id, signature(source.path)); } catch { value.sources.delete(id); }
    }
    const faces = value.snapshot.faces.filter(face => signatures.has(face.id)).slice(0, 25_000);
    const revision = createHash("sha256").update(JSON.stringify([value.snapshot.revision, [...signatures]])).digest("hex");
    return { ...value, snapshot: { revision, faces }, signatures };
  }).catch(error => { pending = null; throw error; });
  return pending;
}

export async function hwpFontSnapshot() { return (await catalog()).snapshot; }
export async function hwpFontFace(id: string, revision: string) {
  const value = await catalog(), source = value.snapshot.revision === revision ? value.sources.get(id) : undefined;
  if (!source || !value.snapshot.faces.some(face => face.id === id)) throw new HttpError(404, "font_not_found", "글꼴 목록이 바뀌었습니다.");
  if (signature(source.path) !== value.signatures.get(id)) {
    pending = null; throw new HttpError(409, "font_changed", "설치된 글꼴이 바뀌었습니다. 문서를 다시 열어 주세요.");
  }
  const size = statSync(source.path).size;
  if (size > MAX_FONT_BYTES) throw new HttpError(413, "font_too_large", "글꼴 파일이 너무 큽니다.");
  const bytes = readFileSync(source.path);
  if (bytes.length !== size || signature(source.path) !== value.signatures.get(id)) {
    pending = null; throw new HttpError(409, "font_changed", "글꼴을 읽는 동안 파일이 바뀌었습니다.");
  }
  return { bytes, faceIndex: source.faceIndex };
}
