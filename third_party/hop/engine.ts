// The ONE Hangul engine of Workbench. The gateway (codec, save fingerprint, census, CLI, previews,
// new documents, Ieum's text reader) imports it from here, and the studio build
// (scripts/build-hwp-studio.mjs) builds the studio around the folder named here — so the gateway
// and the studio cannot run different engines (apps/host/src/hwp-engine-one.test.ts fails if anything
// imports an engine folder directly, or if the built studio's WASM is not this engine's).
//
// Way back to the shipped rhwp 0.8.7 engine (kept untouched in ./rhwp-core until the release is
// out): in this file, replace "rhwp-core-0.9.0" with "rhwp-core" (every line below names the same
// folder; the test checks they agree), then rebuild ALL THREE builds that carry the engine: the
// studio (`node scripts/build-hwp-studio.mjs`), the gateway bundles (`npm run build -w @workbench/host`:
// host.mjs, hwp-cli.mjs and hangul-picture-job.mjs embed the engine's glue) and the office build
// (`npm run build -w @workbench/office`, which copies the studio into apps/web/dist/office/studio).
// The 0.8.7 studio rebuild is offline only while its build cache exists; without it the builder
// clones the studio from GitHub (HWP_STUDIO_FROM is honoured for v0.9.0 only).
export * from "./rhwp-core-0.9.0/rhwp.js";
export { default } from "./rhwp-core-0.9.0/rhwp.js";
export { default as enginePackage } from "./rhwp-core-0.9.0/package.json" with { type: "json" };
/** The engine's folder, relative to the repository root (its rhwp_bg.wasm, rhwp.js, package.json). */
export const ENGINE_DIR = "third_party/hop/rhwp-core-0.9.0";
