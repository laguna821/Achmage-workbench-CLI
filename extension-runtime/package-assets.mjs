import { cp, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
/** Matching build-host externals. Keep module-relative WASM and esbuild binary paths intact. */
export const extensionRuntimeExternals = ["quickjs-emscripten-core", "@jitl/quickjs-wasmfile-release-sync", "typescript", "esbuild"];

export async function copyExtensionRuntimeAssets(outputDirectory) {
  const output = resolve(root, outputDirectory);
  await mkdir(join(output, "extensions"), { recursive: true });
  await cp(join(root, "vendor/paseo/plugin-host/dist/guest-sdk.js"), join(output, "extensions/guest-sdk.js"));
  await cp(join(root, "third_party/extensions"), join(output, "extensions/licenses"), { recursive: true });
  const visited = new Set();
  const copyPackage = async (name) => {
    if (visited.has(name)) return; visited.add(name);
    // Some packages do not export package.json, so find their own manifest from the real entry.
    let directory = dirname(require.resolve(name));
    for (;;) {
      try {
        const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
        if (metadata.name === name) {
          await cp(directory, join(output, "node_modules", ...name.split("/")), { recursive: true, dereference: true });
          for (const dependency of Object.keys(metadata.dependencies ?? {})) await copyPackage(dependency);
          return;
        }
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      const parent = dirname(directory); if (parent === directory) throw new Error(`Package manifest not found for ${name}`); directory = parent;
    }
  };
  for (const name of extensionRuntimeExternals) await copyPackage(name);
  // esbuild's optional platform binary is installed for this build host, not downloaded at runtime.
  const esbuildDirectory = dirname(require.resolve("esbuild/package.json"));
  const metadata = JSON.parse(await readFile(join(esbuildDirectory, "package.json"), "utf8"));
  const binaryPackage = `@esbuild/${process.platform}-${process.arch}`;
  if (!metadata.optionalDependencies?.[binaryPackage]) throw new Error(`Unsupported esbuild target ${process.platform}/${process.arch}`);
  // Binary-only packages may have no JS entry.
  const binaryDirectory = dirname(require.resolve(`${binaryPackage}/package.json`));
  await cp(binaryDirectory, join(output, "node_modules", "@esbuild", `${process.platform}-${process.arch}`), { recursive: true, dereference: true });
}
