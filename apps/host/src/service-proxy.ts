import { requestLocalService } from "@workbench/paseo-terminal/local-service";
import type { IncomingMessage } from "node:http";
import { HttpError } from "./errors.ts";

export interface ServiceProxyRequest {
  method: string;
  headers?: HeadersInit;
  body?: Uint8Array;
  signal?: AbortSignal;
}
const requestHeaders = new Set(["accept", "accept-language", "content-type", "range", "if-none-match", "if-modified-since"]);
const responseHeaders = new Set(["content-type", "content-disposition", "etag", "last-modified", "content-range", "accept-ranges"]);
const MAX_REQUEST = 8 * 1024 * 1024, MAX_RESPONSE = 16 * 1024 * 1024;

/** Original Paseo loopback connector, after Workbench resolves one owned service and its grant. */
export function proxyOwnedService(port: number, path: string, request: ServiceProxyRequest, check: () => void): Promise<Response> {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof path !== "string" || path.length > 16000 ||
      !path.startsWith("/") || path.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(path)) throw new HttpError(400, "service_proxy_path", "서버 안의 /로 시작하는 경로를 입력해 주세요.");
  const target = new URL(path, "http://workbench-service.invalid");
  if (target.origin !== "http://workbench-service.invalid" || target.hash || !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(request.method)) throw new HttpError(400, "service_proxy_request", "서비스 요청 형식을 확인해 주세요.");
  if ((request.body?.byteLength ?? 0) > MAX_REQUEST) throw new HttpError(413, "service_proxy_size", "서비스 요청은 8 MiB 이하여야 합니다.");
  request.signal?.throwIfAborted(); check();
  const headers: Record<string, string> = {};
  new Headers(request.headers).forEach((value, key) => { if (requestHeaders.has(key)) headers[key] = value; });
  // Host credentials/cookies and proxy/forwarded headers never reach the project process.
  headers["accept-encoding"] = "identity";
  if (request.body) headers["content-length"] = String(request.body.byteLength);
  return new Promise((resolve, reject) => {
    let upstream: IncomingMessage | undefined, settled = false, bytes = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: unknown) => {
      clearInterval(watch); clearTimeout(timeout); request.signal?.removeEventListener("abort", abort);
      if (settled) return; settled = true;
      if (error) { outgoing.destroy(); upstream?.destroy(); reject(error); return; }
      const response = new Headers({ "cache-control": "no-store", "x-content-type-options": "nosniff" });
      for (const [key, value] of Object.entries(upstream!.headers)) if (responseHeaders.has(key) && value !== undefined) response.set(key, Array.isArray(value) ? value.join(", ") : value);
      // Redirects are reported, never followed across a service/project boundary.
      const location = upstream!.headers.location;
      if (location) {
        try {
          const redirected = new URL(location, "http://localhost:" + port + path);
          if (["localhost", "127.0.0.1", "[::1]"].includes(redirected.hostname) && Number(redirected.port || 80) === port) response.set("x-workbench-service-location", redirected.pathname + redirected.search);
        } catch { /* Invalid or external redirects stay unexposed. */ }
      }
      const status = upstream!.statusCode ?? 502;
      resolve(new Response(request.method === "HEAD" || [204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers: response }));
    };
    const abort = () => finish(request.signal?.reason ?? new Error("Service request cancelled"));
    const outgoing = requestLocalService({ port, path: target.pathname + target.search, method: request.method, headers }, response => {
      upstream = response;
      response.on("data", (chunk: Buffer) => {
        try {
          check(); bytes += chunk.length;
          if (bytes > MAX_RESPONSE) throw new HttpError(413, "service_proxy_size", "서비스 응답은 16 MiB 이하여야 합니다.");
          chunks.push(chunk);
        } catch (error) { finish(error); }
      });
      response.on("end", () => { try { check(); finish(); } catch (error) { finish(error); } });
      response.on("error", finish);
      response.on("aborted", () => finish(new HttpError(502, "service_proxy_closed", "서비스 응답이 중단되었습니다.")));
    });
    const watch = setInterval(() => { try { check(); } catch (error) { finish(error); } }, 250);
    const timeout = setTimeout(() => finish(new HttpError(504, "service_proxy_timeout", "서비스가 15초 안에 응답하지 않았습니다.")), 15_000);
    watch.unref(); timeout.unref();
    outgoing.on("error", error => finish(new HttpError(502, "service_proxy_unavailable", error.message)));
    request.signal?.addEventListener("abort", abort, { once: true });
    outgoing.end(request.body);
  });
}
