import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

// 설정 › 정보 › 오픈소스 라이선스: the list is generated at build time from the notices the repository
// already ships (third_party/*, vendor/*, the bundled fonts and the vendored UI kits) — one entry per
// component folder, its licence named from the licence text itself, and the text served beside the
// app as licences/<name>.txt. Nothing here is typed by hand: a component folder without a LICENSE /
// NOTICE / licenses folder FAILS the build (a folder of components, like third_party/skills, lists each
// component inside it), and a text the matcher does not know is listed as "고지문". The order is by
// code point, the same on every build machine. The office editors' own notices (their bundle's
// THIRD-PARTY-NOTICES.txt, apps/office/notices.ts) are one more entry, read from that bundle.

export type LicenceEntry = { name: string; licences: string[]; files: string[]; attribution?: string; href?: string };

/** Code-point order: the same everywhere (localeCompare depends on the build machine's ICU locale). */
const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The office editors' bundle writes its own notices beside its pages (apps/office/notices.ts). */
export const OFFICE_NOTICES: LicenceEntry = { name: "이음오피스 편집기의 구성 요소", licences: [], files: [], href: "office/THIRD-PARTY-NOTICES.txt" };

/** The folders whose notices travel with the app (relative to the repository root). */
const PARENTS = ["third_party", "vendor", "apps/web/public/fonts", "apps/web/src/vendor"];
/** LICENSE, NOTICE.md, LICENSE-smoothui, Paseo.LICENSE, uuid-9.0.1-LICENSE.md … (not manifests: .json). */
const NOTICE_FILE = /(^|[-._])(licen[cs]e|copying|notice)([-._][^/]*)?$/i;

/** The licence a text grants, from its own words (the most specific first). */
const KNOWN: [RegExp, string][] = [
  [/Attribution Assurance License/i, "Attribution Assurance License"],
  [/^\s*GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3/m, "AGPL-3.0"],
  // Before the GPL: the MPL names the GPL among its secondary licences.
  [/Mozilla Public License,? Version 2\.0/i, "MPL-2.0"],
  [/^\s*GNU LESSER GENERAL PUBLIC LICENSE/m, "LGPL"],
  [/^\s*GNU GENERAL PUBLIC LICENSE/m, "GPL"],
  [/Apache License,?\s+Version 2\.0/i, "Apache-2.0"],
  [/SIL OPEN FONT LICENSE/i, "OFL-1.1"],
  [/UNICODE LICENSE|Unicode, Inc\. License|UNICODE, INC\. LICENSE/i, "Unicode"],
  [/^\s*ISC License|Permission to use, copy, modify, and\/or distribute this software for any/im, "ISC"],
  [/^\s*MIT License|Permission is hereby granted, free of charge, to any person obtaining a copy/im, "MIT"],
  [/BSD 3-Clause|Neither the name of .* nor the names of its\s+contributors/i, "BSD-3-Clause"],
  [/Redistribution and use in source and binary forms/i, "BSD"],
];

export function licenceOf(text: string) {
  return KNOWN.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

/** Attribution a licence asks the program to display (the Attribution Assurance License, clause 2: name, identification, URL). */
export function attributionOf(text: string) {
  const name = /\(a\)\s*Name\s*\("([^"]+)"\)/.exec(text)?.[1];
  const role = /\(b\)\s*Professional identification\s*\("([^"]+)"\)/.exec(text)?.[1];
  const url = /\(c\)\s*URL\s*\("([^"]+)"\)/.exec(text)?.[1];
  return name && role && url ? { name, role, url } : null;
}

/** Every file under a licenses folder (one folder per package is common), in name order. */
function everyFile(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => byCodePoint(a.name, b.name))
    .flatMap((entry) => entry.isDirectory() ? everyFile(join(dir, entry.name)) : entry.isFile() ? [join(dir, entry.name)] : []);
}

