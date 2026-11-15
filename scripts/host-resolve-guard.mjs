// The host bundles' banners (scripts/build-host.mjs; tested in apps/host/src/host-resolve-guard.test.ts).

/** Every bundle: a CommonJS `require` for the bundled packages that call it. */
export const REQUIRE_BANNER = "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);";

/**
 * The guard (sec-vault round 2): a package Node would find by walking up from the install
 * (~/node_modules, ~/.local/node_modules …: folders any program of the person can write) is never
 * loaded into the gateway, where the vault's ticket and key live. Only files under the install's
 * own folder load; `ws`, `debug` and pdf.js treat the refusal as "optional package not present".
 */
export const RESOLVE_GUARD_BANNER = "import{registerHooks as __rh}from'module';import{fileURLToPath as __fu}from'url';import{dirname as __dn,sep as __sep}from'path';{const __in=__dn(__dn(__fu(import.meta.url)))+__sep;if(typeof __rh==='function')__rh({resolve(s,c,n){const f=n(s,c);if(f&&typeof f.url==='string'&&f.url.startsWith('file:')&&!__fu(f.url).startsWith(__in))throw Object.assign(new Error(`Cannot find module '${s}'`),{code:'MODULE_NOT_FOUND'});return f;}});}" + REQUIRE_BANNER;

/**
 * The bundles that hold the vault's per-run ticket or can obtain it: only the gateway (host.mjs) — the
 * ticket lives in its memory and in the helper's stdin pipe (ux/reports/sec-vault-round2-report.md).
 * The job bundles never hold it, and the on-device voice worker must load its runtime from
 * `<data>/voice/runtime-*\/node_modules`, outside the install (check F2): they are built without the guard.
 */
export const TICKET_HOLDERS = ["host"];
