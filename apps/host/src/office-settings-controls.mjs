// Original Electron-free settings operations, only behind the full host's settings RPC.
import { AI_MEDIA_PROVIDERS, AI_SEARCH_PROVIDERS, sanitizeAiSettings, sanitizeCliPath, testMediaProvider, chatForProvider } from "../../../vendor/ieumoffice/packages/ai-provider/src/index.ts";
import { createSubscriptionIpcDeps, registerSubscriptionIpc } from "../../../vendor/ieumoffice/packages/ai-provider/src/subscription/ipc.ts";
import { createSubscriptionStatusService } from "../../../vendor/ieumoffice/packages/ai-provider/src/subscription/service.ts";
import { SUBSCRIPTION_INSTALL_URLS } from "../../../vendor/ieumoffice/packages/ai-provider/src/subscription/contract.ts";
import { subscriptionConnectHelpUrl } from "../../../vendor/ieumoffice/packages/ai-provider/src/connect-help.ts";
import { listCodexModels } from "../../../vendor/ieumoffice/packages/ai-provider/src/codex-app-server.ts";
import { listCustomModelsForIpc } from "../../../vendor/ieumoffice/packages/ai-provider/src/custom-models.ts";
import { listLocalModelsForIpc, inspectLocalModelForIpc, testLocalModelForIpc, cancelLocalTestForIpc } from "../../../vendor/ieumoffice/packages/ai-provider/src/local-ipc.ts";
import { connectGemini, connectOpenRouter, openRouterFreeQuota } from "../../../vendor/ieumoffice/packages/ai-provider/src/free-connect.ts";
import { FREE_AI_KEY_PAGES, isFreeAiProvider, withFreeAiConnection, withoutFreeAiConnection } from "../../../vendor/ieumoffice/packages/ai-provider/src/free-ai.ts";
import { testSearchProvider } from "../../../vendor/ieumoffice/packages/ai-search/src/search-tools.ts";
import { resolveAiRun, aiChatFailure } from "../../../vendor/ieumoffice/apps/docs/src/main/ai-run.ts";
import { createI18n } from "../../../vendor/ieumoffice/packages/i18n/src/index.ts";
import { FREE_AI_PAGE_STRINGS } from "../../../vendor/ieumoffice/apps/docs/src/main/free-ai-strings.ts";
import { OFFICE_SETTINGS_CHANNELS } from "../../../packages/contracts/src/office-settings.ts";
import { openUrl } from "./open-url.ts";
import { HttpError } from "./errors.ts";
import { join } from "node:path";

const object = (v) => v && typeof v === "object" && !Array.isArray(v);
const invalid = () => { throw new HttpError(400, "office_settings_request", "설정 요청 형식이 올바르지 않습니다."); };
const texts = { noApiKey: () => "AI 제공자의 키를 설정해 주세요.", noModel: () => "사용할 AI 모델을 선택해 주세요." };

