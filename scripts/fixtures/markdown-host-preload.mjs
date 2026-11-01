// Only the dedicated native-test gateway redirects the three upload transports.
// Product code and bundles have no fixture switch; public account traffic is never sent.
const relay = process.env.APP_E2E_MARKDOWN_RELAY;
if (relay && /[/\\]host[/\\]host\.mjs$/.test(process.argv[1] ?? "")) {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    const address = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const kind = address.hostname === "markdown-s3.example.invalid" ? "s3" : address.hostname === "smms.app" && address.pathname === "/api/v2/upload" ? "smms" : address.hostname === "api.github.com" && address.pathname.startsWith("/repos/markdown-fixture/") ? "github" : null;
    return nativeFetch(kind ? `${relay}/upload/${kind}${address.pathname}` : input, options);
  };
}
