import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChannelLog, fileLog } from "./log.ts";
import { Redactor } from "./redact.ts";

// A made-up value in the shape of a bot token; it was never issued.
const TOKEN = "7012345678:AAH" + "w".repeat(8) + "-Fake_token-for-tests-0004";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function folder() {
  const dir = mkdtempSync(join(tmpdir(), "wb-channel-log-"));
  dirs.push(dir);
  return dir;
}

describe("the channel's log", () => {
  it("writes a fixed code with a detail that has passed the redactor", () => {
    const lines: string[] = [];
    const redactor = new Redactor();
    redactor.add("노션키", "secret_abcdefgh12345");
    const log = new ChannelLog(redactor, (line) => lines.push(line), () => 1_700_000_000_000);
    log.note("poll_failed", new Error(`fetch failed https://api.telegram.org/bot${TOKEN}/getUpdates`));
    log.note("send_failed", `value secret_abcdefgh12345 and https://api.telegram.org/file/bot${TOKEN}/doc.pdf`);
    log.note("started");
    expect(lines).toEqual([
      "2023-11-14T22:13:20.000Z poll_failed fetch failed https://api.telegram.org/bot[봇 토큰]/getUpdates",
      "2023-11-14T22:13:20.000Z send_failed value [비밀: 노션키] and [파일 주소]",
      "2023-11-14T22:13:20.000Z started",
    ]);
  });

  it("keeps each entry on one line", () => {
    const lines: string[] = [];
    new ChannelLog(new Redactor(), (line) => lines.push(line), () => 0).note("odd", "first\nsecond\r\nthird");
    expect(lines).toEqual(["1970-01-01T00:00:00.000Z odd first second third"]);
  });

  it("appends to <data>/channels/channel.log (0600) and starts a new file when it grows past its limit", () => {
    const dir = folder();
    const write = fileLog(dir, 200);
    const log = new ChannelLog(new Redactor(), write, () => 0);
    log.note("one", TOKEN);
    const file = join(dir, "channels", "channel.log");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toBe("1970-01-01T00:00:00.000Z one [봇 토큰]\n");
    for (let index = 0; index < 10; index += 1) log.note("fill", "x".repeat(40));
    expect(statSync(file).size).toBeLessThanOrEqual(200 + 80);
    expect(readFileSync(`${file}.1`, "utf8")).toContain("fill");
  });

  it("never stops the channel when the log cannot be written", () => {
    const dir = folder();
    // A file where the folder should be.
    writeFileSync(join(dir, "channels"), "not a folder");
    const log = new ChannelLog(new Redactor(), fileLog(dir), () => 0);
    expect(() => log.note("one")).not.toThrow();
  });
});
