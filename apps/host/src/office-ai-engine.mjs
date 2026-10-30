// Node-only, original Ieum provider implementation. Keep its Electron-facing type graph out
// of the host project; the implementation is bundled from the reviewed vendor pin, unchanged.
import { OfficeSettings, OFFICE_SECRET_PLACEHOLDER } from "./office-settings.mjs";
import { createOfficeSettingsControls } from "./office-settings-controls.mjs";
import {
  activeCustomEndpoint, localEndpointTimeoutMs, maxOutputTokensOf,
  normalizeAiSettings, sanitizeAiSettings, streamForProvider, chatForProvider,
} from "../../../vendor/ieumoffice/packages/ai-provider/src/index.ts";
import { shutdownSubscriptionChildren } from "../../../vendor/ieumoffice/packages/ai-provider/src/subscription/process.ts";
import { shutdownCodexAppServers } from "../../../vendor/ieumoffice/packages/ai-provider/src/codex-app-server.ts";
import { resolveAiRun, aiStreamErrorChunk, aiChatFailure, subscriptionStreamCallbacks } from "../../../vendor/ieumoffice/apps/docs/src/main/ai-run.ts";
import { createChunkCoalescer } from "../../../vendor/ieumoffice/apps/docs/src/main/stream-coalesce.ts";
import { startFirstChunkKeepalive } from "../../../vendor/ieumoffice/apps/docs/src/main/ai-keepalive.ts";

export { OFFICE_SECRET_PLACEHOLDER };
const texts = { noApiKey: () => "AI 제공자의 키를 설정해 주세요.", noModel: () => "사용할 AI 모델을 선택해 주세요." };
const canonicalSettings = (settings) => JSON.stringify(normalizeAiSettings(sanitizeAiSettings(settings)), (_key, value) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value);

export function createOfficeAiEngine(dataDir, injected = {}, hostActions = {}) {
  const store = injected.settingsStore ?? new OfficeSettings(dataDir);
  const getSettings = () => store.publicSettings();
  const controls = createOfficeSettingsControls(dataDir, store, injected, hostActions), service = controls.service;
  const statuses = (trusted = false) => Object.fromEntries(Object.entries(service.getStatuses()).map(([id, value]) => {
    const { account: _account, ...status } = value;
    return [id, trusted ? value : status];
  }));
  const targetFor = async (requestSettings) => {
    const stored = getSettings();
    // This origin can read documents. It cannot choose a different executable/endpoint or
    // copy a saved credential into a renderer-supplied URL, even with an otherwise valid grant.
    const supplied = sanitizeAiSettings(requestSettings);
    // sanitize removes empty cliPath while normalize's defaults retain it. Canonicalize both
    // snapshots identically; otherwise a valid settings round trip looks like a changed target.
    const changed = () => ({ ok: false, refusal: { error: "AI 설정이 바뀌었습니다. 현재 설정을 다시 읽은 뒤 요청해 주세요." } });
    if (!supplied || canonicalSettings(supplied) !== canonicalSettings(stored)) return changed();
    try {
      const settings = await store.executionSettings();
      const target = resolveAiRun(settings, await controls.prepareRun(settings), texts);
      return target.ok && canonicalSettings(getSettings()) !== canonicalSettings(stored) ? changed() : target;
    }
    catch (error) { return { ok: false, refusal: { error: error instanceof Error ? error.message : "보관된 AI 키를 읽지 못했습니다." } }; }
  };
  return {
    settings: getSettings,
    configuration: store,
    settingsInvoke: controls.invoke,
    setMeteredAccepted: controls.setMeteredAccepted,
    close: () => { controls.close(); store.close(); },
    statuses: async (recheck = false, trusted = false) => {
      if (recheck || Object.values(statuses()).some((value) => value.state === "checking")) await service.check();
      return statuses(trusted);
    },
    async stream(request, sessionId, signal, send) {
      const target = await targetFor(request.settings);
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
      const target = await targetFor(request.settings);
      if (!target.ok) return { ok: false, ...target.refusal };
      if (signal.aborted) return { ok: false, error: "요청을 취소했습니다." };
      try { return await (injected.chat ?? chatForProvider)(target.provider, target.config, request.system, request.user, signal); }
      catch (error) { return aiChatFailure(error, () => "AI 제공자가 혼잡합니다. 잠시 후 다시 시도해 주세요."); }
    },
  };
}

/** Only children registered by the original Office provider layer, never Workbench sessions. */
export function shutdownOfficeAiProviders() { shutdownCodexAppServers(); shutdownSubscriptionChildren(); }
