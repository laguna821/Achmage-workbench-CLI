import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Artifact, Attachment, TranscriptItem } from "@workbench/contracts";

// Files both ways: what a turn made goes back to the chat as attachments, and what may hold a
// secret never does. The block list is by name and by place; it is applied to the real file (its
// resolved path), whatever name a link or a copy gives it.

export type OutFile = { path: string; name: string; mime: string; caption?: string };

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".md": "text/markdown", ".txt": "text/plain", ".csv": "text/csv", ".json": "application/json", ".html": "text/html",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".hwpx": "application/hwp+zip", ".hwp": "application/x-hwp", ".zip": "application/zip",
};
export const mimeOf = (name: string) => MIME[extname(name).toLowerCase()] ?? "application/octet-stream";

/** File names that commonly hold keys, tokens or passwords. */
const SECRET_NAMES: RegExp[] = [
  /^\.env(\..+)?$/i, /\.env$/i, /^\.envrc$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|kdb|asc|gpg|ppk|ovpn)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/i,
  /^\.(netrc|npmrc|pypirc|pgpass|git-credentials|htpasswd|boto|s3cfg)$/i, /^_netrc$/i,
  /^(credentials|secrets?)(\.(json|ya?ml|toml|ini|txt|env))?$/i,
  /^(client_secret.*|service[-_]account.*)\.json$/i,
  /^\.claude\.json$/i, /^\.mcp\.json$/i, /^\.yarnrc\.yml$/i, /^\.vault-token$/i, /^rclone\.conf$/i,
  /^login data( for account)?$/i, /^logins\.json$/i, /^key[34]\.db$/i, /^cookies(\.sqlite)?$/i,
];
/** A file that is a secret only in its place: gh's login under its config folder. */
const SECRET_PLACES: RegExp[] = [/(^|\/)gh\/hosts\.yml$/i];
/** Folders whose content is credentials (a key store, a cloud login, a keyring). */
const SECRET_FOLDERS = [".ssh", ".aws", ".gnupg", ".kube", ".docker", ".password-store", "keyrings", ".azure", "gcloud", ".claude", ".codex"].map((name) => name.toLowerCase());

export type BlockRules = {
  /** The app's own data folder: nothing in it is sent, except the folders listed in `allowed` (the managed project folders, attachments). */
  dataDir: string | null;
  allowed: string[];
};

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const real = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };

/**
 * Why a file must not go to the chat, or null. `name` is how the file would be called there; the
 * place is read from the real file (a link to `~/.ssh/id_rsa` named `notes.txt` is still a key).
 */
export function blockedReason(path: string, name: string, rules: BlockRules): string | null {
  const actual = real(path);
  const names = [basename(name), basename(path), basename(actual)];
  if (names.some((entry) => SECRET_NAMES.some((pattern) => pattern.test(entry)))) return "secret-name";
  // Folder names regardless of case (a file system may not tell .SSH from .ssh).
  const parts = actual.split(sep).map((part) => part.toLowerCase());
  if (parts.some((part) => SECRET_FOLDERS.includes(part))) return "secret-folder";
  if ([actual, path].some((entry) => SECRET_PLACES.some((pattern) => pattern.test(entry.split(sep).join("/"))))) return "secret-name";
  if (rules.dataDir) {
    const data = real(rules.dataDir);
    if (inside(data, actual) && !rules.allowed.some((folder) => inside(real(folder), actual))) return "app-data";
  }
  return null;
}

/** `파일: <경로>` lines of an answer (the phone preamble asks the engine to name what it made this way). */
export function namedFiles(answer: string): string[] {
  const found: string[] = [];
  for (const line of answer.split(/\r?\n/)) {
    const match = /^\s*(?:[-*·•]\s*)?(?:첨부\s*)?파일\s*[:：]\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const value = match[1]!.replace(/^[`「『"']+|[`」』"']+$/g, "").trim();
    if (value) found.push(value);
  }
  return found;
}

export type TurnFiles = { files: (OutFile & { real: string; artifact?: Artifact; revision?: number })[]; blocked: string[]; outside: string[] };

export type TurnSources = {
  artifact(id: string): Artifact | null;
  revisionPath(id: string, revision: number): string;
  attachmentPath(id: string): string | null;
};

/**
 * What a turn made, as files for the chat: documents the turn created or changed (the exact
 * revision it wrote), pictures its steps produced or the answer showed, and files the answer
 * named with `파일:` that are inside the conversation's folder and were changed during the turn.
 * Each real file once.
 */
export function turnFiles(items: TranscriptItem[], answer: string, cwd: string, startedAt: number, sources: TurnSources, rules: BlockRules): TurnFiles {
  const out: TurnFiles = { files: [], blocked: [], outside: [] };
  const seen = new Set<string>();
  const add = (path: string, name: string, check: string, artifact?: { artifact: Artifact; revision: number }) => {
    if (!existsSync(path)) return;
    const key = real(check);
    if (seen.has(key)) return;
    seen.add(key);
    if (blockedReason(check, name, rules)) return void out.blocked.push(name);
    out.files.push({ path, name, mime: mimeOf(name), real: key, ...(artifact ? artifact : {}) });
  };
  const attachment = (entry: Attachment) => {
    const path = sources.attachmentPath(entry.id);
    if (path) add(path, entry.name, path);
  };
  // A document written twice in the turn goes as its latest revision.
  const latest = new Map<string, number>();
  for (const item of items) if (item.kind === "artifact") latest.set(item.artifactId, Math.max(latest.get(item.artifactId) ?? 0, item.revision));
  for (const item of items) {
    if (item.kind === "artifact") {
      const artifact = sources.artifact(item.artifactId);
      if (artifact && !artifact.removed && latest.get(item.artifactId) === item.revision) add(sources.revisionPath(artifact.id, item.revision), artifact.name, artifact.path, { artifact, revision: item.revision });
    } else if (item.kind === "tool") for (const image of item.images ?? []) attachment(image);
    else if (item.kind === "assistant") for (const media of item.media ?? []) attachment(media.attachment);
    else if (item.kind === "image" && item.image.status === "done" && item.image.path) add(item.image.path, basename(item.image.path), item.image.path);
  }
  const root = real(cwd);
  for (const named of namedFiles(answer)) {
    const path = isAbsolute(named) ? named : join(cwd, named);
    if (!existsSync(path)) continue;
    let stat;
    try { stat = statSync(path); } catch { continue; }
    if (!stat.isFile()) continue;
    // A secret is named as one, wherever it is.
    if (blockedReason(path, basename(path), rules)) { if (!seen.has(real(path))) { seen.add(real(path)); out.blocked.push(basename(path)); } continue; }
    if (!inside(root, real(path))) { if (!seen.has(real(path))) out.outside.push(basename(path)); continue; }
    if (stat.mtimeMs < startedAt - 2_000) continue;
    add(path, basename(path), path);
  }
  return out;
}

/** A document format the chat gets a first-page picture of. */
export const previewed = (artifact: Pick<Artifact, "format">) => ["docx", "pptx", "xlsx", "hwpx", "hwp"].includes(artifact.format);
