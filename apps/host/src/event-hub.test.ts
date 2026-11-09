import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { Session, TranscriptItem, HubJournalEntry } from "@workbench/contracts";
import { Store } from "./store.ts";
import { EventBus } from "./bus.ts";
import { TaskService } from "./task-service.ts";
import type { SessionManager } from "./sessions.ts";
import { EventHub } from "./event-hub.ts";
import { verifySlack } from "./hub/slack.ts";
import { verifyDiscord } from "./hub/discord.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const secret = "fixture-only-signing-secret";
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "workbench-hub-")), store = new Store(join(dir, "state.sqlite")), bus = new EventBus();
  const session: Session = { id: "session", workId: "work", workspaceId: "space", hostId: "host", nativeSessionId: "native", provider: "codex",
    purpose: "대상 대화", purposeSource: "user", model: null, effort: null, engineModel: null, engineEffort: null, preview: null, previewAt: null,
    status: "idle", activity: null, lastError: null, pinned: false, sort: 0, archivedAt: null, seenAt: null,
    unread: false, queued: [], access: null, context: null, createdAt: 1, updatedAt: 1 };
  const items: TranscriptItem[] = [];
  const submit = vi.fn(async (input: { commandId: string; text: string }) => {
    items.push({ kind: "user", id: "user:" + input.commandId, text: input.text, at: Date.now() }); session.status = "running";
    return { duplicate: false, delivery: "turn" as const };
  });
  const tasks = new TaskService(store, bus, { sessions: () => [session], items: () => items, canSteer: () => false,
    stop: async () => {}, approve: async () => {}, cancelQueue() {}, sendQueue: async () => {}, submit });
  const manager = { tasks, view: { sessions: new Map([[session.id, session]]) }, snapshot: () => ({ hostId: "host" }),
    accessOf: (target: Session) => target.access ?? "ask",
    profiles: { list: () => [], get: () => { throw Error("unknown profile"); } },
    workspaces: { requireActive: (id: string, workId: string) => { if (id !== "space" || workId !== "work") throw Error("wrong workspace"); } },
    items: () => ({ items }) } as unknown as SessionManager;
  const options = { dataDir: dir, store, bus, manager, ingress: () => ({ enabled: true, url: "https://example.invalid/hub/events/" }) };
  const hub = new EventHub(options);
  const connector = hub.saveConnector({ kind: "github", name: "저장소", secret, enabled: true });
  const workflow = hub.saveWorkflow({ name: "이슈 검토", connectorId: connector.id, enabled: true, allowedSources: ["owner/repo"], eventTypes: ["issues"],
    hostId: "host", workspaceId: "space", sessionId: session.id, profileId: null, instructions: "이슈를 읽고 요약해 주세요.", minIntervalSeconds: 1, expiresAt: null });
  cleanups.push(() => { hub.close(); tasks.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const payload = (source = "owner/repo") => Buffer.from(JSON.stringify({ action: "opened", repository: { full_name: source }, issue: { body: "검토 자료" }, token: "must-not-enter-session" }));
  const headers = (bytes: Buffer, id = "delivery-one") => ({ "content-type": "application/json", "x-github-delivery": id, "x-github-event": "issues",
    "x-hub-signature-256": "sha256=" + createHmac("sha256", secret).update(bytes).digest("hex") });
  return { hub, store, bus, session, items, submit, tasks, options, connector, workflow, payload, headers };
}

test("signed HTTP ingress uses the durable session receipt, deduplicates changed delivery headers, and waits for the actual turn end", async () => {
  const f = fixture(); f.hub.start();
  const server = createServer((req, res) => { void f.hub.handleIngress(req, res); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address() as { port: number }, url = "http://127.0.0.1:" + address.port + "/hub/events/" + f.connector.id, body = f.payload();
  expect((await fetch(url, { method: "POST", headers: f.headers(body), body })).status).toBe(204);
  await tick();
  const delivery = f.hub.state().deliveries[0]!;
  expect(f.submit).toHaveBeenCalledTimes(1);
  expect(f.tasks.receipt(delivery.commandId!)?.status).toBe("completed");
  expect(delivery.state).toBe("running");
  expect(f.items[0]).toMatchObject({ text: expect.stringContaining("[redacted]") });
  expect(JSON.stringify(f.items)).not.toContain("must-not-enter-session");
  expect((await fetch(url, { method: "POST", headers: f.headers(body, "replayed-header"), body })).status).toBe(204);
  await tick(); expect(f.submit).toHaveBeenCalledTimes(1); expect(f.hub.state().deliveries).toHaveLength(1);
  f.hub.close(); const restored = new EventHub(f.options); restored.start(); cleanups.push(() => restored.close());
  expect(f.submit).toHaveBeenCalledTimes(1);
  const end: TranscriptItem = { kind: "turnEnd", id: "end", status: "completed", durationMs: 10, at: Date.now() };
  f.items.push(end); f.session.status = "idle"; f.bus.publish({ type: "item.upserted", sessionId: f.session.id, item: end }); await tick();
  expect(restored.state().deliveries[0]).toMatchObject({ state: "completed", resultRef: "user:" + delivery.commandId });
  const bad = Buffer.from(body.toString().replace("검토", "변조"));
  expect((await fetch(url, { method: "POST", headers: f.headers(body), body: bad })).status).toBe(401);
});

test("Slack checks raw signed bytes and replay time; Discord authenticates Webhook Events with Ed25519", () => {
  const now = Date.now(), timestamp = String(Math.floor(now / 1000));
  const slack = Buffer.from(JSON.stringify({ type: "event_callback", event_id: "ev1", team_id: "T1", event: { type: "message", channel: "C1", text: "안녕" } }));
  const slackHeaders = { "x-slack-request-timestamp": timestamp, "x-slack-signature": "v0=" + createHmac("sha256", secret).update(Buffer.concat([Buffer.from("v0:" + timestamp + ":"), slack])).digest("hex") };
  expect(verifySlack(slack, slackHeaders, secret, now).event).toMatchObject({ source: "T1/C1", eventType: "message" });
  expect(() => verifySlack(slack, slackHeaders, secret, now + 301_000)).toThrow(expect.objectContaining({ status: 401 }));
  expect(() => verifySlack(Buffer.concat([slack, Buffer.from(" ")]), slackHeaders, secret, now)).toThrow();
  const keys = generateKeyPairSync("ed25519"), publicKey = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
  const discord = Buffer.from(JSON.stringify({ version: 1, application_id: "app", type: 1, event: { type: "LOBBY_MESSAGE_CREATE", timestamp: new Date(now).toISOString(), data: { lobby_id: "lobby", content: "자료" } } }));
  const discordHeaders = { "x-signature-timestamp": timestamp, "x-signature-ed25519": sign(null, Buffer.concat([Buffer.from(timestamp), discord]), keys.privateKey).toString("hex") };
  expect(verifyDiscord(discord, discordHeaders, publicKey, now).event).toMatchObject({ source: "app/lobby", eventType: "LOBBY_MESSAGE_CREATE", deliveryId: expect.stringMatching(/^body-/) });
  expect(() => verifyDiscord(Buffer.concat([discord, Buffer.from(" ")]), discordHeaders, publicKey, now)).toThrow();
});

test("pause, source scope and uncertain interrupted dispatch cannot enqueue new work", async () => {
  const f = fixture();
  await f.hub.accept(f.connector.id, f.payload("foreign/repo"), f.headers(f.payload("foreign/repo")));
  expect(f.hub.state().deliveries[0]?.state).toBe("rejected");
  f.hub.pause(f.workflow.id, f.workflow.revision, true);
  const bytes = f.payload(); await f.hub.accept(f.connector.id, bytes, f.headers(bytes, "paused")); await tick(); expect(f.submit).not.toHaveBeenCalled();
  const old = f.hub.state().deliveries.find(d => d.deliveryId === "paused")!;
  const unknown: HubJournalEntry = { delivery: { ...old, id: "uncertain", deliveryId: "uncertain", payloadHash: "uncertain", state: "accepted", commandId: "hub.uncertain" },
    command: { commandId: "hub.uncertain", hostId: "host", workspaceId: "space", sessionId: "session", text: "do not send again" } };
  expect(f.store.insertHubDelivery(unknown)).toBe(true); expect(f.store.insertHubDelivery(unknown)).toBe(false);
  f.hub.start(); await tick(); expect(f.hub.reconcile("uncertain").state).toBe("outcome_unknown"); expect(f.submit).not.toHaveBeenCalled();
});
