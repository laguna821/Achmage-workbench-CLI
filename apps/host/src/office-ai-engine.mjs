// Node-only, original Ieum provider implementation. Keep its Electron-facing type graph out
// of the host project; the implementation is bundled from the reviewed vendor pin, unchanged.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  activeCustomEndpoint, localEndpointTimeoutMs, mapAiSecrets, maxOutputTokensOf,
  normalizeAiSettings, sanitizeAiSettings, streamForProvider, chatForProvider,
} from "../../../vendor/ieumoffice/packages/ai-provider/src/index.ts";
import { createSubscriptionStatusService } from "../../../vendor/ieumoffice/packages/ai-provider/src/subscription/service.ts";
import { createMeteredAcceptanceFileStore } from "../../../vendor/ieumoffice/packages/ai-provider/src/subscription/metered.ts";
import { listSubscriptionModels } from "../../../vendor/ieumoffice/packages/ai-provider/src/subscription/models.ts";
import { shutdownSubscriptionChildren } from "../../../vendor/ieumoffice/packages/ai-provider/src/subscription/process.ts";
import { shutdownCodexAppServers } from "../../../vendor/ieumoffice/packages/ai-provider/src/codex-app-server.ts";
import { resolveAiRun, aiStreamErrorChunk, aiChatFailure, subscriptionStreamCallbacks } from "../../../vendor/ieumoffice/apps/docs/src/main/ai-run.ts";
import { createChunkCoalescer } from "../../../vendor/ieumoffice/apps/docs/src/main/stream-coalesce.ts";
import { startFirstChunkKeepalive } from "../../../vendor/ieumoffice/apps/docs/src/main/ai-keepalive.ts";

export const OFFICE_SECRET_PLACEHOLDER = "__workbench_saved_secret__";
const texts = { noApiKey: () => "AI 제공자의 키를 설정해 주세요.", noModel: () => "사용할 AI 모델을 선택해 주세요." };
const publicSettings = (settings) => mapAiSecrets(settings, (value) => value ? OFFICE_SECRET_PLACEHOLDER : "");
const canonicalSettings = (settings) => JSON.stringify(normalizeAiSettings(sanitizeAiSettings(settings)), (_key, value) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value);

