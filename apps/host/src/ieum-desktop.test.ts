import { expect, it } from "vitest";
import { desktopAsset, type DesktopRelease } from "./ieum-desktop.ts";

const release: DesktopRelease = { tag_name: "v0.12.9", assets: ["IeumOffice-Setup-0.12.9.exe", "IeumOffice-0.12.9-arm64-mac.zip", "IeumOffice-0.12.9-mac.zip"].map((name) => ({ name, browser_download_url: `https://github.com/pblsketch/openoffice/releases/download/v0.12.9/${name}`, digest: `sha256:${"a".repeat(64)}`, size: 200_000_000 })) };
it("chooses the official OS and architecture installer with a required published digest", () => {
  expect(desktopAsset(release, "win32", "x64").name).toBe("IeumOffice-Setup-0.12.9.exe");
  expect(desktopAsset(release, "darwin", "arm64").name).toBe("IeumOffice-0.12.9-arm64-mac.zip");
  expect(desktopAsset(release, "darwin", "x64").name).toBe("IeumOffice-0.12.9-mac.zip");
  expect(() => desktopAsset(release, "darwin", "riscv64")).toThrow();
  for (const patch of [{ digest: null }, { browser_download_url: "https://example.com/file.exe" }, { size: 2_000_000_000 }]) {
    expect(() => desktopAsset({ ...release, assets: [{ ...release.assets[0]!, ...patch }] }, "win32", "x64")).toThrow();
  }
  expect(() => desktopAsset({ ...release, tag_name: "../../evil" }, "win32", "x64")).toThrow();
});
