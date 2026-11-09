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
  expect(request.mock.calls.map(call => call[0])).toEqual(["https://api.github.com/repos/pblsketch/ieumoffice/releases/latest", `${IEUM_RELEASE_ROOT}/latest`, `${IEUM_RELEASE_ROOT}/download/v0.12.10/latest-mac.yml`]);
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

// Published API asset and latest.yml from the renamed repository, retrieved 2026-11-10 KST:
// https://github.com/pblsketch/ieumoffice/releases/tag/v0.12.12
const windowsAsset = {
  name: "IeumOffice-Setup-0.12.12.exe",
  browser_download_url: "https://github.com/pblsketch/ieumoffice/releases/download/v0.12.12/IeumOffice-Setup-0.12.12.exe",
  digest: "sha256:98eb1be0488c9f64427007f2ac091d9d6715a9cb7b6b053febb49bfe2b86cc3c",
  size: 231243779,
};
const windowsSha512 = "9pEJ2NEdHtYzqeC7RZCfZg4nJeEus2VRmgrDMjMPlhiArKqPDXOk9c1O41oyn9hWvw8z59WKk78lv9cIfo/XAQ==";
const windowsManifest = `version: 0.12.12\nfiles:\n  - url: IeumOffice-Setup-0.12.12.exe\n    sha512: ${windowsSha512}\n    size: 231243779\npath: IeumOffice-Setup-0.12.12.exe\nsha512: ${windowsSha512}\nreleaseDate: '2026-11-09T01:58:05.453Z'\n`;

it("accepts the renamed official repository API asset while retaining exact installer verification", async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ tag_name: "v0.12.12", assets: [windowsAsset] }));
  const release = await latestDesktopRelease("win32", "x64", request);
  expect(request.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/pblsketch/ieumoffice/releases/latest");
  expect(desktopAsset(release, "win32", "x64")).toMatchObject({ ...windowsAsset, version: "0.12.12", algorithm: "sha256", checksum: windowsAsset.digest.slice(7) });
  const legacyUrl = windowsAsset.browser_download_url.replace("/ieumoffice/", "/openoffice/");
  expect(desktopAsset({ ...release, assets: [{ ...windowsAsset, browser_download_url: legacyUrl }] }, "win32", "x64").browser_download_url).toBe(legacyUrl);
  for (const patch of [
    { browser_download_url: windowsAsset.browser_download_url.replace("github.com/", "github.com.evil.invalid/") },
    { browser_download_url: windowsAsset.browser_download_url.replace("/pblsketch/", "/other/") },
    { browser_download_url: windowsAsset.browser_download_url.replace("/v0.12.12/", "/v0.12.11/") },
    { browser_download_url: `${windowsAsset.browser_download_url}?download=1` },
    { name: "IeumOffice-Setup-0.12.11.exe" },
    { digest: null },
    { digest: "sha256:invalid" },
    { size: 0 },
    { size: 2_000_000_000 },
  ]) expect(() => desktopAsset({ ...release, assets: [{ ...windowsAsset, ...patch }] }, "win32", "x64")).toThrow();
});

it("pins API-denied downloads to the renamed official repository manifest and rejects other redirects", async () => {
  for (const root of [IEUM_RELEASE_ROOT, "https://github.com/pblsketch/openoffice/releases"]) {
    const page = new Response(null);
    Object.defineProperty(page, "url", { value: `${root}/tag/v0.12.12` });
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("quota", { status: 403 })).mockResolvedValueOnce(page).mockResolvedValueOnce(new Response(windowsManifest));
    const selected = desktopAsset(await latestDesktopRelease("win32", "x64", request), "win32", "x64");
    expect(selected).toMatchObject({ name: windowsAsset.name, browser_download_url: windowsAsset.browser_download_url, size: windowsAsset.size, version: "0.12.12", algorithm: "sha512", checksum: windowsSha512 });
    expect(request.mock.calls.map(call => call[0])).toEqual(["https://api.github.com/repos/pblsketch/ieumoffice/releases/latest", `${IEUM_RELEASE_ROOT}/latest`, `${IEUM_RELEASE_ROOT}/download/v0.12.12/latest.yml`]);
  }
  const page = new Response(null);
  Object.defineProperty(page, "url", { value: "https://github.com/other/ieumoffice/releases/tag/v0.12.12" });
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("quota", { status: 403 })).mockResolvedValueOnce(page);
  await expect(latestDesktopRelease("win32", "x64", request)).rejects.toThrow("공식 이음오피스 최신 배포를 확인하지 못했습니다.");
  expect(request).toHaveBeenCalledTimes(2);
});
