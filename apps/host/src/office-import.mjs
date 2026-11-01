import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { normalizeAiSettings, mapAiSecrets } from "../../../vendor/ieumoffice/packages/ai-provider/src/index.ts";
import { revealedSecretsOf } from "../../../vendor/ieumoffice/packages/cli/src/secrets.ts";
import { revealRequestOf } from "../../../vendor/ieumoffice/apps/shell/src/main/ai-secrets.ts";
import { USER_DATA_DIR_NAME } from "../../../vendor/ieumoffice/packages/i18n/src/product.ts";
import { OfficeSettings } from "./office-settings.mjs";
import { OfficeVault } from "./office-vault.ts";
import { OfficeStyles, officeStyleData } from "./office-styles.ts";
import { HttpError } from "./errors.ts";
import { sandboxWrapper } from "./ieumoffice.ts";
import { OfficePreferences, importedOfficePreferences } from "./office-preferences.ts";
import { OfficeMarkdown, importedMarkdownSettings } from "./office-markdown.mjs";

const fail = (message, status = 400) => new HttpError(status, "office_import", message);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const object = value => value && typeof value === "object" && !Array.isArray(value);
function read(file, limit = 2_000_000) {
  if (!existsSync(file)) return null;
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw fail("설정 파일이 링크이거나 너무 큽니다. 원본을 보존했습니다.");
  const bytes = readFileSync(file); if (bytes.length > limit) throw fail("설정 파일이 너무 큽니다.");
  let value; try { value = JSON.parse(bytes.toString("utf8")); } catch { throw fail("설정 JSON을 읽지 못했습니다. 원본을 보존했습니다."); }
  if (!object(value)) throw fail("설정은 JSON 객체여야 합니다.");
  return { value, digest: hash(bytes), file };
}
export function ieumSettingsDirectory(platform = process.platform, env = process.env, home = homedir()) {
  const base = platform === "win32" ? env.APPDATA || join(home, "AppData", "Roaming") : platform === "darwin" ? join(home, "Library", "Application Support") : env.XDG_CONFIG_HOME || join(home, ".config");
  return join(base, USER_DATA_DIR_NAME);
}
/** One explicit import, original reveal protocol, no secret in arguments or diagnostics. */
export async function revealIeumSecrets(app, directory, values, signal) {
  const input = JSON.stringify(values);
  if (!app || !revealRequestOf(input)) throw fail("봉인 키를 읽으려면 공식 이음오피스 앱을 연결해 주세요. 키를 제외하고 가져올 수도 있습니다.");
  const env = { ...process.env, GENOFFICE_USER_DATA: directory };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const output = await new Promise((done, reject) => {
    const child = execFile(app, ["--reveal-ai-secrets"], { env, encoding: "utf8", timeout: 30_000, maxBuffer: 2_000_000, windowsHide: true, signal }, (error, stdout) => {
      if (error) reject(fail("이음오피스에서 보관된 키를 읽지 못했습니다. 앱 연결과 보안 저장소 잠금을 확인해 주세요.", 409));
      else done(stdout);
    });
    child.stdin.on("error", () => {}); child.stdin.end(input);
  });
  const opened = revealedSecretsOf(output);
  if (values.some(value => typeof opened[value] !== "string" || !opened[value] || opened[value].startsWith("sealed:v1:") || opened[value].length > 200_000)) throw fail("이 PC에서 풀 수 없는 키가 있습니다. 원본과 현재 설정을 보존했습니다. 키를 제외하고 가져오거나 키를 다시 입력해 주세요.", 409);
  return opened;
}