export function createOfficeSettingsControls(dataDir, store, injected = {}, hostActions = {}) {
  const deps = createSubscriptionIpcDeps({ getSettings: () => store.publicSettings(), setMeteredAccepted: (p, a) => store.setMeteredAccepted(p, a), dataDir: join(dataDir, "office"), detect: injected.detect, listModels: injected.listModels });
  if (hostActions.install) {
    const install = async (provider) => {
      if (sanitizeCliPath(store.publicSettings().providers[provider]?.cliPath)) return {
        ok: false, reason: "unsupported", error: "직접 지정한 CLI는 해당 설치 경로에서 업데이트해 주세요. Workbench 설치를 사용하려면 CLI 경로를 자동 검색으로 저장해 주세요.",
      };
      try { return await hostActions.install(provider); }
      finally { await deps.service.check([provider], { fresh: true }); }
    };
    deps.launchInstall = install; deps.launchUpdate = install;
  }
  Object.assign(deps, injected.subscriptionActions ?? {});
  const handlers = new Map(), free = new Map();
  const unregister = registerSubscriptionIpc({ handle: (name, handler) => handlers.set(name, handler), removeHandler: (name) => handlers.delete(name) }, deps);
  const keyed = async (input) => !object(input) ? input : { ...input, ...(input.apiKey !== undefined ? { apiKey: await store.openSecret(input.apiKey) } : {}) };
  const saveFree = async (provider, result, signal, initial) => {
    if (!result.ok) return result;
    if (signal.aborted) return { ok: false, reason: "cancelled" };
    await store.write(withFreeAiConnection(initial.settings, provider, result), initial.revision, { signal });
    return { ok: true, provider, model: result.model };
  };
  const prepareRun = async (settings) => {
    const providers = settings.provider === "auto" ? ["codex", "claude-code"]
      : ["codex", "claude-code"].filter((provider) => provider === settings.provider);
    if (!providers.length) return deps.service.getStatuses();
    const stored = store.publicSettings();
    const changed = providers.filter((p) => sanitizeCliPath(settings.providers[p]?.cliPath) !== sanitizeCliPath(stored.providers[p]?.cliPath));
    const saved = providers.filter((p) => !changed.includes(p));
    if (saved.length) await deps.service.check(saved, { fresh: true });
    const statuses = deps.service.getStatuses();
    if (changed.length) {
      // An unsaved path may be tested, but cannot borrow the saved CLI's consent or
      // mutate its status/acceptance record. The original service applies the rules.
      const draft = createSubscriptionStatusService({ getSettings: () => settings,
        setMeteredAccepted: () => {}, acceptanceStore: { read: async () => ({}), write: async () => {} },
        detect: injected.detect });
      const checked = await draft.check(changed);
      for (const p of changed) statuses[p] = checked[p];
    }
    return statuses;
  };
  const setMeteredAccepted = async (provider, accepted) => {
    const path = store.publicSettings().providers[provider]?.cliPath;
    if (accepted && deps.service.getStatuses()[provider]?.state === "metered") await deps.service.check([provider], { fresh: true });
    if (path !== store.publicSettings().providers[provider]?.cliPath) throw new HttpError(409, "office_settings_changed", "CLI 경로가 바뀌었습니다. 현재 연결을 다시 확인해 주세요.");
    return deps.service.setMeteredAccepted(provider, accepted);
  };
  return {
    service: deps.service,
    prepareRun,
    setMeteredAccepted,
    close() {
      unregister(); for (const controller of free.values()) controller.abort(); free.clear();
      for (const provider of ["codex", "claude-code"]) void deps.cancelLogin(provider).catch(() => {});
    },
    async invoke(channel, args, owner, signal) {
      if (!OFFICE_SETTINGS_CHANNELS.has(channel) || !Array.isArray(args) || args.length > 4) return invalid();
      if (handlers.has(channel)) {
        if (signal.aborted) return { ok: false, reason: "cancelled" };
        if (channel === "ai:subscription-metered" && typeof args[0]?.accepted === "boolean" && ["codex", "claude-code"].includes(args[0]?.provider)) return setMeteredAccepted(args[0].provider, args[0].accepted);
        return handlers.get(channel)(undefined, ...args);
      }
      const input = args[0];
      switch (channel) {
        case "ai:codex-models": return (injected.codexModels ?? listCodexModels)(sanitizeCliPath(input));
        case "ai:custom-models": return (injected.customModels ?? listCustomModelsForIpc)(await keyed(input));
        case "ai:local-models": return (injected.localModels ?? listLocalModelsForIpc)(await keyed(input));
        case "ai:local-inspect": return (injected.localInspect ?? inspectLocalModelForIpc)(await keyed(input));
        case "ai:local-test": return (injected.localTest ?? testLocalModelForIpc)(await keyed(input), { owner, signal });
        case "ai:local-test-cancel": return cancelLocalTestForIpc(input, owner);
        case "ai:chat": {
          // This is the original settings pane's explicit connection test, never a general chat.
          const settings = await store.draftSettings(input?.settings);
          const target = resolveAiRun(settings, await prepareRun(settings), texts);
          if (!target.ok) return { ok: false, ...target.refusal };
          if (signal.aborted) return { ok: false, error: "요청을 취소했습니다." };
          try { return await (injected.chat ?? chatForProvider)(target.provider, target.config, "You are a connectivity test. Reply with the single word OK.", "ping", signal); }
          catch (error) { return aiChatFailure(error, () => "AI 제공자가 혼잡합니다. 잠시 후 다시 시도해 주세요."); }
        }
        case "ai:media-test": {
          if (!object(input) || !AI_MEDIA_PROVIDERS.some((m) => m.id === input.provider) || !object(input.config)) return invalid();
          const safe = sanitizeAiSettings({ provider: "auto", providers: {}, media: { providers: { [input.provider]: input.config } } });
          const config = safe?.media?.providers?.[input.provider]; if (!config) return invalid();
          return (injected.mediaTest ?? testMediaProvider)(input.provider, await keyed(config));
        }
        case "ai:search-test": {
          if (!object(input) || !AI_SEARCH_PROVIDERS.some((m) => m.id === input.provider)) return invalid();
          return (injected.searchTest ?? testSearchProvider)(input.provider, await store.openSecret(input.apiKey ?? ""));
        }
        case "ai:free-connect": {
          if (!object(input) || !isFreeAiProvider(input.provider)) return { ok: false, reason: "invalid" };
          const initial = store.snapshot();
          free.get(owner)?.abort(); const controller = new AbortController(); free.set(owner, controller);
          const abort = () => controller.abort(); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
          try {
            if (input.provider === "gemini") return await saveFree("gemini", await (injected.geminiConnect ?? connectGemini)(await store.openSecret(input.apiKey ?? "")), controller.signal, initial);
            const t = createI18n(FREE_AI_PAGE_STRINGS), lang = "ko";
            const result = await (injected.openRouterConnect ?? connectOpenRouter)({ openBrowser: injected.openUrl ?? openUrl, signal: controller.signal, pages: { done: { lang, title: t(lang, "pageDoneTitle"), body: t(lang, "pageDoneBody") }, failed: { lang, title: t(lang, "pageFailedTitle"), body: t(lang, "pageFailedBody") } } });
            return await saveFree("openrouter", result, controller.signal, initial);
          } finally { signal.removeEventListener("abort", abort); if (free.get(owner) === controller) free.delete(owner); }
        }
        case "ai:free-connect-cancel": free.get(owner)?.abort(); return null;
        case "ai:free-disconnect": {
          if (!object(input) || !isFreeAiProvider(input.provider)) return invalid();
          const latest = store.snapshot(); await store.write(withoutFreeAiConnection(latest.settings, input.provider), latest.revision); return null;
        }
        case "ai:free-quota": {
          if (input?.provider !== "openrouter") return null;
          const snapshot = store.snapshot(); return (injected.freeQuota ?? openRouterFreeQuota)(await store.openSecret(snapshot.settings.providers.openrouter.apiKey));
        }
        case "ai:free-open-key-page": {
          if (!isFreeAiProvider(input?.provider)) return invalid();
          return (injected.openUrl ?? openUrl)(FREE_AI_KEY_PAGES[input.provider]);
        }
        case "home:open-subscription-install-help": {
          if (!Object.hasOwn(SUBSCRIPTION_INSTALL_URLS, input)) return invalid();
          return (injected.openUrl ?? openUrl)(SUBSCRIPTION_INSTALL_URLS[input]);
        }
        case "home:open-connect-help": return (injected.openUrl ?? openUrl)(subscriptionConnectHelpUrl(input));
        // File search has its own store/index, to be connected with that subsystem.
        case "home:get-file-search-settings": return null;
        default: throw new HttpError(501, "office_settings_operation_unavailable", "이 설정을 아직 사용할 수 없습니다.");
      }
    },
  };
}
