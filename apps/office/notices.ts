import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";

// THIRD-PARTY-NOTICES.txt next to the office pages: IeumOffice's LICENSE and NOTICE (Apache-2.0
// asks that they travel with the work), the licences of the fonts and data it bundles, and the
// licence of every npm package that has code in the built pages (taken from the bundle itself).

type Section = { title: string; files: string[] };

/** The package directory a bundled module belongs to (…/node_modules/<name> or …/node_modules/@scope/<name>). */
function packageRoot(id: string) {
  const path = id.replace(/^\0/, "").replace(/\?.*$/, "");
  const at = path.lastIndexOf("/node_modules/");
  if (at === -1) return null;
  const rest = path.slice(at + "/node_modules/".length).split("/");
  const depth = rest[0]?.startsWith("@") ? 2 : 1;
  if (rest.length <= depth) return null;
  return path.slice(0, at + "/node_modules/".length) + rest.slice(0, depth).join("/");
}

function licenceText(root: string) {
  const file = readdirSync(root).find((name) => /^(licen[cs]e|copying)(\.|-|$)/i.test(name));
  return file ? readFileSync(join(root, file), "utf8").trim() : null;
}

/** Packages found in bundles built so far (workers are built before the pages that start them). */
const packages = new Map<string, { name: string; version: string; license: string; text: string | null }>();

function record(bundle: Record<string, { type: string; modules?: Record<string, unknown> }>) {
  for (const output of Object.values(bundle)) {
    if (output.type !== "chunk") continue;
    for (const id of Object.keys(output.modules ?? {})) {
      const root = packageRoot(id);
      if (!root || packages.has(root) || !existsSync(join(root, "package.json"))) continue;
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: string; version?: string; license?: string | { type?: string } };
      const license = typeof manifest.license === "string" ? manifest.license : (manifest.license?.type ?? "see the package");
      packages.set(root, { name: manifest.name ?? root, version: manifest.version ?? "", license, text: licenceText(root) });
    }
  }
}

/** For worker builds: their packages go into the pages' notices. */
export function collectModules(): Plugin {
  return {
    name: "workbench-third-party-modules",
    apply: "build",
    generateBundle(_, bundle) {
      record(bundle as Parameters<typeof record>[0]);
    },
  };
}

export function thirdPartyNotices(sections: Section[]): Plugin {
  return {
    name: "workbench-third-party-notices",
    apply: "build",
    generateBundle(_, bundle) {
      record(bundle as Parameters<typeof record>[0]);
      const rule = "=".repeat(78);
      const parts = [
        "Achmage Workbench office editors — third-party notices",
        "",
        "The pages in this folder are built from IeumOffice (https://github.com/pblsketch/openoffice,",
        "based on GenOffice) and the npm packages listed below. Workbench adds a bridge to its own",
        "gateway and hides the editors' AI features; IeumOffice's source is used unchanged.",
      ];
      for (const section of sections) {
        parts.push("", rule, section.title, rule);
        for (const file of section.files) if (existsSync(file)) parts.push("", readFileSync(file, "utf8").trim());
      }
      const sorted = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
      parts.push("", rule, `npm packages with code in these pages (${sorted.length})`, rule);
      for (const entry of sorted) {
        parts.push("", `${entry.name}@${entry.version} — ${entry.license}`, "-".repeat(78), entry.text ?? "(no licence file in the package; licence as declared above)");
      }
      this.emitFile({ type: "asset", fileName: "THIRD-PARTY-NOTICES.txt", source: `${parts.join("\n")}\n` });
    },
  };
}
