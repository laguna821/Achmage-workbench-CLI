import { createDecipheriv, createECDH, hkdfSync, randomBytes, type ECDH } from "node:crypto";

// The PC's side of the sealed Mini App form (design §6.3 (ii), seal-v1.html): a key pair per
// request (ECDH P-256), its private half in memory only and for ten minutes; the page seals the
// fields for it (HKDF-SHA-256, AES-256-GCM, the request's nonce as salt and as authenticated data);
// the bot receives only the sealed block (`web_app_data`, which a bad client can fill with
// anything). A nonce opens once, for the one person it was made for.

export const SEAL_TTL = 10 * 60_000;
/** Telegram's limit for `sendData`, and ours for what we try to open. */
export const SEAL_LIMIT = 4096;
const INFO = "workbench-seal-v1";

export class SealError extends Error {
  readonly code: "too_large" | "malformed" | "unknown_nonce" | "expired" | "wrong_user" | "unopened" | "fields";
  constructor(code: SealError["code"]) {
    super(`seal: ${code}`);
    this.code = code;
  }
}

type Pending = { ecdh: ECDH; userId: string; handoffId: string; fields: string[]; expiresAt: number };

export class SealKeys {
  private readonly pending = new Map<string, Pending>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** A key pair for one request of one person: the public half (raw, base64url) and the request's nonce, for the page's address. */
  create(spec: { userId: string; handoffId: string; fields: string[] }): { nonce: string; publicKey: string } {
    this.prune();
    const ecdh = createECDH("prime256v1");
    const publicKey = ecdh.generateKeys().toString("base64url");
    const nonce = randomBytes(16).toString("base64url");
    this.pending.set(nonce, { ecdh, ...spec, fields: [...spec.fields], expiresAt: this.now() + SEAL_TTL });
    return { nonce, publicKey };
  }

  /** The page's address for a request: everything after "#" stays on the phone. */
  static address(page: string, request: { nonce: string; publicKey: string }, title: string, fields: string[]) {
    const hash = new URLSearchParams({ k: request.publicKey, n: request.nonce, t: title, f: fields.join(",") });
    return `${page}#${hash.toString()}`;
  }

  /** Keys past their ten minutes are destroyed (also called by a timer, not only when a new one is made). */
  prune() {
    const now = this.now();
    for (const [nonce, entry] of this.pending) if (entry.expiresAt <= now) this.pending.delete(nonce);
  }

  /** Open a sealed block from `userId`. The nonce is spent by the first try of its own person, whatever the result. */
  /** For tests: key pairs still held. */
  get size() { return this.pending.size; }

  open(data: string, userId: string): { handoffId: string; values: Record<string, string> } {
    if (Buffer.byteLength(data, "utf8") > SEAL_LIMIT) throw new SealError("too_large");
    let block: { v?: unknown; n?: unknown; epk?: unknown; iv?: unknown; ct?: unknown };
    try { block = JSON.parse(data) as typeof block; } catch { throw new SealError("malformed"); }
    if (!block || block.v !== 1 || typeof block.n !== "string" || typeof block.epk !== "string" || typeof block.iv !== "string" || typeof block.ct !== "string") throw new SealError("malformed");
    const entry = this.pending.get(block.n);
    if (!entry) throw new SealError("unknown_nonce");
    if (entry.expiresAt <= this.now()) {
      this.pending.delete(block.n);
      throw new SealError("expired");
    }
    // Someone else's block does not spend the person's request.
    if (entry.userId !== userId) throw new SealError("wrong_user");
    this.pending.delete(block.n);
    let plain: { n?: unknown; f?: unknown };
    try {
      const shared = entry.ecdh.computeSecret(Buffer.from(block.epk, "base64url"));
      const key = Buffer.from(hkdfSync("sha256", shared, Buffer.from(block.n, "utf8"), INFO, 32));
      const sealed = Buffer.from(block.ct, "base64url"), iv = Buffer.from(block.iv, "base64url");
      if (iv.length !== 12 || sealed.length < 17) throw new Error("short");
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(Buffer.from(block.n, "utf8"));
      decipher.setAuthTag(sealed.subarray(sealed.length - 16));
      plain = JSON.parse(Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]).toString("utf8")) as typeof plain;
    } catch {
      throw new SealError("unopened");
    }
    const fields = plain.f as Record<string, unknown> | undefined;
    if (plain.n !== block.n || !fields || typeof fields !== "object" || Object.keys(fields).length !== entry.fields.length || entry.fields.some((field) => typeof fields[field] !== "string" || !fields[field])) throw new SealError("fields");
    return { handoffId: entry.handoffId, values: Object.fromEntries(entry.fields.map((field) => [field, fields[field] as string])) };
  }
}
