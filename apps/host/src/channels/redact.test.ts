import { describe, expect, it } from "vitest";
import { Redactor, redact } from "./redact.ts";

// Made-up values in the shapes the messengers use; none of them was ever issued.
const BOT = "7012345678:AAH" + "x".repeat(8) + "-Fake_token-for-tests-0001";
const XOXB = "xoxb-" + "1234567890-0987654321-" + "abcDEFghiJKLmnoPQRstuVWX";
const XAPP = "xapp-" + "1-A0123456789-1234567890123-" + "f".repeat(40);

describe("the shared redactor", () => {
  const cases: [name: string, input: string, expected: string][] = [
    ["a Telegram bot token", `token=${BOT} rest`, "token=[봇 토큰] rest"],
    ["a bot token inside an API address", `POST https://api.telegram.org/bot${BOT}/sendMessage failed`, "POST https://api.telegram.org/bot[봇 토큰]/sendMessage failed"],
    ["a Telegram file address (it carries the token)", `got https://api.telegram.org/file/bot${BOT}/documents/file_12.pdf ok`, "got [파일 주소] ok"],
    ["a file address on another Bot API host", `http://127.0.0.1:4010/file/bot${BOT}/photos/a.jpg`, "[파일 주소]"],
    ["a Slack bot token", `Authorization: Bearer ${XOXB}`, "Authorization: Bearer [Slack 토큰]"],
    ["a Slack user token", "xoxp-" + "1".repeat(12) + "-" + "a".repeat(24), "[Slack 토큰]"],
    ["a Slack app-level token", `app=${XAPP};`, "app=[Slack 토큰];"],
    ["two secrets in one line", `${BOT} and ${XOXB}`, "[봇 토큰] and [Slack 토큰]"],
    ["an ordinary sentence", "예산표 3쪽을 고쳤습니다 (12:30, 비율 3:2)", "예산표 3쪽을 고쳤습니다 (12:30, 비율 3:2)"],
    ["a number and a colon that are not a token", "id 123456:short", "id 123456:short"],
    ["an empty line", "", ""],
  ];
  it.each(cases)("hides %s", (_name, input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  it("hides values it was told about, as written, in base64 and URL-encoded, under their name", () => {
    const redactor = new Redactor();
    const value = "p@ss word/한글+1";
    redactor.add("네이버", value);
    const line = `raw ${value} b64 ${Buffer.from(value).toString("base64")} url ${encodeURIComponent(value)} b64url ${Buffer.from(value).toString("base64url")}`;
    expect(redactor.apply(line)).toBe("raw [비밀: 네이버] b64 [비밀: 네이버] url [비밀: 네이버] b64url [비밀: 네이버]");
  });

  it("does not register values shorter than eight characters (they would blank ordinary words)", () => {
    const redactor = new Redactor();
    redactor.add("짧은값", "1234567");
    expect(redactor.apply("번호 1234567 입니다")).toBe("번호 1234567 입니다");
  });

  it("forgets a value when asked, and hides the longest value first when one contains another", () => {
    const redactor = new Redactor();
    redactor.add("긴값", "abcdefgh-ijklmnop");
    redactor.add("짧은값", "abcdefgh");
    expect(redactor.apply("x abcdefgh-ijklmnop y abcdefgh z")).toBe("x [비밀: 긴값] y [비밀: 짧은값] z");
    redactor.remove("긴값");
    expect(redactor.apply("x abcdefgh-ijklmnop y")).toBe("x [비밀: 짧은값]-ijklmnop y");
  });

  it("hides a token with zero-width characters inside it", () => {
    const split = `${BOT.slice(0, 20)}\u200b${BOT.slice(20, 30)}\u2060${BOT.slice(30)}`;
    expect(redact(`token ${split} end`)).toBe("token [봇 토큰] end");
    const redactor = new Redactor();
    redactor.add("telegram:1", "registered-secret-value-42");
    expect(redactor.apply("key regis\u200btered-secret\ufeff-value-42.")).toBe("key [비밀: telegram:1].");
  });

  it("hides a registered value inside the base64 of 'user:value' (a Basic-auth header) and in hex", () => {
    const redactor = new Redactor();
    redactor.add("telegram:7012345678", BOT);
    for (const user of ["", "u", "us", "user", "bot-account"]) {
      const basic = Buffer.from(`${user}:${BOT}`).toString("base64");
      const out = redactor.apply(`Authorization: Basic ${basic}`);
      expect(out, user).toContain("[비밀: telegram:7012345678]");
      // What is left of the blob is too short to rebuild the value from (at most the first and last few bytes).
      expect(out.replace(/\[비밀: [^\]]+\]/g, "").replace("Authorization: Basic ", "").length, user).toBeLessThanOrEqual(Math.ceil((user.length + 1) * 4 / 3) + 8);
    }
    const hex = Buffer.from(BOT).toString("hex");
    expect(redactor.apply(`dump ${hex} ${hex.toUpperCase()}`)).toBe("dump [비밀: telegram:7012345678] [비밀: telegram:7012345678]");
    expect(redactor.apply(`bot${encodeURIComponent(BOT).replace("%3A", "%3a")}`)).toBe("bot[비밀: telegram:7012345678]");
  });

  it("keeps hiding a value that was replaced under the same name", () => {
    const redactor = new Redactor();
    redactor.add("telegram:1", "the-first-token-value-0001");
    redactor.add("telegram:1", "the-second-token-value-0002");
    expect(redactor.apply("old the-first-token-value-0001 new the-second-token-value-0002")).toBe("old [비밀: telegram:1 (이전)] new [비밀: telegram:1]");
  });

  it("hides secrets found anywhere in an error, including its cause and a nested address", () => {
    const error = new Error(`fetch failed for https://api.telegram.org/bot${BOT}/getUpdates`, { cause: new Error(`connect to file/bot${BOT}/x`) });
    const text = new Redactor().error(error);
    expect(text).not.toContain(BOT);
    expect(text).toContain("[봇 토큰]");
  });
});
