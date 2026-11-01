import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { googleDriveFixture } from "./google-drive.mjs";

// Only the dedicated fixture gateway is intercepted. Never enabled by product code.
const root = process.env.APP_E2E_DRIVE_FIXTURE;
if (root && /[/\\]host[/\\]host\.mjs$/.test(process.argv[1] ?? "")) {
  const initial = JSON.parse(readFileSync(join(root, "initial.json"), "utf8"));
  const fixture = googleDriveFixture(initial.map(file => ({ ...file, bytes: Buffer.from(file.base64, "base64") })));
  const nativeFetch = globalThis.fetch;
  const snapshot = () => writeFileSync(join(root, "remote.json"), JSON.stringify({
    files: [...fixture.files.values()].map(file => ({ ...file, bytes: undefined, base64: file.bytes.toString("base64") })),
    uploads: fixture.uploads.map(file => ({ ...file, bytes: undefined, base64: file.bytes.toString("base64") })), requests: fixture.requests, revoked: fixture.revoked,
  }));
  globalThis.fetch = async (url, options) => {
    const address = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (!["https://www.googleapis.com/", "https://oauth2.googleapis.com/"].some(prefix => address.startsWith(prefix))) return nativeFetch(url, options);
    const update = join(root, "change.json");
    if (existsSync(update)) {
      const changes = JSON.parse(readFileSync(update, "utf8")); unlinkSync(update);
      for (const change of changes) {
        const file = fixture.files.get(change.id);
        if (file) { Object.assign(file, change); if (change.base64) file.bytes = Buffer.from(change.base64, "base64"); file.version++; }
      }
    }
    const result = await fixture.fetch(address, options); snapshot(); return result;
  };
  snapshot();
}
