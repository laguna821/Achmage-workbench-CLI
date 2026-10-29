// The apps an installer ships for the document features (packaging/bundled-apps.json): for each,
// the official release asset for this OS, checked against its pinned hash, unpacked into
// <out>/<app> without running the app. Used by release.yml before `tauri build`.
//   appimage     the AppImage's own extractor (it only unpacks)
//   nsis-app-7z  7-Zip opens an electron-builder installer and its app-64.7z
//   nsis-files   7-Zip opens a Tauri NSIS installer (its files are stored as they install)
//   app-zip      ditto keeps a macOS app's links and signature
//   archive-strip a .tar.gz or .zip whose one top folder is dropped
//   deb          the package's data (usr/…)
// Usage: node scripts/fetch-bundled-apps.ts <out> [platform-arch] [app…]

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Asset = { file: string; sha256?: string; sha512?: string; unpack: string; check: string };
type App = { name: string; repository: string; tag: string; license: string; use: string; assets: Record<string, Asset> };

const out = resolve(process.argv[2] ?? "apps/desktop/src-tauri/bundled");
const target = process.argv[3] ?? `${process.platform}-${process.arch}`;
const manifest = JSON.parse(readFileSync(new URL("../packaging/bundled-apps.json", import.meta.url), "utf8")) as Record<string, App | string>;
const wanted = process.argv.slice(4);
const apps = Object.entries(manifest).filter((entry): entry is [string, App] => typeof entry[1] === "object" && (!wanted.length || wanted.includes(entry[0])));

const run = (command: string, args: string[], cwd: string) => execFileSync(command, args, { cwd, stdio: ["ignore", "ignore", "inherit"] });

function sevenZip() {
  for (const candidate of ["7z", "C:\\Program Files\\7-Zip\\7z.exe", "7zz"]) {
    try {
      execFileSync(candidate, ["i"], { stdio: "ignore" });
      return candidate;
    } catch {
      // Not this one.
    }
  }
  throw new Error("7-Zip is needed to open Windows installers");
}

/** Unpack a .tar.gz or .zip into `into` with the tools each OS has. */
function extract(file: string, into: string) {
  mkdirSync(into, { recursive: true });
  if (/\.(tar\.gz|tgz)$/i.test(file)) run("tar", ["-xzf", file, "-C", into], into);
  else if (process.platform === "darwin") run("ditto", ["-x", "-k", file, into], into);
  else if (process.platform === "win32") run("tar", ["-xf", file, "-C", into], into);
  else run("unzip", ["-q", file, "-d", into], into);
}

/** Move the contents of `from` into `to` (same disk), replacing it. */
function moveInto(from: string, to: string) {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) renameSync(join(from, name), join(to, name));
}

for (const [id, app] of apps) {
  const asset = app.assets[target];
  if (!asset) {
    console.log(`${app.name}: no official build for ${target}; not shipped on this OS`);
    continue;
  }
  const dest = join(out, id);
  // Next to the result, so the final moves are renames on one disk.
  mkdirSync(out, { recursive: true });
  const work = mkdtempSync(join(out, `.work-${id}-`));
  const file = join(work, asset.file);
  const url = `https://github.com/${app.repository}/releases/download/${app.tag}/${asset.file}`;
  console.log(`${app.name} ${app.tag} for ${target}: ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const algorithm = asset.sha512 ? "sha512" : "sha256";
  const actual = createHash(algorithm).update(bytes).digest(algorithm === "sha512" ? "base64" : "hex");
  if (actual !== (asset.sha512 ?? asset.sha256)) throw new Error(`${algorithm} mismatch for ${asset.file}: ${actual}`);
  writeFileSync(file, bytes);
  console.log(`  checked ${algorithm} (${Math.round(bytes.length / 1_048_576)} MB)`);

  const staging = join(work, "unpacked");
  mkdirSync(staging, { recursive: true });
  switch (asset.unpack) {
    case "appimage": {
      chmodSync(file, 0o755);
      run(file, ["--appimage-extract"], work);
      const root = join(work, "squashfs-root");
      // Links at the top (icons) are not needed; installers copy links as files or not at all.
      for (const name of readdirSync(root)) if (name === ".DirIcon" || name.endsWith(".png")) rmSync(join(root, name), { force: true });
      moveInto(root, staging);
      break;
    }
    case "nsis-app-7z": {
      const tool = sevenZip();
      run(tool, ["x", "-y", `-o${join(work, "installer")}`, file, "$PLUGINSDIR/app-64.7z"], work);
      run(tool, ["x", "-y", `-o${staging}`, join(work, "installer", "$PLUGINSDIR", "app-64.7z")], work);
      break;
    }
    case "nsis-files": {
      run(sevenZip(), ["x", "-y", `-o${staging}`, file], work);
      // The installer's own plug-ins and uninstaller are not the app.
      for (const name of readdirSync(staging)) if (name.startsWith("$")) rmSync(join(staging, name), { recursive: true, force: true });
      break;
    }
    case "app-zip": {
      const unpacked = join(work, "zip");
      extract(file, unpacked);
      const bundle = readdirSync(unpacked).find((name) => name.endsWith(".app"));
      if (!bundle) throw new Error(`${asset.file} has no .app inside`);
      if (process.platform === "darwin") run("ditto", [join(unpacked, bundle), join(staging, bundle)], work);
      else cpSync(join(unpacked, bundle), join(staging, bundle), { recursive: true, verbatimSymlinks: true });
      break;
    }
    case "archive-strip": {
      const unpacked = join(work, "archive");
      extract(file, unpacked);
      const top = readdirSync(unpacked);
      moveInto(top.length === 1 ? join(unpacked, top[0]!) : unpacked, staging);
      break;
    }
    case "deb": {
      const deb = join(work, "deb");
      mkdirSync(deb, { recursive: true });
      run("ar", ["x", file], deb);
      const data = readdirSync(deb).find((name) => name.startsWith("data.tar"));
      if (!data) throw new Error(`${asset.file} has no data archive`);
      run("tar", ["-xf", join(deb, data), "-C", staging], deb);
      break;
    }
    default:
      throw new Error(`Unknown unpack kind ${asset.unpack}`);
  }
  if (!existsSync(join(staging, asset.check))) throw new Error(`${app.name}: the unpacked app has no ${asset.check}`);
  writeFileSync(
    join(staging, "WORKBENCH-BUNDLE.json"),
    JSON.stringify({ app: id, name: app.name, version: app.tag.replace(/^(achmage-)?v/, ""), repository: `https://github.com/${app.repository}`, file: asset.file, [algorithm]: actual, license: app.license }, null, 2),
  );
  moveInto(staging, dest);
  rmSync(work, { recursive: true, force: true });
  console.log(`  unpacked into ${dest}`);
}
