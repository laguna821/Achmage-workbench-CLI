import { isIP } from "node:net";
import { domainToUnicode } from "node:url";

// Where a stored login may be typed (unit 9): only on the entry's own site. The rule, exactly:
// - the page's scheme is https; plain http only when the entry was stored for http (an http entry
//   may also go on https of the same host and port);
// - the port is the entry's port when it was given, otherwise the scheme's default;
// - the host is the entry's host exactly, or that host with or without a leading "www.", or a host
//   the person allowed for this entry (asked in the chat, `askableHost`; removable at the PC).
// No registrable-domain sharing: "m.naver.com" is not "nid.naver.com" until the person says so.
// Hosts are compared as the URL parser gives them (lower case, IDNs in punycode), so a look-alike
// written in another alphabet is another host.

export type SiteOrigin = { scheme: "https" | "http"; host: string; port: string | null };

const DEFAULT_PORT = { https: "443", http: "80" } as const;

/** The site an entry is for, from what was given ("nid.naver.com", "https://…/login", "http://127.0.0.1:8080"). */
export function siteOf(given: unknown): SiteOrigin | null {
  if (typeof given !== "string") return null;
  const text = given.trim();
  if (!text) return null;
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^/:]+:\d+(\/|$)/.test(text) ? text : `https://${text}`); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!url.hostname) return null;
  const scheme = url.protocol === "http:" ? "http" : "https";
  return { scheme, host: url.hostname.toLowerCase(), port: url.port && url.port !== DEFAULT_PORT[scheme] ? url.port : null };
}

/** How an entry's site is kept when it is more than its host (http, or a port): "http://127.0.0.1:41233". */
export function originText(site: SiteOrigin): string | null {
  return site.scheme === "https" && !site.port ? null : `${site.scheme}://${site.host.includes(":") ? `[${site.host}]` : site.host}${site.port ? `:${site.port}` : ""}`;
}

const bareHost = (host: string) => host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
const withoutWww = (host: string) => host.replace(/^www\./, "");

/** The same host, with or without a leading "www.". */
function sameHost(a: string, b: string) {
  return a === b || withoutWww(a) === withoutWww(b);
}

/** Whether a stored login may be typed on this page address: null, or why not. `hosts`: other hosts the person allowed for the entry. */
export function siteRefusal(site: SiteOrigin, page: string, hosts: readonly string[] = []): "wrong_site" | "insecure" | null {
  let url: URL;
  try { url = new URL(page); } catch { return "wrong_site"; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "wrong_site";
  const scheme = url.protocol === "http:" ? "http" : "https";
  const host = bareHost(url.hostname);
  const port = url.port || DEFAULT_PORT[scheme];
  const onHost = [site.host, ...hosts].some((own) => sameHost(host, bareHost(own)));
  const samePort = site.port ? port === site.port : port === DEFAULT_PORT[scheme];
  if (!onHost || !samePort) return "wrong_site";
  if (scheme === "http" && site.scheme !== "http") return "insecure";
  return null;
}

/** Characters that read alike, folded to one (Cyrillic and Greek letters, digits). */
const ALIKE: Record<string, string> = {
  а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", і: "l", ӏ: "l", ј: "j", ѕ: "s", ԁ: "d", ɡ: "g", һ: "h", г: "r", п: "n", к: "k", т: "t", м: "m", в: "b", н: "h", ԛ: "q", ԝ: "w",
  ο: "o", α: "a", ν: "v", ρ: "p", ι: "l", κ: "k", τ: "t", υ: "u", ε: "e", χ: "x",
  "0": "o", "1": "l", i: "l", "|": "l",
};

/** A host as it reads: alike characters folded, "rn" as "m", "vv" as "w", without "www." and separators. */
function skeleton(host: string) {
  const unicode = domainToUnicode(host) || host;
  return [...withoutWww(unicode.normalize("NFKC").toLowerCase())].map((char) => ALIKE[char] ?? char).join("").replace(/rn/g, "m").replace(/vv/g, "w").replace(/[.\-_]/g, "");
}

/**
 * The host of a page that may be offered to the person for this entry ("'X' 로그인은 a에 저장되어
 * 있습니다. b에서도 쓰게 할까요?"), or null: only a named host (not an address, not a single name,
 * not an IDN) on the entry's scheme and port, that is not the entry's own, does not read like it and
 * does not carry it inside another name (its own subdomains may be asked).
 */
export function askableHost(site: SiteOrigin, page: string): string | null {
  let url: URL;
  try { url = new URL(page); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = bareHost(url.hostname);
  const own = bareHost(site.host);
  if (!host || isIP(host) || !host.includes(".") || host.split(".").some((label) => label.startsWith("xn--"))) return null;
  if (sameHost(host, own) || siteRefusal({ ...site, host }, page) !== null) return null;
  // Reads like the entry's host, or carries it inside another name ("nid.naver.com.evil.example").
  if (skeleton(host) === skeleton(own) || (!host.endsWith(`.${own}`) && skeleton(host).includes(skeleton(own)))) return null;
  return host;
}
