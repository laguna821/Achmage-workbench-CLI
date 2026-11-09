import type { DeviceGrant, DevicePermission } from "@workbench/contracts";
import type { SequencedEvent, Snapshot } from "@workbench/contracts";
import type { SessionManager } from "../sessions.ts";
import { HttpError } from "../errors.ts";
import type { RemoteMediaAccess } from "./media.ts";

const denied = () => new HttpError(403, "CAPABILITY_DENIED", "이 기기에 허용되지 않은 작업입니다.");
const missing = () => new HttpError(404, "remote_target_missing", "이 기기에서 볼 수 없는 작업입니다.");
export function scopedSnapshot(source: Snapshot, grant: DeviceGrant): Snapshot {
  const workIds = new Set(grant.workIds), works = source.works.filter(x => workIds.has(x.id));
  const sessions = source.sessions.filter(x => workIds.has(x.workId)), sessionIds = new Set(sessions.map(x => x.id));
  const artifacts = source.artifacts.filter(x => workIds.has(x.workId)), artifactIds = new Set(artifacts.map(x => x.id));
  const folderIds = new Set(works.flatMap(x => x.folderId ? [x.folderId] : []));
  for (let changed = true; changed;) {
    changed = false;
    for (const folder of source.folders) if (folderIds.has(folder.id) && folder.parentId && !folderIds.has(folder.parentId)) { folderIds.add(folder.parentId); changed = true; }
  }
  const attention = source.attention?.events.filter(x => workIds.has(x.workId)) ?? [];
  return { ...source, works, sessions, artifacts, folders: source.folders.filter(x => folderIds.has(x.id)),
    workspaces: source.workspaces?.filter(x => workIds.has(x.workId)),
    proposals: source.proposals.filter(x => artifactIds.has(x.artifactId)),
    handoffs: source.handoffs.filter(x => sessionIds.has(x.sourceSessionId) && sessionIds.has(x.targetSessionId)),
    links: source.links.filter(x => x.participants.every(id => sessionIds.has(id))),
    schedules: source.schedules?.filter(x => sessionIds.has(x.sessionId)),
    attention: { events: attention, unread: attention.filter(x => !x.readAt).length },
    // Screen layouts belong to the connected device. Do not expose other project IDs in local prefs.
    prefs: {},
  };
}
export function scopedEvent(event: SequencedEvent, manager: SessionManager, grant: DeviceGrant): SequencedEvent | null {
  const work = (id: string | null | undefined) => !!id && grant.workIds.includes(id);
  const session = (id: string) => work(manager.view.sessions.get(id)?.workId);
  const artifact = (id: string) => work(manager.documents.get(id)?.workId);
  switch (event.type) {
    case "item.delta": case "item.upserted": return session(event.sessionId) ? event : null;
    case "session.upserted": return work(event.session.workId) ? event : null;
    case "work.upserted": return work(event.work.id) ? event : null;
    case "work.removed": return work(event.workId) ? event : null;
    case "workspace.upserted": return work(event.workspace.workId) ? event : null;
    case "artifact.upserted": return work(event.artifact.workId) ? event : null;
    case "proposal.upserted": return artifact(event.proposal.artifactId) ? event : null;
    case "handoff.upserted": return session(event.handoff.sourceSessionId) && session(event.handoff.targetSessionId) ? event : null;
    case "link.upserted": return event.link.participants.every(session) ? event : null;
    case "office.note.ready": return artifact(event.artifactId) ? event : null;
    case "project.changed": return work(event.workId) ? event : null;
    case "schedules.changed": return { ...event, schedules: event.schedules.filter(x => session(x.sessionId)) };
    case "attention.changed": case "provider.status": case "tools.status": return event;
    default: return null;
  }
}
export type ScopedRoute = { permission: DevicePermission; workId?: string };
/** Admit only existing routes whose resource identity is resolved by the host. */
export function scopedRoute(manager: SessionManager, method: string, path: string, body: Record<string, unknown>, context?: { grant: DeviceGrant; headers: Record<string, string>; media: RemoteMediaAccess; voice?: Pick<import("../voice.ts").VoiceService, "getCapture" | "speechSessionId"> }): ScopedRoute {
  const url = new URL(path, "http://workbench.invalid");
  if (url.origin !== "http://workbench.invalid" || !path.startsWith("/api/") || url.pathname !== path.split("?")[0] || /%2f|%5c|\\/i.test(url.pathname)) throw denied();
  const parts = url.pathname.slice(5).split("/").map(decodeURIComponent);
  const read = method === "GET", action = parts[2];
  const sessionWork = (id: unknown) => {
    const s = typeof id === "string" ? manager.view.sessions.get(id) : null;
    if (!s) throw missing(); return s.workId;
  };
  if (read && ["/api/snapshot", "/api/protocol", "/api/tasks", "/api/host", "/api/attention", "/api/agent-profiles", "/api/tools", "/api/prefs"].includes(url.pathname)) return { permission: "read" };
  if (url.pathname === "/api/prefs" && method === "PUT") return { permission: "read" };
  if ((url.pathname === "/api/push" && read)
    || (url.pathname === "/api/push/subscription" && ["PUT", "DELETE"].includes(method))
    || (url.pathname === "/api/push/links/resolve" && method === "POST")) return { permission: "read" };
  if (url.pathname === "/api/attention/presence" && method === "POST") return { permission: "read", ...(body.sessionId ? { workId: sessionWork(body.sessionId) } : {}) };
  if (parts[0] === "voice" && context?.voice) {
    if (read && parts.length === 1) return { permission: "read" };
    if (method === "POST" && parts.length === 2 && ["captures", "speech"].includes(parts[1]!)) return { permission: "send", workId: sessionWork(body.sessionId) };
    if (parts[1] === "captures" && parts[2] && ((read && parts.length === 3) || (method === "POST" && parts.length === 4 && ["chunks", "finish", "cancel"].includes(parts[3]!)))) {
      const capture = context.voice.getCapture(parts[2]);
      return { permission: read ? "read" : "send", workId: sessionWork(capture.state.sessionId) };
    }
    if (method === "POST" && parts[1] === "speech" && parts[2] && parts.length === 4 && parts[3] === "cancel") return { permission: "send", workId: sessionWork(context.voice.speechSessionId(parts[2])) };
    throw denied();
  }
  if (parts[0] === "attachments" && context) {
    if (method === "POST" && parts.length === 1) {
      const workId = context.headers["x-workbench-work"];
      if (!workId || !manager.view.works.has(workId)) throw denied();
      return { permission: "send", workId };
    }
    if (read && parts.length === 2) {
      const workId = context.media.workFor(context.grant, parts[1]!);
      if (!workId) throw denied();
      return { permission: "read", workId };
    }
  }
  if (parts[0] === "task-commands" && parts[1] && read) {
    const receipt = manager.tasks.receipt(parts[1]); if (!receipt) throw missing();
    return { permission: "read", workId: sessionWork(receipt.sessionId) };
  }
  if (url.pathname === "/api/task-commands" && method === "POST") {
    const target = body.target as { sessionId?: string; hostId?: string } | undefined;
    if (target?.hostId !== manager.snapshot().hostId) throw new HttpError(403, "HOST_SCOPE_MISMATCH", "요청한 호스트가 다릅니다.");
    return { permission: body.kind === "approve" ? "approve" : ["send_queue", "send", "steer", "background"].includes(String(body.kind)) ? "send" : "cancel", workId: sessionWork(target?.sessionId) };
  }
  if (url.pathname === "/api/tasks/native-refresh" && method === "POST") return { permission: "read", workId: sessionWork(body.sessionId) };
  if (url.pathname === "/api/tasks/native-history" && read) return { permission: "read", workId: sessionWork(url.searchParams.get("sessionId")) };
  if (url.pathname === "/api/automation/submit" && method === "POST") {
    if (body.hostId !== manager.snapshot().hostId) throw new HttpError(403, "HOST_SCOPE_MISMATCH", "요청한 호스트가 다릅니다.");
    return { permission: "send", workId: sessionWork(body.sessionId) };
  }
  if (parts[0] === "sessions" && parts[1]) {
    const workId = sessionWork(parts[1]);
    if (read && ["items", "commands", "worktree"].includes(action ?? "")) return { permission: "read", workId };
    if (method === "PATCH" && parts.length === 2) return { permission: "send", workId };
    if (method === "POST" && ["messages", "compact", "fork", "images"].includes(action ?? "")) return { permission: "send", workId };
    if (method === "POST" && action === "interrupt") return { permission: "cancel", workId };
    if (method === "POST" && action === "approvals") return { permission: "approve", workId };
    if (action === "queue" && ["POST", "PATCH", "DELETE"].includes(method)) return { permission: method === "DELETE" ? "cancel" : "send", workId };
  }
  if (parts[0] === "works" && parts[1]) {
    if (!manager.view.works.has(parts[1])) throw missing();
    if (read && ["workspaces", "image"].includes(action ?? "")) return { permission: "read", workId: parts[1] };
    if (method === "POST" && ["sessions", "artifacts", "pages"].includes(action ?? "")) return { permission: "send", workId: parts[1] };
  }
  if (parts[0] === "artifacts" && parts[1]) {
    const artifact = manager.documents.get(parts[1]); if (!artifact) throw missing();
    if (read && ["text", "pages", "raw", "revisions", "asset"].includes(action ?? "")) return { permission: "read", workId: artifact.workId };
    if ((method === "POST" && action === "views") || (method === "PUT" && action === "text")) return { permission: "send", workId: artifact.workId };
  }
  if (parts[0] === "workspaces" && parts[1]) {
    const workspace = manager.workspaces.get(parts[1]); if (!workspace) throw missing();
    if (read && ["repository", "services", "terminals"].includes(action ?? "")) return { permission: "read", workId: workspace.workId };
    if (method === "POST" && ["terminals", "services"].includes(action ?? "") && parts.length === 3) return { permission: "terminal", workId: workspace.workId };
  }
  if (parts[0] === "terminals" && parts[1]) {
    const terminal = manager.terminals.get(parts[1]);
    if ((read && (parts.length === 2 || (parts.length === 3 && ["replay", "search"].includes(action ?? "")))) || (method === "DELETE" && parts.length === 2) || (method === "POST" && ["input", "resize"].includes(action ?? ""))) return { permission: read ? "read" : "terminal", workId: terminal.workId };
  }
  if (parts[0] === "services" && parts[1]) {
    const service = manager.services.get(parts[1]);
    if ((parts.length === 3 && action === "preview" && method === "POST") || (parts.length === 4 && action === "preview" && method === "DELETE")) return { permission: "terminal", workId: service.workId };
    if (parts.length === 3 && read && action === "logs") return { permission: "read", workId: service.workId };
    if ((parts.length === 3 && action === "proxy") || (parts.length === 3 && action === "stop" && method === "POST") || (parts.length === 2 && method === "DELETE")) return { permission: "terminal", workId: service.workId };
  }
  if (parts[0] === "attention" && parts[1]) {
    const target = manager.notifications.target(parts[1]);
    if ((read && action === "target") || (method === "POST" && action === "read")) return { permission: "read", workId: target.workId };
  }
  throw denied();
}
/** Validate cross-resource references before reusing the existing send handler. */
export function checkReferences(manager: SessionManager, grant: DeviceGrant, body: Record<string, unknown>) {
  for (const ref of Array.isArray(body.refs) ? body.refs : []) {
    const id = (ref as { artifactId?: string })?.artifactId;
    const artifact = typeof id === "string" ? manager.documents.get(id) : null;
    if (!artifact || !grant.workIds.includes(artifact.workId)) throw denied();
  }
}
