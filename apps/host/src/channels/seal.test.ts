import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SEAL_LIMIT, SEAL_TTL, SealKeys } from "./seal.ts";

// The sealed Mini App form (design §6.3 (ii)): the page's own sealing code (taken from
// seal-v1.html as it is) against the PC's keys. Made-up values only.
const page = readFileSync(new URL("./seal-v1.html", import.meta.url), "utf8");
const code = /\/\* seal:begin \*\/([\s\S]*?)\/\* seal:end \*\//.exec(page)![1]!;
const sealFields = new Function(`${code}; return sealFields;`)() as (key: string, nonce: string, fields: Record<string, string>) => Promise<string>;
const VALUES = { 아이디: "zz-secret-user-0010", 비밀번호: "zz-secret-pass-0010" };

function keys() {
  const clock = { now: 1_000_000 };
  const seals = new SealKeys(() => clock.now);
  const request = seals.create({ userId: "555", handoffId: "h1", fields: ["아이디", "비밀번호"] });
  return { clock, seals, request };
}

describe("seal-v1.html", () => {
  it("is self-contained: no external script, style, image or connection", () => {
    expect(page).not.toMatch(/<script[^>]+src=|<link[^>]+href=|<img|@import|url\(/i);
    expect(page).toContain("connect-src 'none'");
    expect(page).not.toMatch(/https?:\/\/(?!t\.me)/);
    expect(page).toContain('input.type = "password"');
  });
});

describe("SealKeys", () => {
  it("opens what the page sealed for its nonce and person, once", async () => {
    const { seals, request } = keys();
    const data = await sealFields(request.publicKey, request.nonce, VALUES);
    expect(Buffer.byteLength(data)).toBeLessThan(SEAL_LIMIT);
    for (const value of Object.values(VALUES)) expect(data).not.toContain(value);
    expect(seals.open(data, "555")).toEqual({ handoffId: "h1", values: VALUES });
    expect(() => seals.open(data, "555")).toThrow(expect.objectContaining({ code: "unknown_nonce" }));
  });

  it("refuses another person's block without spending the person's request", async () => {
    const { seals, request } = keys();
    const data = await sealFields(request.publicKey, request.nonce, VALUES);
    expect(() => seals.open(data, "666")).toThrow(expect.objectContaining({ code: "wrong_user" }));
    expect(seals.open(data, "555").values).toEqual(VALUES);
  });

  it("refuses more than 4096 bytes, a changed block, other fields, and a request older than ten minutes", async () => {
    const { clock, seals, request } = keys();
    expect(() => seals.open("x".repeat(SEAL_LIMIT + 1), "555")).toThrow(expect.objectContaining({ code: "too_large" }));
    const data = JSON.parse(await sealFields(request.publicKey, request.nonce, VALUES)) as { ct: string };
    const changed = JSON.stringify({ ...data, ct: `${data.ct.slice(0, -2)}${data.ct.endsWith("A") ? "B" : "A"}A` });
    expect(() => seals.open(changed, "555")).toThrow(expect.objectContaining({ code: "unopened" }));
    const second = seals.create({ userId: "555", handoffId: "h2", fields: ["키"] });
    const other = await sealFields(second.publicKey, second.nonce, { 다른칸: "zz-secret-key-0010" });
    expect(() => seals.open(other, "555")).toThrow(expect.objectContaining({ code: "fields" }));
    const third = seals.create({ userId: "555", handoffId: "h3", fields: ["키"] });
    const late = await sealFields(third.publicKey, third.nonce, { 키: "zz-secret-key-0011" });
    clock.now += SEAL_TTL + 1;
    expect(() => seals.open(late, "555")).toThrow(expect.objectContaining({ code: "expired" }));
    expect(() => seals.open(late, "555")).toThrow(expect.objectContaining({ code: "unknown_nonce" }));
    expect(() => seals.open("{\"v\":2}", "555")).toThrow(expect.objectContaining({ code: "malformed" }));
  });

  it("puts the key, nonce, title and fields after # in the page's address", () => {
    const { request } = keys();
    const address = SealKeys.address("https://example.org/seal-v1.html", request, "학술정보원", ["아이디", "비밀번호"]);
    const url = new URL(address);
    expect(url.search).toBe("");
    const hash = new URLSearchParams(url.hash.slice(1));
    expect(hash.get("k")).toBe(request.publicKey);
    expect(hash.get("n")).toBe(request.nonce);
    expect(hash.get("f")).toBe("아이디,비밀번호");
  });
});

describe("fix round 1 (Minor 3)", () => {
  it("destroys a key pair at ten minutes even when no new form is opened", () => {
    const { clock, seals } = keys();
    expect(seals.size).toBe(1);
    clock.now += SEAL_TTL + 1;
    seals.prune();
    expect(seals.size).toBe(0);
  });
});

describe("the page address (off unless set)", () => {
  it("is taken only as an HTTPS address of seal-v1.html, without credentials, query or fragment", async () => {
    const { sealPageOf } = await import("./gateway.ts");
    expect(sealPageOf(undefined)).toBeNull();
    expect(sealPageOf("")).toBeNull();
    expect(sealPageOf("https://forms.example.org/wb/seal-v1.html")).toBe("https://forms.example.org/wb/seal-v1.html");
    for (const bad of ["http://forms.example.org/seal-v1.html", "https://user:pw@forms.example.org/seal-v1.html", "https://forms.example.org/seal-v2.html", "https://forms.example.org/seal-v1.html?x=1", "https://forms.example.org/seal-v1.html#k=1", "javascript:alert(1)"]) expect(sealPageOf(bad), bad).toBeNull();
  });
});
