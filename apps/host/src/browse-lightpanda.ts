import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { InstallStep } from "./browse-install.ts";

const exec = promisify(execFile);
export const LIGHTPANDA_VERSION = "1.0.2";
// Official immutable release assets and GitHub SHA-256 digests, verified 2026-10-31.
const BUILDS: Record<string, { name: string; sha256: string }> = {
  "linux-x64": { name: "lightpanda-x86_64-linux", sha256: "ae7d01d261efb9e480e18ce3424533332883863bcf70b12a4321b5733f37e19e" },
  "linux-arm64": { name: "lightpanda-aarch64-linux", sha256: "ac546dfc43c533430da92b75ab36f2a29da7d6324d5d38baf606ef2e0d849345" },
  "darwin-arm64": { name: "lightpanda-aarch64-macos", sha256: "9f3ee749a55d1abc5f8fdda0d9559c3b2abcec5bff5bfe902bc06c0a89538ec4" },
  "darwin-x64": { name: "lightpanda-x86_64-macos", sha256: "91a775ecc67937d8d79c1b1a315748e52157804f18f629c6e1c6332a46255fc6" },
};
export const lightpandaBuild = (platform: string = process.platform, arch = process.arch) => BUILDS[`${platform === "win32" ? "linux" : platform}-${arch}`] ?? null;
const env = () => {
  const value = { ...process.env, LIGHTPANDA_DISABLE_TELEMETRY: "true", LIGHTPANDA_DISABLE_CORE_DUMP: "1" };
  // Lightpanda expands LP_* placeholders; do not inherit credentials into page tools.
  for (const key of Object.keys(value)) if (key.startsWith("LP_")) delete (value as NodeJS.ProcessEnv)[key];
  return value;
};

export async function lightpandaLaunch(binary: string): Promise<{ command: string; args: string[] }> {
  if (process.platform !== "win32") return { command: binary, args: [] };
  try {
    const result = await exec("wsl.exe", ["--exec", "wslpath", "-a", "-u", binary], { timeout: 15000, windowsHide: true });
    const path = result.stdout.trim();
    if (!path.startsWith("/")) throw new Error("path");
    // env is set inside WSL too; Windows variables are not automatically inherited.
    return { command: "wsl.exe", args: ["--exec", "env", "LIGHTPANDA_DISABLE_TELEMETRY=true", "LIGHTPANDA_DISABLE_CORE_DUMP=1", path] };
  } catch { throw new Error("Lightpanda에는 실행 가능한 WSL2 Linux가 필요합니다. WSL2를 설정하거나 호환 브라우저를 선택하세요."); }
}

export class LightpandaInstall {
  readonly binary: string;
  readonly record: string;
  constructor(root: string) { this.binary = join(root, "lightpanda", "lightpanda"); this.record = join(root, "lightpanda", "install.json"); }
  ready() {
    try { const saved = JSON.parse(readFileSync(this.record, "utf8")); return saved.version === LIGHTPANDA_VERSION && saved.sha256 === lightpandaBuild()?.sha256 && existsSync(this.binary); }
    catch { return false; }
  }
  steps(): InstallStep[] {
    return [{ stage: "browser", message: "Lightpanda 받는 중…", run: async report => {
      const build = lightpandaBuild();
      if (!build) throw new Error("이 OS/CPU용 Lightpanda 배포 파일이 없습니다.");
      if (process.platform === "win32") await lightpandaLaunch(this.binary);
      mkdirSync(join(this.binary, ".."), { recursive: true, mode: 0o700 });
      const response = await fetch(`https://github.com/lightpanda-io/browser/releases/download/${LIGHTPANDA_VERSION}/${build.name}`, { signal: AbortSignal.timeout(180000) });
      if (!response.ok || !response.body) throw new Error(`Lightpanda 다운로드 HTTP ${response.status}`);
      const chunks: Buffer[] = []; let size = 0;
      const total = Number(response.headers.get("content-length"));
      const reader = response.body.getReader();
      for (;;) {
        const { value: chunk, done } = await reader.read(); if (done) break;
        size += chunk.length; if (size > 150 * 1024 * 1024) throw new Error("Lightpanda 배포 파일이 예상 크기를 넘었습니다.");
        chunks.push(Buffer.from(chunk)); report("Lightpanda 받는 중…", total ? Math.min(99, Math.floor(size / total * 100)) : null);
      }
      const bytes = Buffer.concat(chunks), digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== build.sha256) throw new Error("Lightpanda 배포 파일의 SHA-256이 일치하지 않습니다.");
      writeFileSync(`${this.binary}.tmp`, bytes, { mode: 0o755 }); chmodSync(`${this.binary}.tmp`, 0o755);
      renameSync(`${this.binary}.tmp`, this.binary);
    } }, { stage: "verify", message: "Lightpanda 실행 확인…", run: async () => {
      const launch = await lightpandaLaunch(this.binary);
      const { stdout } = await exec(launch.command, [...launch.args, "version"], { env: env(), timeout: 15000, windowsHide: true });
      if (stdout.trim() !== LIGHTPANDA_VERSION) { rmSync(this.record, { force: true }); throw new Error("Lightpanda 버전을 확인하지 못했습니다."); }
      writeFileSync(this.record, JSON.stringify({ version: LIGHTPANDA_VERSION, sha256: lightpandaBuild()!.sha256 }), { mode: 0o600 });
    } }];
  }
}

