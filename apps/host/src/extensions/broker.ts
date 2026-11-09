import { lookup } from "node:dns/promises";
import { constants, closeSync, fstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { isIP } from "node:net";
import { setTimeout } from "node:timers/promises";
import type { ExtensionCall, ExtensionGrant, Workspace } from "@workbench/contracts";
import { HttpError } from "../errors.ts";
import { requireExtensionCall, scopedFile } from "./permissions.ts";

const denied = (message: string) => new HttpError(403, "extension_broker_denied", message);
const LIMIT = 1024 * 1024;
function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a < 224 && !(a === 169 && b === 254)
      && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && [0, 168].includes(b))
      && !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && [18, 19, 51].includes(b))
      && !(a === 203 && b === 0);
  }
  // Public unicast only, including denial of mapped IPv4, link-local and documentation addresses.
  return /^[23][a-f0-9]{3}:/i.test(address) && !/^2001:db8:/i.test(address);
}

export function extensionBroker(options: {
  call: ExtensionCall; currentGrant: () => ExtensionGrant; workspace: () => Workspace;
  authorizeWrite?: (workspace: Workspace, absolutePath: string) => void;
}) {
  return async (method: string, raw: unknown, signal: AbortSignal): Promise<unknown> => {
    signal.throwIfAborted();
    const grant = options.currentGrant(); requireExtensionCall(options.call, grant);
    const workspace = options.workspace();
    const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    if (method === "delay") {
      if (typeof input.ms !== "number" || !Number.isFinite(input.ms) || input.ms < 0 || input.ms > 5000) throw denied("대기 시간은 0~5000ms여야 합니다.");
      await setTimeout(input.ms, undefined, { signal }); requireExtensionCall(options.call, options.currentGrant()); return null;
    }
    if (method === "file.read" || method === "file.write") {
      const action = method === "file.read" ? "read" : "write";
      if (!grant.permissions.files.includes(action) || typeof input.path !== "string") throw denied("이 파일 동작은 승인되지 않았습니다.");
      const file = scopedFile(workspace.cwd, input.path, action === "write");
      if (action === "read") {
        const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile() || stat.size > LIMIT) throw denied("일반 텍스트 파일을 1 MiB까지 읽을 수 있습니다.");
          const text = readFileSync(fd, "utf8"); requireExtensionCall(options.call, options.currentGrant()); return text;
        } finally { closeSync(fd); }
      }
      if (!options.authorizeWrite) throw denied("이 호스트는 확장의 파일 쓰기를 활성화하지 않았습니다.");
      options.authorizeWrite(workspace, file);
      if (typeof input.text !== "string" || Buffer.byteLength(input.text) > LIMIT) throw denied("새 텍스트 파일은 1 MiB 이하여야 합니다.");
      requireExtensionCall(options.call, options.currentGrant()); signal.throwIfAborted();
      // Supported v1 only creates new files. It cannot silently replace Office files or human originals.
      const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { writeFileSync(fd, input.text); } finally { closeSync(fd); }
      return { path: input.path, created: true };
    }
    if (method !== "network.fetch" || typeof input.url !== "string") throw denied("지원하지 않는 host import입니다.");
    const url = new URL(input.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || !grant.permissions.network.some(endpoint => {
      const allowed = new URL(endpoint);
      return allowed.origin === url.origin && (url.pathname === allowed.pathname || url.pathname.startsWith(allowed.pathname.endsWith("/") ? allowed.pathname : allowed.pathname + "/"));
    })) throw denied("승인하지 않은 네트워크 주소입니다.");
    const addresses = await lookup(url.hostname, { all: true });
    if (!addresses.length || addresses.some(entry => !publicAddress(entry.address))) throw denied("로컬 또는 사설 네트워크 주소는 사용할 수 없습니다.");
    requireExtensionCall(options.call, options.currentGrant()); signal.throwIfAborted();
    const methodName = input.method ?? "GET";
    if (methodName !== "GET" && methodName !== "POST") throw denied("GET과 POST만 지원합니다.");
    if (input.body !== undefined && (typeof input.body !== "string" || Buffer.byteLength(input.body) > LIMIT)) throw denied("요청 본문은 1 MiB 이하여야 합니다.");
    const pinned = addresses[0]!;
    const response = await new Promise<{ status: number; text: string; contentType: string }>((resolve, reject) => {
      const req = request(url, { method: methodName, signal, timeout: 5000,
        // DNS is resolved and validated once; the actual socket uses this address. No redirects/proxy/env tokens.
        lookup: (_host, _options, done) => done(null, pinned.address, pinned.family),
        headers: { "content-type": "application/json", "user-agent": "Workbench-Bounded-Extension/1" },
      }, res => {
        const chunks: Buffer[] = []; let size = 0;
        res.on("data", (chunk: Buffer) => { size += chunk.length; if (size > LIMIT) req.destroy(new Error("Extension response exceeds 1 MiB")); else chunks.push(chunk); });
        res.once("error", reject);
        res.once("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8"), contentType: String(res.headers["content-type"] ?? "") }));
      });
      req.once("error", reject); req.once("timeout", () => req.destroy(new Error("Extension network deadline exceeded")));
      req.end(typeof input.body === "string" ? input.body : undefined);
    });
    requireExtensionCall(options.call, options.currentGrant()); return response;
  };
}