export function createOfficeAiEngine(dataDir, injected = {}) {
  const settingsPath = join(dataDir, "office", "ai-settings.json");
  let cachedText, cachedSettings;
  // Reading never migrates or rewrites either the original standalone settings or this file.
  // In particular, an unopened sealed:v1 key stays on disk and cannot become an API header.
  const readSettings = () => {
    if (!existsSync(settingsPath)) return normalizeAiSettings({});
    if (statSync(settingsPath).size > 2_000_000) throw new Error("Office AI 설정 파일이 너무 큽니다.");
    let raw;
    try { raw = readFileSync(settingsPath, "utf8"); }
    catch { throw new Error("Office AI 설정 파일을 읽지 못했습니다. 파일은 변경하지 않았습니다."); }
    if (Buffer.byteLength(raw) > 2_000_000) throw new Error("Office AI 설정 파일이 너무 큽니다.");
    if (raw !== cachedText) {
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch { throw new Error("Office AI 설정 파일을 읽지 못했습니다. 파일은 변경하지 않았습니다."); }
      // Legacy custom settings get a random endpoint id when normalized. Re-reading unchanged
      // bytes must keep that id, without rewriting the user's file just to stabilize a read.
      cachedSettings = normalizeAiSettings(parsed); cachedText = raw;
    }
    return JSON.parse(JSON.stringify(cachedSettings));
  };
  // Until the trusted settings/OS-secret migration is connected, this service never records
  // new metered consent. A stored flag alone is insufficient without the original fingerprint.
  const withdrawn = new Set();
  const getSettings = () => {
    const settings = readSettings();
    for (const provider of withdrawn) settings.meteredAccepted = { ...settings.meteredAccepted, [provider]: false };
    return settings;
  };
  const service = createSubscriptionStatusService({
    getSettings,
    setMeteredAccepted: (provider, accepted) => {
      if (accepted) throw new Error("종량제 사용 동의는 설정 화면에서 해 주세요.");
      withdrawn.add(provider);
    },
    acceptanceStore: createMeteredAcceptanceFileStore(join(dataDir, "office")),
    detect: injected.detect,
    listModels: injected.listModels ?? listSubscriptionModels,
  });
  const statuses = () => Object.fromEntries(Object.entries(service.getStatuses()).map(([id, value]) => {
    const { account: _account, ...status } = value;
    return [id, status];
  }));
  const targetFor = (requestSettings) => {
    const stored = getSettings();
    // This origin can read documents. It cannot choose a different executable/endpoint or
    // copy a saved credential into a renderer-supplied URL, even with an otherwise valid grant.
    const supplied = sanitizeAiSettings(requestSettings);
    // sanitize removes empty cliPath while normalize's defaults retain it. Canonicalize both
    // snapshots identically; otherwise a valid settings round trip looks like a changed target.
    if (!supplied || canonicalSettings(supplied) !== canonicalSettings(publicSettings(stored))) {
      return { ok: false, refusal: { error: "AI 설정이 바뀌었습니다. 현재 설정을 다시 읽은 뒤 요청해 주세요." } };
    }
    return resolveAiRun(stored, statuses(), texts);
  };
  return {
    settings: () => publicSettings(getSettings()),
    statuses: async (recheck = false) => {
      if (recheck || Object.values(statuses()).some((value) => value.state === "checking")) await service.check();
      return statuses();
    },
    async stream(request, sessionId, signal, send) {
      const target = targetFor(request.settings);
      if (!target.ok) { send({ requestId: request.requestId, type: "error", ...target.refusal }); return; }
      if (signal.aborted) { send({ requestId: request.requestId, type: "done" }); return; }
      const { settings, provider, config } = target;
      const out = createChunkCoalescer(send);
      const local = provider === "custom" ? activeCustomEndpoint(settings) : undefined;
      const timeoutMs = local?.kind === "local" ? localEndpointTimeoutMs(local) : undefined;
      let lastPing = 0, answered = false, stopReason;
      const ping = () => {
        if (Date.now() - lastPing < 5_000) return;
        lastPing = Date.now(); out.push({ requestId: request.requestId, type: "ping" });
      };
      const keepalive = timeoutMs === undefined ? undefined : startFirstChunkKeepalive(ping);
      const answer = () => { answered = true; keepalive?.firstChunk(); };
      try {
        await (injected.stream ?? streamForProvider)(provider, config, request.system, request.messages, request.tools ?? [], request.maxTokens ?? maxOutputTokensOf(settings), {
          sessionId, signal,
          onDelta: (text) => { answer(); out.push({ requestId: request.requestId, type: "delta", text }); },
          onReasoningDelta: (text) => { answer(); out.push({ requestId: request.requestId, type: "reasoning", text }); },
          onToolCall: (toolCall) => { answer(); out.push({ requestId: request.requestId, type: "tool-call", toolCall }); },
          onActivity: () => { if (!answered) ping(); },
          onStopReason: (value) => { stopReason = value; },
          onUsage: (usage) => out.push({ requestId: request.requestId, type: "usage", usage }),
          ...subscriptionStreamCallbacks(request.requestId, out.push),
        }, timeoutMs === undefined ? undefined : { timeoutMs });
        out.push({ requestId: request.requestId, type: "done", stopReason });
      } catch (error) {
        out.push(signal.aborted ? { requestId: request.requestId, type: "done" } : aiStreamErrorChunk(request.requestId, error));
      } finally { keepalive?.stop(); out.flush(); }
    },
    async chat(request, signal) {
      const target = targetFor(request.settings);
      if (!target.ok) return { ok: false, ...target.refusal };
      if (signal.aborted) return { ok: false, error: "요청을 취소했습니다." };
      try { return await (injected.chat ?? chatForProvider)(target.provider, target.config, request.system, request.user, signal); }
      catch (error) { return aiChatFailure(error, () => "AI 제공자가 혼잡합니다. 잠시 후 다시 시도해 주세요."); }
    },
  };
}

/** Only children registered by the original Office provider layer, never Workbench sessions. */
export function shutdownOfficeAiProviders() { shutdownCodexAppServers(); shutdownSubscriptionChildren(); }