type Result = { content?: { type: string; text?: string }[]; isError?: boolean };
type Pending = { resolve: (result: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
/** One owned stdio MCP process per Workbench session; no listening port or shared cookies. */
class PandaSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private seq = 0;
  private buffer = "";
  private dead = false;
  private closing: Promise<void> | null = null;
  readonly ready: Promise<void>;
  cache: { key: string; text: string } | null = null;
  url: string | null = null;
  lastAt = Date.now();
  constructor(launch: { command: string; args: string[] }) {
    this.child = spawn(launch.command, [...launch.args, "mcp", "--http-timeout", "15000", "--http-max-response-size", "10485760", "--v8-max-heap-mb", "256"], { env: env(), stdio: "pipe", windowsHide: true });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > 4 * 1024 * 1024) { this.fail(new Error("Lightpanda 응답이 제한 크기를 넘었습니다.")); this.stop(); return; }
      let at: number;
      while ((at = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, at); this.buffer = this.buffer.slice(at + 1);
        try {
          const reply = JSON.parse(line), pending = this.pending.get(reply.id);
          if (!pending) continue;
          clearTimeout(pending.timer); this.pending.delete(reply.id);
          reply.error ? pending.reject(new Error(String(reply.error.message))) : pending.resolve(reply.result);
        } catch { this.fail(new Error("Lightpanda MCP 응답 형식 오류")); }
      }
    });
    this.child.stderr.resume();
    this.child.stdin.on("error", () => this.fail(new Error("Lightpanda 연결이 종료되었습니다.")));
    this.child.once("error", error => this.fail(error));
    this.child.once("exit", () => this.fail(new Error("Lightpanda가 종료되었습니다. 다시 열어 주세요.")));
    this.ready = this.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "achmage-workbench", version: "1" } }).then(() => {
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    });
  }
  get alive() { return !this.dead; }
  get busy() { return this.pending.size > 0; }
  private fail(error: Error) {
    this.dead = true;
    for (const value of this.pending.values()) { clearTimeout(value.timer); value.reject(error); }
    this.pending.clear();
  }
  private rpc(method: string, params: unknown): Promise<any> {
    if (this.dead) return Promise.reject(new Error("Lightpanda가 종료되었습니다."));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Lightpanda 요청 시간 초과")); this.stop(); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async call(name: string, args: Record<string, unknown> = {}) {
    await this.ready; this.lastAt = Date.now();
    const result: Result = await this.rpc("tools/call", { name, arguments: args });
    const text = (result.content ?? []).filter(part => part.type === "text").map(part => part.text ?? "").join("\n");
    if (result.isError) throw new Error(text.slice(0, 2000));
    return text;
  }
  async close() {
    if (this.closing) return this.closing;
    this.fail(new Error("브라우저 세션을 닫았습니다."));
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    this.closing = new Promise<void>((resolve, reject) => {
      // 1.0.2 finishes an in-flight navigation before processing EOF/normal SIGTERM.
      // Keep ownership until exit; sending the signal is not evidence of completion.
      const timer = setTimeout(() => { this.child.kill("SIGTERM"); }, 1500);
      const deadline = setTimeout(() => reject(new Error("Lightpanda 정상 종료가 지연되고 있습니다.")), 20000);
      this.child.once("exit", () => { clearTimeout(timer); clearTimeout(deadline); resolve(); });
    });
    return this.closing;
  }
  private stop() { void this.close().catch(() => console.error("[Lightpanda] normal shutdown is still pending")); }
}