function noticeFiles(dir: string) {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => byCodePoint(a.name, b.name))) {
    const path = join(dir, entry.name);
    if (entry.isFile() && NOTICE_FILE.test(entry.name) && !/\.json$/i.test(entry.name)) out.push(path);
    else if (entry.isDirectory() && /^licen[cs]es$/i.test(entry.name)) out.push(...everyFile(path));
  }
  return out;
}

/** One entry per component name (vendor/paseo and third_party/paseo are one component), identical files once. */
export function collectLicences(root: string) {
  const byName = new Map<string, { files: string[]; texts: Map<string, string> }>();
  for (const parent of PARENTS) {
    const at = join(root, parent);
    if (!existsSync(at)) continue;
    // A folder with no notice of its own but components inside it (third_party/skills/<skill>) is a group.
    const components = readdirSync(at).sort(byCodePoint).filter((name) => !name.startsWith(".") && statSync(join(at, name)).isDirectory()).flatMap((name) => {
      const dir = join(at, name);
      if (noticeFiles(dir).length) return [{ name, dir }];
      const inner = readdirSync(dir).sort(byCodePoint).filter((child) => !child.startsWith(".") && statSync(join(dir, child)).isDirectory() && noticeFiles(join(dir, child)).length);
      if (!inner.length) throw new Error(`${parent}/${name}: no LICENSE, NOTICE or licenses folder. Every component the app ships names its licence (apps/web/licences.ts).`);
      return inner.map((child) => ({ name: child, dir: join(dir, child) }));
    });
    for (const { name, dir } of components) {
      const files = noticeFiles(dir);
      const slot = byName.get(name) ?? { files: [], texts: new Map<string, string>() };
      for (const file of files) {
        const text = readFileSync(file, "utf8").trim();
        if (!text || [...slot.texts.values()].includes(text)) continue;
        const rel = relative(root, file).split("\\").join("/");
        slot.files.push(rel);
        slot.texts.set(rel, text);
      }
      byName.set(name, slot);
    }
  }
  const entries: (LicenceEntry & { text: string })[] = [];
  for (const [name, slot] of [...byName].sort(([a], [b]) => byCodePoint(a, b))) {
    if (!slot.files.length) continue;
    const texts = [...slot.texts.values()];
    const licences = [...new Set(texts.map(licenceOf).filter((value): value is string => Boolean(value)))];
    const credit = texts.map(attributionOf).find(Boolean);
    const rule = "=".repeat(78);
    const text = slot.files.map((file) => `${rule}\n${file}\n${rule}\n\n${slot.texts.get(file)}\n`).join("\n");
    entries.push({ name, licences, files: slot.files, ...(credit ? { attribution: `${credit.name}, ${credit.role}, ${credit.url}` } : {}), text });
  }
  return [...entries, { ...OFFICE_NOTICES, text: "" }];
}

/** licences/index.json (names, licences, attribution) and licences/<name>.txt (the texts) beside the app. */
export function licences(root = fileURLToPath(new URL("../..", import.meta.url))): Plugin {
  const index = () => collectLicences(root);
  return {
    name: "workbench-licences",
    configureServer(server) {
      server.middlewares.use("/licences/", (req, res, next) => {
        const entries = index();
        const path = decodeURIComponent((req.url ?? "").replace(/^\//, "").split("?")[0] ?? "");
        if (path === "index.json") { res.setHeader("content-type", "application/json; charset=utf-8"); res.end(JSON.stringify(entries.map(({ text: _text, ...entry }) => entry))); return; }
        const found = entries.find((entry) => `${entry.name}.txt` === path);
        if (!found) return next();
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end(found.text);
      });
    },
    generateBundle() {
      const entries = index();
      this.emitFile({ type: "asset", fileName: "licences/index.json", source: JSON.stringify(entries.map(({ text: _text, ...entry }) => entry)) });
      for (const entry of entries) if (!entry.href) this.emitFile({ type: "asset", fileName: `licences/${entry.name}.txt`, source: entry.text });
    },
  };
}