/** Plans contain source data only in memory; renderer gets names/counts, never keys. */
export class OfficeImport {
  constructor(documents, desktop, dataDir, injected = {}) {
    this.desktop = desktop; this.dataDir = dataDir; this.plans = new Map(); this.queue = Promise.resolve(); this.closed = false;
    this.vault = injected.vault ?? new OfficeVault(dataDir); this.settings = new OfficeSettings(dataDir, this.vault);
    this.preferences = new OfficePreferences(dataDir);
    this.markdown = new OfficeMarkdown(dataDir, { vault: this.vault });
    this.styles = new OfficeStyles(documents, null); this.open = injected.reveal ?? revealIeumSecrets;
    this.defaultDirectory = injected.defaultDirectory ?? ieumSettingsDirectory();
  }
  sources() { return { directory: this.defaultDirectory, exists: existsSync(this.defaultDirectory), appAvailable: Boolean(this.desktop.find()?.app) }; }
  inspect(directory) {
    if (typeof directory !== "string" || !directory.trim() || directory.length > 4096) throw fail("이음오피스 데이터 폴더를 선택해 주세요.");
    directory = resolve(directory);
    if (!existsSync(directory) || !lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw fail("데이터 폴더를 찾지 못했거나 링크입니다.");
    directory = realpathSync(directory);
    const files = [], refs = new Map(), aiFile = read(join(directory, "ai-settings.json")), warnings = [];
    const appFile = read(join(directory, "app-settings.json"));
    const appPreferences = importedOfficePreferences(appFile?.value);
    const hasPreferences = Object.keys(appPreferences).length > 0;
    if (hasPreferences) files.push(appFile);
    const markdownFile = read(join(directory, "markdown-settings.json"));
    const markdown = importedMarkdownSettings(markdownFile?.value), hasMarkdown = Object.keys(markdown.patch).length > 0;
    warnings.push(...markdown.warnings); if (hasMarkdown) files.push(markdownFile);
    let ai = null;
    if (aiFile) {
      files.push(aiFile);
      const mask = value => { if (!value) return ""; const token = `__wb_import_${randomUUID()}__`; refs.set(token, value); return token; };
      const masked = mapAiSecrets(aiFile.value, mask);
      if (typeof masked.apiKey === "string") masked.apiKey = mask(masked.apiKey);
      ai = normalizeAiSettings(masked);
    }
    const folder = join(directory, "style-templates"), candidates = [], planned = new Set();
    if (existsSync(folder)) {
      if (!lstatSync(folder).isDirectory() || lstatSync(folder).isSymbolicLink()) throw fail("스타일 폴더가 링크이거나 폴더가 아닙니다.");
      const names = readdirSync(folder).filter(name => name.endsWith(".json")).sort();
      if (names.length > 500) throw fail("스타일이 500개를 넘습니다. 가져올 스타일을 나눠 선택해 주세요.");
      let total = 0;
      for (const file of names) {
        let source;
        try {
          source = read(join(folder, file)); if (!source) throw fail("파일이 변경되었습니다.");
          total += JSON.stringify(source.value).length; if (total > 25_000_000) throw fail("스타일 전체 크기가 너무 큽니다.");
          const data = officeStyleData(source.value), name = typeof data.name === "string" ? data.name : file.slice(0, -5);
          let targetName = name, previous = this.styles.inspectSaved(name);
          let same = previous && JSON.stringify(previous.data) === JSON.stringify(data);
          let n = 1;
          while ((!same && previous) || planned.has(targetName)) {
            targetName = `${name.slice(0, 104)} (가져옴 ${n++})`; previous = this.styles.inspectSaved(targetName);
            same = previous && JSON.stringify(previous.data) === JSON.stringify(data);
          }
          planned.add(targetName); files.push(source);
          candidates.push({ name, targetName, data, same: Boolean(same), expectedRevision: previous?.revision ?? null });
        } catch (error) { warnings.push(`${file}: ${error instanceof HttpError ? error.message : "스타일 형식을 읽지 못했습니다."}`); }
      }
    }
    if (!ai && !candidates.length && !hasPreferences && !hasMarkdown) throw fail("가져올 AI 설정·문서 표시 설정·Markdown 설정·저장 스타일을 찾지 못했습니다.");
    const used = new Set(); if (ai) mapAiSecrets(ai, value => { if (value) used.add(value); return value; });
    const keys = [...used].map(ref => refs.get(ref)).filter(Boolean), target = this.settings.snapshot(), id = randomUUID();
    const plan = { id, at: Date.now(), directory, files, ai, refs, styles: candidates, targetRevision: target.revision, targetExists: existsSync(this.settings.path), appPreferences,
      preferenceRevision: hasPreferences ? this.preferences.snapshot().revision : null, markdownPatch: markdown.patch,
      markdownRevision: hasMarkdown ? this.markdown.snapshot().revision : null, result: null };
    for (const [key, value] of this.plans) if (Date.now() - value.at > 3_600_000) this.plans.delete(key);
    if (this.plans.size >= 8) this.plans.delete(this.plans.keys().next().value);
    this.plans.set(id, plan);
    return { id, directory, appAvailable: Boolean(this.desktop.find()?.app), ai: ai ? { provider: ai.provider, keys: keys.length, sealedKeys: keys.filter(value => value.startsWith("sealed:v1:")).length, replacesCurrent: plan.targetExists } : null,
      preferences: hasPreferences ? { fields: Object.keys(appPreferences), replacesCurrent: existsSync(this.preferences.path) } : null,
      ...(hasMarkdown ? { markdown: { theme: markdown.patch.markdownTheme ?? null, imageHost: Object.hasOwn(markdown.patch, "imageHost") ? { kind: markdown.patch.imageHost?.kind ?? null } : null, replacesCurrent: existsSync(this.markdown.path) } } : {}),
      styles: candidates.map(({ name, targetName, same }) => ({ name, targetName, same })), warnings };
  }
  assertPlan(plan, choice) {
    if (this.closed) throw fail("앱을 종료하고 있습니다.", 503);
    for (const source of plan.files) if (read(source.file)?.digest !== source.digest) throw fail("원본 설정이나 스타일이 변경되었습니다. 미리보기를 다시 열어 주세요.", 409);
    if (choice.ai && this.settings.snapshot().revision !== plan.targetRevision) throw fail("Workbench AI 설정이 변경되었습니다. 미리보기를 다시 열어 주세요.", 409);
    if (choice.preferences && this.preferences.snapshot().revision !== plan.preferenceRevision) throw fail("Workbench 문서 표시 설정이 변경되었습니다. 미리보기를 다시 열어 주세요.", 409);
    if ((choice.markdownTheme || choice.imageHost) && this.markdown.snapshot().revision !== plan.markdownRevision) throw fail("Workbench Markdown 설정이 변경되었습니다. 미리보기를 다시 열어 주세요.", 409);
    if (choice.styles) for (const style of plan.styles) if ((this.styles.inspectSaved(style.targetName)?.revision ?? null) !== style.expectedRevision) throw fail("Workbench 스타일이 변경되었습니다. 미리보기를 다시 열어 주세요.", 409);
  }
  apply(choice, signal) {
    const next = this.queue.then(() => this.perform(choice, signal)); this.queue = next.catch(() => {}); return next;
  }
  async perform(choice, signal) {
    if (!object(choice) || typeof choice.id !== "string" || [choice.ai, choice.keys, choice.styles].some(value => typeof value !== "boolean") || [choice.preferences, choice.markdownTheme, choice.imageHost].some(value => value !== undefined && typeof value !== "boolean") || !choice.ai && !choice.styles && !choice.preferences && !choice.markdownTheme && !choice.imageHost) throw fail("가져올 항목을 선택해 주세요.");
    const plan = this.plans.get(choice.id);
    if (!plan || Date.now() - plan.at > 3_600_000) throw fail("가져오기 미리보기가 만료되었습니다. 다시 확인해 주세요.", 409);
    if (plan.result) return plan.result;
    if (choice.ai && !plan.ai) throw fail("선택한 폴더에 AI 설정이 없습니다.");
    if (choice.preferences && !plan.preferenceRevision) throw fail("선택한 폴더에 문서 표시 설정이 없습니다.");
    if (choice.markdownTheme && !Object.hasOwn(plan.markdownPatch, "markdownTheme") || choice.imageHost && !Object.hasOwn(plan.markdownPatch, "imageHost")) throw fail("선택한 폴더에 가져올 Markdown 설정이 없습니다.");
    signal?.throwIfAborted(); this.assertPlan(plan, choice);
    const result = { ai: false, styles: 0, skipped: 0, backup: null, preferences: false, preferenceBackup: null, errors: [] };
    if (choice.ai) {
      const needed = new Set(); mapAiSecrets(plan.ai, value => { if (value) needed.add(plan.refs.get(value)); return value; });
      const legacy = [...needed].filter(value => typeof value === "string" && value.startsWith("sealed:v1:"));
      const app = this.desktop.find()?.app;
      const launcher = choice.keys && legacy.length && app ? sandboxWrapper(app, this.dataDir) ?? app : app;
      const opened = choice.keys && legacy.length ? await this.open(launcher, plan.directory, legacy, signal) : {};
      const next = mapAiSecrets(plan.ai, value => {
        if (!value || !choice.keys) return "";
        const raw = plan.refs.get(value); if (raw === undefined) throw fail("키 참조를 확인하지 못했습니다.");
        const plain = raw.startsWith("sealed:v1:") ? opened[raw] : raw;
        if (typeof plain !== "string" || !plain || plain.startsWith("sealed:v1:")) throw fail("보관된 키를 읽지 못했습니다.", 409);
        return plain;
      });
      // A different application's login consent is not this app's current consent.
      next.meteredAccepted = {}; next.headlessSubscriptionEnabled = false; next.headlessSubscriptionConsentVersion = 0;
      const backupDir = join(this.dataDir, "office", "imports", plan.id);
      if (existsSync(this.settings.path)) {
        const raw = readFileSync(this.settings.path), chunks = [];
        for (let offset = 0; offset < raw.length; offset += 6000) chunks.push(await this.vault.seal(raw.subarray(offset, offset + 6000).toString("base64")));
        signal?.throwIfAborted(); this.assertPlan(plan, choice);
        mkdirSync(backupDir, { recursive: true, mode: 0o700 }); result.backup = join(backupDir, "previous-settings.sealed.json");
        if (!existsSync(result.backup)) writeFileSync(result.backup, JSON.stringify({ version: 1, encoding: "base64", sha256: hash(raw), chunks }), { flag: "wx", mode: 0o600 });
        else if (read(result.backup, 5_000_000)?.value.sha256 !== hash(raw)) throw fail("이전 설정 백업이 바뀌었습니다. 새 미리보기로 확인해 주세요.", 409);
      }
      await this.settings.write(next, plan.targetRevision, { signal, beforeCommit: () => this.assertPlan(plan, choice) }); result.ai = true;
    }
    if (choice.preferences) {
      try {
        const saved = this.preferences.write(plan.appPreferences, plan.preferenceRevision, true);
        result.preferences = true; result.preferenceBackup = saved.backup;
      } catch { result.errors.push("문서 표시 설정을 저장하지 못했습니다. 현재 설정을 보존했습니다."); }
    }
    if (choice.markdownTheme || choice.imageHost) {
      try {
        const patch = { ...(choice.markdownTheme ? { markdownTheme: plan.markdownPatch.markdownTheme } : {}), ...(choice.imageHost ? { imageHost: plan.markdownPatch.imageHost } : {}) };
        const saved = await this.markdown.write(patch, plan.markdownRevision, { backup: true, signal,
          beforeCommit: () => this.assertPlan(plan, { markdownTheme: choice.markdownTheme, imageHost: choice.imageHost }) });
        result.markdownTheme = choice.markdownTheme === true; result.imageHost = choice.imageHost === true; result.markdownBackup = saved.backup;
      } catch { result.errors.push("Markdown 설정을 저장하지 못했습니다. 현재 설정을 보존했습니다."); }
    }
    // Report any partial filesystem failure truthfully; successful items are never replayed.
    if (choice.styles) for (const style of plan.styles) {
      if (style.same) { result.skipped++; continue; }
      try { this.styles.saveImported(style.targetName, style.data, style.expectedRevision); result.styles++; }
      catch { result.errors.push(`${style.targetName}: 저장하지 못했습니다. 현재 파일을 보존했습니다.`); }
    }
    plan.result = result; plan.refs.clear(); plan.ai = null; plan.files = []; plan.styles = []; plan.appPreferences = {}; plan.markdownPatch = {};
    return result;
  }
  close() { this.closed = true; this.plans.clear(); this.markdown.close(); this.settings.close(); }
}
