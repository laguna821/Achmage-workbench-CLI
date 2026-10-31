// Original search/read engines. The bridge supplies only stored settings and the
// document request's lifetime; no Electron app or renderer-supplied key/endpoint.
import { AsyncLocalStorage } from "node:async_hooks";
import { setAiSecretCodec } from "../../../vendor/ieumoffice/packages/ai-provider/src/index.ts";
import { webSearch, imageSearch, searchOptionsFromSettings, readUrlTool } from "../../../vendor/ieumoffice/packages/ai-search/src/index.ts";
import { aiToolCapabilities } from "../../../vendor/ieumoffice/packages/ai-search/src/tool-capabilities.ts";
import { fetchRemoteImage, readBodyCapped, MAX_REMOTE_IMAGE_BYTES } from "../../../vendor/ieumoffice/packages/electron-utils/src/remote-image.ts";
import { HttpError } from "./errors.ts";

const requestSecrets = new AsyncLocalStorage();
setAiSecretCodec({ seal: () => null, open: value => requestSecrets.getStore()?.get(value) ?? null });
const invalid = () => { throw new HttpError(400, "office_web_request", "웹 도구 요청 형식이 올바르지 않습니다."); };
const string = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max;

// The upstream search interface has its own bounded network timeouts but no
// cancellation parameter. Discard a canceled answer immediately; URL/image body
// requests additionally propagate the signal to their original fetch engines.
function owned(signal, work) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("요청을 취소했습니다."));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }).then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

export function createOfficeWebTools(store, injected = {}) {
  return {
    async capabilities() {
      const capabilities = aiToolCapabilities(await store.executionSettings());
      // Generation/analysis are wired separately; do not advertise unused handlers.
      const pending = { available: false, route: null, provider: null, message: "미디어 생성·분석 연결을 준비 중입니다." };
      return { ...capabilities, imageGeneration: pending, imageAnalysis: pending, videoAnalysis: pending };
    },
    async invoke(name, args, signal) {
      if (!Array.isArray(args)) return invalid();
      const [query, limit] = args;
      if (name === "web-search" || name === "image-search") {
        if (args.length > 2 || !string(query, 500) || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 20))) return invalid();
      } else if (name === "read-url") {
        if (args.length > 2 || !string(query, 8192) || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))) return invalid();
      } else if (name === "fetch-image") {
        if (args.length !== 1 || !string(query, 8192) || !/^https?:\/\//i.test(query)) return invalid();
      } else return invalid();
      signal.throwIfAborted();
      const { settings, secrets } = await store.executionContext();
      return requestSecrets.run(secrets, () => owned(signal, async () => {
        if (name === "web-search") return (injected.webSearch ?? webSearch)(query, limit ?? 6, searchOptionsFromSettings(settings));
        if (name === "image-search") return (injected.imageSearch ?? imageSearch)(query, limit ?? 8, searchOptionsFromSettings(settings));
        if (name === "read-url") return readUrlTool(store.path, query, limit ?? 0, { signal, ...(injected.readUrlFetch ? { fetchImpl: injected.readUrlFetch } : {}) });
        const fetchImpl = (url, options) => {
          signal.throwIfAborted();
          return fetch(url, { ...options, signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal });
        };
        const response = await (injected.fetchImage ?? fetchRemoteImage)(query, { fetchImpl });
        if (!response?.ok) return null;
        const bytes = await readBodyCapped(response, MAX_REMOTE_IMAGE_BYTES);
        const mime = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
        if (!mime || !/^image\/(png|jpeg|gif|webp|bmp|tiff|svg\+xml)$/.test(mime)) return null;
        return { base64: Buffer.from(bytes).toString("base64"), mime };
      }));
    },
  };
}
