import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import JSZip from "jszip";
import { afterEach, expect, it, vi } from "vitest";
import { IeumOffice } from "./ieumoffice.ts";
import { OfficeCliInput } from "./office-cli-input.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(name: string, bytes: Uint8Array | string) {
  const root = mkdtempSync(join(tmpdir(), "wb-cli-input-")); roots.push(root);
  const path = join(root, name); writeFileSync(path, bytes);
  return { root, path, original: readFileSync(path), ieum: new IeumOffice(null) };
}

it("imports a Korean Excel CSV once, retaining leading zeros, source bytes and the source's file type", async () => {
  const f = fixture("성적.csv", Buffer.concat([Buffer.from("이름,번호\r\n"), Buffer.from("가나다,0007\r\n")]));
  const input = new OfficeCliInput(f.path, f.root, f.ieum);
  const [a, b] = await Promise.all([input.prepare(), input.prepare()]);
  expect(a.path).toBe(b.path); expect(dirname(a.path)).not.toBe(f.root);
  const zip = await JSZip.loadAsync(readFileSync(a.path));
  const xml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
  expect(xml).toContain("가나다"); expect(xml).toContain("0007");
  expect(xml).not.toContain("<v>7</v>"); expect(readFileSync(f.path)).toEqual(f.original);
});

it("uses the original EUC-KR CSV decoder", async () => {
  const f = fixture("legacy.csv", Buffer.concat([Buffer.from("name,code\n"), Buffer.from([0xb0,0xa1,0xb3,0xaa,0xb4,0xd9]), Buffer.from(",0007\n")]));
  const out = await new OfficeCliInput(f.path, f.root, f.ieum).prepare();
  const zip = await JSZip.loadAsync(readFileSync(out.path));
  expect(await zip.file("xl/worksheets/sheet1.xml")!.async("string")).toContain("가나다");
  expect(readFileSync(f.path)).toEqual(f.original);
});

it("imports HTML named .xls with original merged cells and Korean values", async () => {
  const f = fixture("기관.xls", '<html><meta charset="utf-8"><table><tr><td colspan="2">성적표</td></tr><tr><td>가나다</td><td>95</td></tr></table></html>');
  const run = vi.spyOn(f.ieum, "run");
  const out = await new OfficeCliInput(f.path, f.root, f.ieum).prepare();
  const zip = await JSZip.loadAsync(readFileSync(out.path));
  const xml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
  expect(xml).toContain('<mergeCell ref="A1:B1"/>'); expect(xml).toContain("가나다"); expect(xml).toContain("<v>95</v>");
  expect(run).not.toHaveBeenCalled(); expect(readFileSync(f.path)).toEqual(f.original);
});

it("rejects an HTML .xls without a table and keeps the source", async () => {
  const f = fixture("empty.xls", "<html><p>표 없는 원본</p></html>");
  await expect(new OfficeCliInput(f.path, f.root, f.ieum).prepare()).rejects.toThrow("표가 없습니다");
  expect(readFileSync(f.path)).toEqual(f.original);
});