export const LIGHTPANDA_HELP = "workbench-browser -s=<세션> <명령>\nopen/goto <URL>, search <검색어>, snapshot [노드번호], read [CSS선택자], find <이름>, links, extract <JSON선택자스키마>, click <노드번호|선택자>, fill <대상> <값>, press <키>, select <대상> <값>, wait <선택자>, close\n읽기 출력은 기본 12000자입니다. 같은 명령에 --offset=12000으로 이어 읽고 --limit=1000..16000으로 줄일 수 있습니다. 화면 검증은 호환 브라우저를 선택하세요.\n";
export class LightpandaBrowser {
  private readonly sessions = new Map<string, PandaSession>();
  private generation = 0;
  private readonly epochs = new Map<string, number>();
  private readonly closing = new Set<Promise<void>>();
  get busy() { return [...this.sessions.values()].some(session => session.busy); }
  private readonly idle: NodeJS.Timeout;
  constructor(privateBinary: string, idleMs = 30 * 60_000) {
    this.binary = privateBinary;
    this.idle = setInterval(() => { for (const [name, session] of this.sessions) if (!session.busy && Date.now() - session.lastAt > idleMs) this.stop(name); }, Math.min(idleMs, 60000));
    this.idle.unref();
  }
  private readonly binary: string;
  async command(name: string, args: string[]) {
    const [command, ...rest] = args;
    if (!command || args.includes("--help") || args.includes("-h")) return LIGHTPANDA_HELP;
    if (args.includes("--version")) return `Lightpanda ${LIGHTPANDA_VERSION}\n`;
    if (command === "close") { await this.close(name); return "백그라운드 브라우저 세션을 닫았습니다.\n"; }
    const positional = rest.filter(arg => !/^--(?:offset|limit)=/.test(arg));
    const number = (key: string, fallback: number) => { const raw = rest.find(arg => arg.startsWith(`--${key}=`)); const value = raw ? Number(raw.split("=")[1]) : fallback; if (!Number.isSafeInteger(value) || value < 0) throw new Error(`잘못된 ${key}`); return value; };
    const offset = number("offset", 0), limit = Math.max(1000, Math.min(16000, number("limit", 12000)));
    const target = (value: string | undefined) => {
      if (!value) throw new Error("대상 노드 번호나 선택자가 필요합니다.");
      return /^@?\d+$/.test(value) ? { backendNodeId: Number(value.replace("@", "")) } : { selector: value };
    };
    const [first, second] = positional;
    const read = ["snapshot", "read", "find", "links", "extract"].includes(command);
    const key = JSON.stringify([command, positional]);
    let session = this.sessions.get(name);
    if (!session?.alive) {
      if (offset) throw new Error("이어 읽을 결과가 없습니다. 처음부터 읽어 주세요.");
      const generation = this.generation;
      const epoch = this.epochs.get(name);
      const launch = await lightpandaLaunch(this.binary);
      if (generation !== this.generation || epoch !== this.epochs.get(name)) throw new Error("브라우저가 전환되거나 종료되었습니다.");
      session = new PandaSession(launch); this.sessions.set(name, session);
    }
    let text: string;
    if (offset) {
      if (!read || session.cache?.key !== key) throw new Error("같은 읽기 명령의 저장된 결과만 이어 읽을 수 있습니다.");
      text = session.cache.text;
    } else {
      switch (command) {
        case "open": case "goto": {
          const url = new URL(first && /^[a-z][a-z0-9+.-]*:/i.test(first) ? first : `https://${first ?? ""}`);
          if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("http/https 웹 주소가 필요합니다.");
          text = await session.call("goto", { url: url.href }); session.url = url.href; break;
        }
        case "search": if (!first) throw new Error("검색어가 필요합니다."); text = await session.call("search", { query: first }); break;
        case "snapshot": text = await session.call("tree", { maxDepth: 8, maxBytes: 64000, ...(first ? target(first) : {}) }); break;
        case "read": text = await session.call("markdown", { maxBytes: 128000, strip: { js: true, css: true, shell: true }, ...(first ? target(first) : {}) }); break;
        case "find": text = await session.call("findElement", { name: first ?? "" }); break;
        case "links": text = await session.call("links", { limit: 100 }); break;
        case "extract": JSON.parse(first ?? ""); text = await session.call("extract", { schema: first }); break;
        case "click": case "hover": text = await session.call(command, target(first)); break;
        case "fill": if (second === undefined) throw new Error("입력할 값이 필요합니다."); text = await session.call("fill", { ...target(first), value: second }); break;
        case "press": text = await session.call("press", { key: first }); break;
        case "select": text = await session.call("selectOption", { ...target(first), value: second }); break;
        case "wait": text = await session.call("waitForSelector", { selector: first, timeout: 10000 }); break;
        default: throw new Error(`Lightpanda에서 지원하지 않는 명령: ${command}. workbench-browser --help를 확인하세요. 화면·탭·파일 업로드는 호환 브라우저에서 사용할 수 있습니다.`);
      }
      if (["open", "goto", "search", "click", "press"].includes(command)) session.url = (await session.call("getUrl")).trim() || session.url;
      session.cache = read ? { key, text: text.slice(0, 256000) } : null;
    }
    session.lastAt = Date.now();
    const page = text.slice(offset, offset + limit), next = offset + page.length;
    return `- Browser: Lightpanda (background)\n${session.url ? `- Page URL: ${session.url}\n` : ""}${page}${next < Math.min(text.length, 256000) ? `\n[계속: 같은 명령에 --offset=${next}]` : ""}\n`;
  }
  async close(name: string) {
    this.epochs.set(name, (this.epochs.get(name) ?? 0) + 1);
    const session = this.sessions.get(name); this.sessions.delete(name);
    if (!session) return;
    const closing = session.close(); this.closing.add(closing);
    try { await closing; } finally { this.closing.delete(closing); }
  }
  stop(name: string) { void this.close(name).catch(() => console.error("[Lightpanda] normal shutdown is still pending")); }
  async closeAll() { this.generation++; await Promise.all([...this.sessions.keys()].map(name => this.close(name))); await Promise.all([...this.closing]); }
  async shutdown() { clearInterval(this.idle); await this.closeAll(); }
}
