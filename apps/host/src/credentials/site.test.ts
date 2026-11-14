import { describe, expect, it } from "vitest";
import { askableHost, siteOf, siteRefusal } from "./site.ts";

// Unit 9: where a stored login may be typed. Only on the entry's own site — the gate against a
// page (or a prompt-injected AI) asking for "the form here". Hosts are modelled as written; the
// loopback cases are what the smoke's test site uses (127.0.0.1 and 127.0.0.2, different ports).

const allowed = (given: string, page: string) => siteRefusal(siteOf(given)!, page);

describe("the site an entry is for", () => {
  it("is https and the default port unless given otherwise", () => {
    expect(siteOf("nid.naver.com")).toEqual({ scheme: "https", host: "nid.naver.com", port: null });
    expect(siteOf("https://nid.naver.com/nidlogin.login?mode=form")).toEqual({ scheme: "https", host: "nid.naver.com", port: null });
    expect(siteOf("http://127.0.0.1:41233/login")).toEqual({ scheme: "http", host: "127.0.0.1", port: "41233" });
    expect(siteOf("https://portal.example.ac.kr:443/")).toEqual({ scheme: "https", host: "portal.example.ac.kr", port: null });
    expect(siteOf("")).toBeNull();
    expect(siteOf("javascript:alert(1)")).toBeNull();
  });
});

describe("a fill on a page", () => {
  it("goes on the entry's exact host, and between www. and the bare name of that host", () => {
    expect(allowed("nid.naver.com", "https://nid.naver.com/nidlogin.login")).toBeNull();
    expect(allowed("NID.naver.com.", "https://nid.naver.com/")).toBeNull();
    expect(allowed("example.com", "https://www.example.com/login")).toBeNull();
    expect(allowed("www.example.com", "https://example.com/login")).toBeNull();
    expect(allowed("nid.naver.com", "https://www.nid.naver.com/")).toBeNull();
  });

  it("does not go on a sibling host of the same domain, nor on another tenant of shared hosting", () => {
    for (const [given, page] of [
      ["nid.naver.com", "https://m.naver.com/"], ["nid.naver.com", "https://anything.naver.com/"], ["naver.com", "https://nid.naver.com/"],
      ["portal.hallym.ac.kr", "https://studentlab.hallym.ac.kr/"], ["lib.hallym.ac.kr", "https://portal.hallym.ac.kr/sso"],
      ["shop-a.myshopify.com", "https://evil.myshopify.com/"], ["hallym.sharepoint.com", "https://evil.sharepoint.com/"],
      ["a.wordpress.com", "https://evil.wordpress.com/"], ["a.oopy.io", "https://evil.oopy.io/"], ["a.ngrok.app", "https://evil.ngrok.app/"],
      ["www.example.com", "https://www.www.example.com/"], ["example.com", "https://wwwexample.com/"],
    ]) expect(allowed(given!, page!), `${given} → ${page}`).toBe("wrong_site");
  });

  it("goes on a host the person allowed for the entry, by the same scheme and port rule", () => {
    const site = siteOf("nid.naver.com")!;
    expect(siteRefusal(site, "https://m.naver.com/", ["m.naver.com"])).toBeNull();
    expect(siteRefusal(site, "https://www.m.naver.com/", ["m.naver.com"])).toBeNull();
    expect(siteRefusal(site, "https://x.naver.com/", ["m.naver.com"])).toBe("wrong_site");
    expect(siteRefusal(site, "http://m.naver.com/", ["m.naver.com"])).toBe("insecure");
    expect(siteRefusal(site, "https://m.naver.com:8443/", ["m.naver.com"])).toBe("wrong_site");
  });

  it("asks the person only for a real other host on the right scheme and port: never a look-alike, an address or a single name", () => {
    const site = siteOf("nid.naver.com")!;
    expect(askableHost(site, "https://m.naver.com/login")).toBe("m.naver.com");
    expect(askableHost(site, "https://sso.example.org/")).toBe("sso.example.org");
    expect(askableHost(site, "https://auth.nid.naver.com/")).toBe("auth.nid.naver.com");
    for (const page of [
      "https://nid.naver.com/", // its own host
      "http://m.naver.com/", "https://m.naver.com:8443/", // scheme or port
      "https://nаver.com/", "https://nid.nаver.com/", // Cyrillic а
      "https://nid.naver.corn/", "https://nid.naveг.com/", "https://n1d.naver.com/", "https://nid-naver.com/", "https://nidnaver.com/",
      "https://nid.naver.com.evil.example/", "https://login-nid.naver.com-secure.example/", // the entry's name inside another host
      "https://127.0.0.2/", "https://[::1]/", "https://localhost/", "about:blank", "not a url",
    ]) expect(askableHost(site, page), page).toBeNull();
    expect(askableHost(siteOf("http://127.0.0.1:41233")!, "http://127.0.0.2:41233/")).toBeNull();
  });

  it("is refused on look-alike hosts", () => {
    for (const page of [
      "https://nid.naver.com.evil.example/", "https://nid-naver.com/", "https://navercorp-login.com/", "https://naver.co/",
      "https://nаver.com/", // a Cyrillic а
      "https://nid.naver.com@evil.example/", "https://evil.example/?next=https://nid.naver.com/",
    ]) expect(allowed("nid.naver.com", page), page).toBe("wrong_site");
    expect(allowed("lib.hallym.ac.kr", "https://other.ac.kr/")).toBe("wrong_site");
    expect(allowed("alice.github.io", "https://bob.github.io/")).toBe("wrong_site");
    expect(allowed("alice.github.io", "https://alice.github.io/login")).toBeNull();
  });

  it("is refused on plain http unless the entry was stored for http; an http entry may go on its https", () => {
    expect(allowed("nid.naver.com", "http://nid.naver.com/")).toBe("insecure");
    expect(allowed("http://127.0.0.1:41233", "http://127.0.0.1:41233/login")).toBeNull();
    expect(allowed("http://127.0.0.1:41233", "https://127.0.0.1:41233/login")).toBeNull();
  });

  it("takes an address and a port as part of the site (the loopback test site's model of other hosts)", () => {
    expect(allowed("http://127.0.0.1:41233", "http://127.0.0.2:41233/login")).toBe("wrong_site");
    expect(allowed("http://127.0.0.1:41233", "http://127.0.0.1:41234/login")).toBe("wrong_site");
    expect(allowed("http://127.0.0.1:41233", "http://localhost:41233/login")).toBe("wrong_site");
    expect(allowed("nid.naver.com", "https://nid.naver.com:8443/")).toBe("wrong_site");
  });

  it("is refused on pages that are not web pages", () => {
    for (const page of ["about:blank", "data:text/html,<form>", "file:///etc/passwd", "chrome://settings", "", "not a url"]) expect(allowed("nid.naver.com", page), page).toBe("wrong_site");
  });
});
