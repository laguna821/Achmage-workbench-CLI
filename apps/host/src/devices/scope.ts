import type { DeviceGrant, DevicePermission } from "@workbench/contracts";
import type { SequencedEvent, Snapshot } from "@workbench/contracts";
import type { SessionManager } from "../sessions.ts";
import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { HttpError } from "../errors.ts";
import type { RemoteMediaAccess } from "./media.ts";

const denied = () => new HttpError(403, "CAPABILITY_DENIED", "이 기기에 허용되지 않은 작업입니다.");
const missing = () => new HttpError(404, "remote_target_missing", "이 기기에서 볼 수 없는 작업입니다.");
/** The list folders a device sees: those holding its projects, the ones it made, and their parents. */
export function visibleFolders(source: Pick<Snapshot, "works" | "folders">, grant: DeviceGrant): Set<string> {
  const workIds = new Set(grant.workIds);
  const folderIds = new Set([...source.works.filter(x => workIds.has(x.id)).flatMap(x => x.folderId ? [x.folderId] : []), ...(grant.folderIds ?? [])]);
  for (let changed = true; changed;) {
    changed = false;
    for (const folder of source.folders) if (folderIds.has(folder.id) && folder.parentId && !folderIds.has(folder.parentId)) { folderIds.add(folder.parentId); changed = true; }
  }
  return folderIds;
}
export function scopedSnapshot(source: Snapshot, grant: DeviceGrant): Snapshot {
  const workIds = new Set(grant.workIds), works = source.works.filter(x => workIds.has(x.id));
  const sessions = source.sessions.filter(x => workIds.has(x.workId)), sessionIds = new Set(sessions.map(x => x.id));
  const artifacts = source.artifacts.filter(x => workIds.has(x.workId)), artifactIds = new Set(artifacts.map(x => x.id));
  const folderIds = visibleFolders(source, grant);
  const attention = source.attention?.events.filter(x => workIds.has(x.workId)) ?? [];
  // Removed documents follow the same scoping as live ones.
  const removedArtifacts = source.removedArtifacts?.filter(x => workIds.has(x.workId));
  return { ...source, works, sessions, artifacts, removedArtifacts, folders: source.folders.filter(x => folderIds.has(x.id)),
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
  const artifact = (id: string) => work(manager.documents.find(id)?.workId);
  switch (event.type) {
    case "item.delta": case "item.upserted": return session(event.sessionId) ? event : null;
    case "session.upserted": return work(event.session.workId) ? event : null;
    case "work.upserted": return work(event.work.id) ? event : null;
    case "work.removed": return work(event.workId) ? event : null;
    case "workspace.upserted": return work(event.workspace.workId) ? event : null;
    case "artifact.upserted": case "artifact.removed": return work(event.artifact.workId) ? event : null;
    case "artifact.purged": return work(event.workId) ? event : null;
    case "proposal.upserted": return artifact(event.proposal.artifactId) ? event : null;
    case "handoff.upserted": return session(event.handoff.sourceSessionId) && session(event.handoff.targetSessionId) ? event : null;
    case "link.upserted": return event.link.participants.every(session) ? event : null;
    case "office.note.ready": return artifact(event.artifactId) ? event : null;
    case "project.changed": return work(event.workId) ? event : null;
    case "schedules.changed": return { ...event, schedules: event.schedules.filter(x => session(x.sessionId)) };
    case "folder.upserted": return visibleFolders(manager.snapshot(), grant).has(event.folder.id) ? event : null;
    case "folder.removed": return (grant.folderIds ?? []).includes(event.folderId) ? event : null;
    case "attention.changed": case "provider.status": case "tools.status": return event;
    default: return null;
  }
}
/** `newWork`: 새 프로젝트 from the device — no project yet; the gateway admits it (see newWorkRequest) and adds the made project to that device's grant. */
/**
 * `newWork`: 새 프로젝트 from the device — no project yet; the gateway admits it (see newWorkRequest) and adds the made project to that device's grant.
 * `grantCheck`: a route of no single project (a list folder): the gateway checks the permission and this, in place of a project scope.
 * `body`: what is forwarded in place of the device's body (only the checked fields). `made: "folder"`: the made folder joins the grant.
 */
export type ScopedRoute = { permission: DevicePermission; workId?: string; newWork?: true; grantCheck?: (grant: DeviceGrant) => void; body?: Record<string, unknown>; made?: "folder";
  /** Heavy work on the PC (an upload, a conversion, an export, a folder made): counted per device (HEAVY_PER_MINUTE). */
  heavy?: true;
  /** The answer as the device may see it (a list cut to its projects). */
  filter?: (value: unknown, grant: DeviceGrant) => unknown };
const cut = (value: unknown, size = 80) => typeof value === "string" ? Array.from(value).slice(0, size).join("") : "";
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
  // The Hangul converter's choices (presets, templates by name): the same for every project.
  if (read && url.pathname === "/api/hangul-convert/choices") return { permission: "read" };
  if (read && ["/api/snapshot", "/api/protocol", "/api/tasks", "/api/host", "/api/attention", "/api/agent-profiles", "/api/tools", "/api/prefs"].includes(url.pathname)) return { permission: "read" };
  if (url.pathname === "/api/prefs" && method === "PUT") return { permission: "read" };
  // Skin 2 · B: a device's own screen layout (the gateway resolves it to `device:<its id>`).
  if (url.pathname === "/api/layouts/device" && (read || method === "PUT")) return { permission: "read" };
  if ((url.pathname === "/api/push" && read)
    || (url.pathname === "/api/push/subscription" && ["PUT", "DELETE"].includes(method))
    || (url.pathname === "/api/push/links/resolve" && method === "POST")) return { permission: "read" };
  // 모두 읽음: one call; the gateway answers it itself with the grant's projects (never forwarded unscoped).
  if (url.pathname === "/api/attention/read-all" && method === "POST") return { permission: "read" };
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
  // The conversations on the device's screen (A11): told as the device's own client, of its own projects only.
  if (url.pathname === "/api/sessions/on-screen" && method === "POST" && context) {
    if (!Array.isArray(body.ids)) throw denied();
    const grant = context.grant;
    const ids = body.ids.filter((id): id is string => typeof id === "string" && grant.workIds.includes(manager.view.sessions.get(id)?.workId ?? "")).slice(0, 200);
    return { permission: "read", body: { client: `device:${grant.deviceId}`, ids } };
  }
  if (parts[0] === "sessions" && parts[1]) {
    const workId = sessionWork(parts[1]);
    if (read && ["items", "commands", "worktree"].includes(action ?? "")) return { permission: "read", workId };
    if (method === "PATCH" && parts.length === 2) return { permission: "send", workId };
    if (method === "POST" && ["messages", "compact", "fork", "images"].includes(action ?? "")) return { permission: "send", workId };
    // 마크다운으로 내보내기: 작업 폴더에 저장 (a file in its project) or the text itself (복사, 내려받기); never a path of the PC's choosing.
    if (method === "POST" && action === "export" && parts.length === 3) {
      if (!["work", "text"].includes(String(body.target)) || Object.keys(body).some(key => key !== "target" && key !== "tools")) throw denied();
      return { permission: "send", workId, heavy: true };
    }
    if (method === "POST" && action === "interrupt") return { permission: "cancel", workId };
    if (method === "POST" && action === "approvals") return { permission: "approve", workId };
    if (action === "queue" && ["POST", "PATCH", "DELETE"].includes(method)) return { permission: method === "DELETE" ? "cancel" : "send", workId };
  }
  if (url.pathname === "/api/works" && method === "POST") return { permission: "send", newWork: true };
  // 목록에 새 폴더: a name, under no folder or one the device sees; the made folder joins the device's grant.
  if (url.pathname === "/api/folders" && method === "POST") {
    if (Object.keys(body).some(key => key !== "name" && key !== "parentId")) throw denied();
    const parentId = body.parentId ?? null;
    if (parentId !== null && typeof parentId !== "string") throw denied();
    return { permission: "send", made: "folder", body: { name: cut(body.name), parentId },
      grantCheck: grant => { if (parentId !== null && !visibleFolders(manager.snapshot(), grant).has(parentId)) throw denied(); } };
  }
  // 이름 바꾸기 of a list folder the device sees (its name only; moving, archiving or removing folders stays on the PC).
  if (parts[0] === "folders" && parts[1] && parts.length === 2 && method === "PATCH") {
    if (typeof body.name !== "string" || Object.keys(body).some(key => key !== "name")) throw denied();
    const folderId = parts[1];
    return { permission: "send", body: { name: cut(body.name) }, grantCheck: grant => { if (!visibleFolders(manager.snapshot(), grant).has(folderId)) throw denied(); } };
  }
  if (parts[0] === "works" && parts[1]) {
    if (!manager.view.works.has(parts[1])) throw missing();
    if (read && ["workspaces", "image"].includes(action ?? "")) return { permission: "read", workId: parts[1] };
    // A project the device holds: 이름 (title), 보관 (archived), 고정 (pinned), 태그 (tags), 순서 (sort) and 폴더로 옮기기
    // (folderId: no folder or one the device sees). Its active conversation and anything else stay as the PC set them.
    if (method === "PATCH" && parts.length === 2) {
      const allowed = ["title", "archived", "pinned", "tags", "sort", "folderId"];
      if (!Object.keys(body).length || Object.keys(body).some(key => !allowed.includes(key))) throw denied();
      if ("title" in body && typeof body.title !== "string") throw denied();
      if (("archived" in body && typeof body.archived !== "boolean") || ("pinned" in body && typeof body.pinned !== "boolean")) throw denied();
      if ("sort" in body && (typeof body.sort !== "number" || !Number.isFinite(body.sort))) throw denied();
      if ("tags" in body && (!Array.isArray(body.tags) || body.tags.length > 50 || body.tags.some(tag => typeof tag !== "string" || tag.length > 80))) throw denied();
      const folderId = body.folderId;
      if ("folderId" in body && folderId !== null && typeof folderId !== "string") throw denied();
      return { permission: "send", workId: parts[1], body: { ...body, ...("title" in body ? { title: cut(body.title) } : {}) },
        ...(typeof folderId === "string" ? { grantCheck: (grant: DeviceGrant) => { if (!visibleFolders(manager.snapshot(), grant).has(folderId)) throw denied(); } } : {}) };
    }
    // 새 문서 (the same kinds as the PC's): a blank file in that project's folder; the gateway checks the workspace/session belong to it.
    // 작업 폴더에서 열기 from a device: a file inside the project's folder, never a path elsewhere on the PC.
    // The host reads String(body.path): anything but a string (an array, an object) is refused, not stringified past the check.
    if (method === "POST" && action === "artifacts") {
      if (body.path !== undefined && typeof body.path !== "string") throw denied();
      if (typeof body.path === "string") insideProject(manager, parts[1], body.path, body);
    }
    if (method === "POST" && parts.length === 3 && ["sessions", "artifacts", "pages", "office-documents", "designs"].includes(action ?? "")) return { permission: "send", workId: parts[1] };
    // 불러오기 from a phone: a file's bytes into the project's own folder (the gateway caps the size: REMOTE_UPLOAD_LIMIT;
    // no other folder is passed on).
    if (method === "POST" && parts.length === 3 && action === "import-upload" && context) {
      const name = context.headers["x-file-name"], workspaceId = context.headers["x-workspace-id"];
      if (typeof name !== "string" || !name) throw denied();
      if (workspaceId !== undefined && manager.workspaces.get(workspaceId).workId !== parts[1]) throw denied();
      return { permission: "send", workId: parts[1], heavy: true };
    }
    // Markdown 변환 of a file of the project (an imported one, by the path the gateway gave): a NEW file beside it.
    if (method === "POST" && parts.length === 3 && action === "convert-to-markdown") {
      if (typeof body.path !== "string") throw denied();
      insideProject(manager, parts[1], body.path, body, true);
      return { permission: "send", workId: parts[1], heavy: true };
    }
  }
  // The project page: what every project shares is read (단계 choices, the properties template); the list of
  // projects' summaries is cut to the device's; 바뀐 파일 of a conversation is its project's. What changes every
  // project (단계 편집, 속성 템플릿, a property's kind, folder note templates, base export) stays on the PC.
  if (parts[0] === "projects") {
    if (read && url.pathname === "/api/projects/") return { permission: "read", filter: (value, grant) => Array.isArray(value) ? value.filter(entry => grant.workIds.includes((entry as { workId?: string }).workId ?? "")) : [] };
    if (read && parts.length === 2 && (parts[1] === "stages" || parts[1] === "template")) return { permission: "read" };
    if (read && parts.length === 2 && parts[1] === "changes") return { permission: "read", workId: sessionWork(url.searchParams.get("sessionId")) };
    if (parts[1] && !["stages", "template", "types", "changes", "folder-templates", "bases"].includes(parts[1])) {
      if (!manager.view.works.has(parts[1])) throw missing();
      // Its page, record and pictures (read); and its note's writes — 속성, 단계, 결정/질문, 노트 고치기, 되돌리기, 템플릿으로 만들기.
      if (read && (parts.length === 2 || (parts.length === 3 && ["events", "image"].includes(action ?? "")))) return { permission: "read", workId: parts[1] };
      if (method === "PUT" && parts.length === 3 && ["property", "stage", "body", "run", "source"].includes(action ?? "")) return { permission: "send", workId: parts[1] };
      if (method === "PUT" && parts.length === 4 && action === "entries") return { permission: "send", workId: parts[1] };
      if (method === "POST" && parts.length === 3 && ["entries", "revert", "undo", "initialize-note"].includes(action ?? "")) {
        // A decision or question may name the conversation it came from: one of the device's own projects only (the
        // note would carry that conversation's engine and title).
        if (action === "entries" && body.sessionId !== undefined && body.sessionId !== null) {
          if (typeof body.sessionId !== "string") throw denied();
          const from = sessionWork(body.sessionId);
          return { permission: "send", workId: parts[1], grantCheck: grant => { if (!grant.workIds.includes(from)) throw denied(); } };
        }
        return { permission: "send", workId: parts[1] };
      }
    }
  }
  if (parts[0] === "artifacts" && parts[1]) {
    const artifact = manager.documents.get(parts[1]); if (!artifact) throw missing();
    // office-pages / office-page: a Word or PowerPoint document's page pictures (its 쪽 보기 on a phone).
    if (read && ["text", "pages", "raw", "revisions", "asset", "office-pages", "office-page"].includes(action ?? "")) return { permission: "read", workId: artifact.workId };
    // Markdown 변환, 한글로 내보내기 (Markdown → HWPX, Word → Hangul in its two steps from the recorded revision) and
    // 변환해서 열기 of an old .doc/.ppt/.ods: each a NEW file beside the document, in its project.
    if (method === "POST" && parts.length === 3 && ["convert-to-markdown", "export-hangul", "open-converted", "word-to-hangul"].includes(action ?? "")) return { permission: "send", workId: artifact.workId, heavy: true };
    if (method === "POST" && parts.length === 4 && action === "word-to-hangul" && parts[3] === "commit") return { permission: "send", workId: artifact.workId };
    // 이름 바꾸기 (the file renamed in its folder, same extension) and 목록에서 빼기 (the file stays; never 휴지통 from a phone).
    if (method === "POST" && action === "rename" && parts.length === 3) {
      if (typeof body.name !== "string" || Object.keys(body).some(key => key !== "name")) throw denied();
      // A project may list a file it holds elsewhere (opened from the PC's desktop): a phone renames only files whose
      // real place is inside the project's own folders.
      inWorkFolders(manager, artifact.workId, artifact.path);
      return { permission: "send", workId: artifact.workId };
    }
    if (method === "POST" && action === "remove" && parts.length === 3) {
      if (body.action !== "unlisted" || Object.keys(body).some(key => key !== "action")) throw denied();
      return { permission: "send", workId: artifact.workId };
    }
    if (read && action === "removal" && parts.length === 3) return { permission: "read", workId: artifact.workId,
      filter: value => { const plan = value as { actions?: string[] }; return { ...plan, actions: (plan.actions ?? []).filter(entry => entry !== "trash") }; } };
    // A phone reads documents (DocumentView remoteReader): it never writes a document's text (PUT …/text stays on the PC).
    if (method === "POST" && action === "views") return { permission: "send", workId: artifact.workId };
  }
  if (parts[0] === "workspaces" && parts[1]) {
    const workspace = manager.workspaces.get(parts[1]); if (!workspace) throw missing();
    if (read && ["repository", "services", "terminals"].includes(action ?? "")) return { permission: "read", workId: workspace.workId };
    if (method === "POST" && ["terminals", "services"].includes(action ?? "") && parts.length === 3) return { permission: "terminal", workId: workspace.workId };
    // 프로젝트 폴더 안에 새 폴더: a relative path inside that workspace (the host refuses .., absolute paths and links leading out).
    if (method === "POST" && action === "directories" && parts.length === 3) {
      if (typeof body.path !== "string" || Object.keys(body).some(key => key !== "path")) throw denied();
      return { permission: "send", workId: workspace.workId, heavy: true };
    }
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
/**
 * 새 프로젝트 from a device: the PC's simplest path only — a name, made in the default projects folder.
 * No folder of the PC's disk is chosen from a phone (cwd), and the list folder, when given, must be one
 * the device already sees (a folder of one of its projects or that folder's parents).
 */
export function newWorkRequest(manager: SessionManager, grant: DeviceGrant, body: Record<string, unknown>) {
  // Checked before the PC makes anything: a project (and its folder) is never made for a device that cannot hold it.
  if (grant.workIds.length >= 256) throw new HttpError(409, "registry_limit", "이 기기에 허용한 프로젝트가 너무 많습니다. PC에서 정리해 주세요.");
  if (body.cwd !== undefined && body.cwd !== null) throw new HttpError(403, "remote_project_folder", "휴대폰에서는 PC의 기본 프로젝트 폴더에만 새 프로젝트를 만듭니다. 다른 폴더는 PC에서 고르세요.");
  if (body.folderId !== undefined && body.folderId !== null) {
    const seen = scopedSnapshot(manager.snapshot(), grant).folders.some(folder => folder.id === body.folderId);
    if (!seen) throw denied();
  }
  if (!grant.permissions.includes("send")) throw new HttpError(403, "permission_denied", "이 기기에 해당 권한이 없습니다.");
}
/**
 * 작업 폴더에서 열기 from a device: the file, with its links followed, lies inside the folder the host would open it in
 * (the workspace, the conversation's workspace or the project's own, as SessionManager.officeFileScope chooses).
 */
function insideProject(manager: SessionManager, workId: string, path: string, body: Record<string, unknown>, absolute = false) {
  const isAbsolute = path.startsWith("/");
  if ((isAbsolute && !absolute) || /^([\\]|[A-Za-z]:)/.test(path) || path.split(/[\\/]/).includes("..")) throw denied();
  const work = manager.view.works.get(workId); if (!work) throw missing();
  const session = typeof body.sessionId === "string" ? manager.view.sessions.get(body.sessionId) : undefined;
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : session?.workspaceId ?? work.defaultWorkspaceId;
  const space = workspaceId ? manager.workspaces.get(workspaceId) : undefined;
  if (space && space.workId !== workId) throw denied();
  const folder = space?.cwd ?? work.cwd;
  let root: string, target: string;
  try { root = realpathSync(folder); target = realpathSync(resolve(folder, path)); }
  catch { throw new HttpError(404, "file_missing", "파일이 없습니다."); }
  if (target !== root && !target.startsWith(root.endsWith(sep) ? root : root + sep)) throw denied();
}
/**
 * The file, links followed, lies inside its project's own folder or one of the app's workspaces of it (managed, or a
 * worktree). A folder of the PC the project only points at (a file opened from the desktop makes one) does not count.
 */
function inWorkFolders(manager: SessionManager, workId: string, path: string) {
  const work = manager.view.works.get(workId); if (!work) throw missing();
  const folders = [work.cwd, ...manager.snapshot().workspaces?.filter(space => space.workId === workId && !space.removedAt && (space.managed || space.worktree)).map(space => space.cwd) ?? []];
  let target: string;
  try { target = realpathSync(path); } catch { throw new HttpError(404, "file_missing", "파일이 없습니다."); }
  const inside = folders.some(folder => {
    try { const root = realpathSync(folder); return target.startsWith(root.endsWith(sep) ? root : root + sep); } catch { return false; }
  });
  if (!inside) throw new HttpError(403, "remote_outside_project", "프로젝트 폴더 밖에 있는 파일이라 휴대폰에서 이름을 바꾸지 않습니다. PC에서 바꾸세요.");
}
/** Validate cross-resource references before reusing the existing send handler. */
export function checkReferences(manager: SessionManager, grant: DeviceGrant, body: Record<string, unknown>) {
  for (const ref of Array.isArray(body.refs) ? body.refs : []) {
    const id = (ref as { artifactId?: string })?.artifactId;
    const artifact = typeof id === "string" ? manager.documents.get(id) : null;
    if (!artifact || !grant.workIds.includes(artifact.workId)) throw denied();
  }
}
