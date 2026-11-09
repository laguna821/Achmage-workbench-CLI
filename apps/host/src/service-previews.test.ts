import { createServer, request, type Server } from "node:http";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { expect, test } from "vitest";
import { ServicePreviews } from "./service-previews.ts";
import type { Store } from "./store.ts";
import type { WorkspaceServices } from "./workspace-services.ts";

async function listen(server: Server) {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No port");
  return address.port;
}
function http(port: number, host: string, path: string, headers: Record<string, string> = {}, body?: string) {
  return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const outgoing = request({ hostname: "127.0.0.1", port, path, method: body === undefined ? "GET" : "POST", headers: { ...headers, host } }, incoming => {
      const chunks: Buffer[] = []; incoming.on("data", chunk => chunks.push(chunk)); incoming.on("error", reject);
      incoming.on("end", () => resolve({ status: incoming.statusCode!, headers: incoming.headers, body: Buffer.concat(chunks).toString() }));
    }); outgoing.on("error", reject); outgoing.end(body);
  });
}

test("original proxy streams a separate-origin service and WebSocket, then revokes that execution", async () => {
  let upstreamCookie = "", owned = true;
  const upstream = createServer((req, res) => {
    upstreamCookie = req.headers.cookie ?? "";
    res.setHeader("content-type", "text/html"); res.setHeader("set-cookie", ["app=value; Domain=localhost; Path=/", "workbench_service_preview=forged; Path=/"]);
    res.end("<h1>live service</h1>" + req.url);
  });
  const sockets = new WebSocketServer({ server: upstream });
  sockets.on("connection", socket => socket.on("message", data => socket.send(data)));
  let previews: ServicePreviews | undefined, socket: WebSocket | undefined;
  const host = createServer((req, res) => { if (!previews?.handle(req, res, "local")) res.writeHead(404).end(); });
  host.on("upgrade", (req, client, head) => { if (!previews?.handleUpgrade(req, client, head, "local")) client.destroy(); });
  try {
    const upstreamPort = await listen(upstream), port = await listen(host);
    previews = new ServicePreviews({ store: { getMeta: () => null } as unknown as Store,
      services: { proxyTarget: () => ({ service: { workspaceId: "space", port: upstreamPort }, check: () => { if (!owned) throw new Error("Execution ended"); } }) } as unknown as WorkspaceServices,
      localOrigin: () => "http://127.0.0.1:" + port, remote: () => ({ enabled: false, appOrigin: null }) });
    const page = previews.create("service", "local", "local"), url = new URL(page.openUrl);
    expect((await http(port, url.host, "/")).status).toBe(403);
    expect((await http(port, url.host, url.pathname)).body).toContain("history.replaceState");
    const bootstrap = await http(port, url.host, url.pathname, { origin: url.origin, "content-type": "text/plain" }, url.hash.slice(1));
    expect(bootstrap.status).toBe(204);
    expect(bootstrap.headers["set-cookie"]?.[0]).toContain("HttpOnly");
    const cookie = bootstrap.headers["set-cookie"]![0]!.split(";")[0]!;
    const response = await http(port, url.host, "/assets/page?x=1", { cookie: cookie + "; app=mine" });
    expect(response.status).toBe(200); expect(response.body).toBe("<h1>live service</h1>/assets/page?x=1");
    expect(upstreamCookie).toBe("app=mine"); expect(response.headers["set-cookie"]).toEqual(["app=value; Path=/"]);
    expect((await http(port, url.host, "/", { cookie, origin: "https://another.example" })).status).toBe(403);
    socket = new WebSocket("ws://127.0.0.1:" + port + "/hmr", { headers: { host: url.host, origin: url.origin, cookie } });
    await once(socket, "open"); const reply = once(socket, "message"); socket.send("live update");
    expect(String((await reply)[0])).toBe("live update");
    const closed = once(socket, "close"); owned = false; await closed;
    expect((await http(port, url.host, "/", { cookie })).status).toBe(403);
  } finally {
    previews?.close(); socket?.terminate();
    for (const client of sockets.clients) client.terminate(); sockets.close();
    host.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => host.close(() => resolve())), new Promise<void>(resolve => upstream.close(() => resolve()))]);
  }
}, 10_000);
