import { expect, it, vi } from "vitest";
import { desktopAsset } from "./ieum-desktop.ts";
import { IEUM_RELEASE_ROOT, latestDesktopRelease, releaseFromManifest } from "./ieum-release.ts";

const hash = Buffer.alloc(64, 7).toString("base64");
const manifest = (file = "IeumOffice-0.12.10-arm64-mac.zip") => `version: 0.12.10\nfiles:\n  - url: ${file}\n    sha512: ${hash}\n    size: 240319159\n`;
it("pins an API-denied latest release to its official updater checksum without credentials", async () => {
  const page = new Response(null);
  Object.defineProperty(page, "url", { value: `${IEUM_RELEASE_ROOT}/tag/v0.12.10` });
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("quota", { status: 403 })).mockResolvedValueOnce(page).mockResolvedValueOnce(new Response(manifest()));
  const release = await latestDesktopRelease("darwin", "arm64", request);
  const selected = desktopAsset(release, "darwin", "arm64");
  expect(selected.algorithm).toBe("sha512");
  expect(selected.checksum).toBe(hash);
  expect(selected.size).toBe(240319159);
  expect(selected.browser_download_url).toBe(`${IEUM_RELEASE_ROOT}/download/v0.12.10/IeumOffice-0.12.10-arm64-mac.zip`);
  expect(request.mock.calls.map(call => call[0])).toEqual(["https://api.github.com/repos/pblsketch/openoffice/releases/latest", `${IEUM_RELEASE_ROOT}/latest`, `${IEUM_RELEASE_ROOT}/download/v0.12.10/latest-mac.yml`]);
  expect(request.mock.calls.every(call => !JSON.stringify(call[1]).includes("authorization"))).toBe(true);
});
it("rejects changed versions, architecture, missing hashes and remote installer paths", () => {
  for (const text of [manifest().replace("version: 0.12.10", "version: 0.12.11"), manifest().replace(hash, "bad"), manifest("../../setup.exe"), manifest("https://example.com/app.zip"), manifest().replace("240319159", "2000000000"), manifest().replace("arm64-", "")]) {
    expect(() => releaseFromManifest("v0.12.10", text, "darwin", "arm64")).toThrow();
  }
  expect(() => releaseFromManifest("../v0.12.10", manifest(), "darwin", "arm64")).toThrow();
  const linux = releaseFromManifest("v0.12.10", manifest("IeumOffice-0.12.10.AppImage"), "linux", "x64");
  expect(linux.assets[1]?.name).toBe("latest-linux.yml");
  const windows = releaseFromManifest("v0.12.10", manifest("IeumOffice-Setup-0.12.10.exe"), "win32", "x64");
  expect(desktopAsset(windows, "win32", "x64").algorithm).toBe("sha512");
});
