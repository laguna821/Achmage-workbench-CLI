// Original search/read engines. The bridge supplies only stored settings and the
// document request's lifetime; no Electron app or renderer-supplied key/endpoint.
import { AsyncLocalStorage } from "node:async_hooks";
import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";
import { setAiSecretCodec, setCodexImageGenerationAvailable, codexImageGenerationAvailable } from "../../../vendor/ieumoffice/packages/ai-provider/src/index.ts";
import { webSearch, imageSearch, searchOptionsFromSettings, readUrlTool, generateImageTool, analyzeMediaTool, documentMediaRoots, registerCodexImageGenerator, createCodexImageCliGenerator } from "../../../vendor/ieumoffice/packages/ai-search/src/index.ts";
import { aiToolCapabilities } from "../../../vendor/ieumoffice/packages/ai-search/src/tool-capabilities.ts";
import { fetchRemoteImage, readBodyCapped, MAX_REMOTE_IMAGE_BYTES } from "../../../vendor/ieumoffice/packages/electron-utils/src/remote-image.ts";
import { readGeneratedImage } from "../../../vendor/ieumoffice/packages/electron-utils/src/generated-images.ts";
import { HttpError } from "./errors.ts";

const requestSecrets = new AsyncLocalStorage();
const requestGenerator = new AsyncLocalStorage();
let generatorRegistered = false;
setAiSecretCodec({ seal: () => null, open: value => requestSecrets.getStore()?.get(value) ?? null });
const invalid = () => { throw new HttpError(400, "office_web_request", "웹 도구 요청 형식이 올바르지 않습니다."); };
const string = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max;
const object = value => value && typeof value === "object" && !Array.isArray(value);
const mediaUrls = value => Array.isArray(value) && value.length <= 12 && value.every(url => string(url, 160 * 1024 * 1024));

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

export function createOfficeWebTools(store, injected = {}, context = async () => ({ path: "screen" })) {
  // The original slot is process-wide. Its implementation is request-local so
  // separate settings stores never borrow each other's CLI path or credentials.
  if (!generatorRegistered) {
    registerCodexImageGenerator(request => {
      const generate = requestGenerator.getStore();
      if (!generate) throw new Error("이미지 생성 요청의 설정을 확인하지 못했습니다.");
      return generate(request);
    });
    setCodexImageGenerationAvailable(true); generatorRegistered = true;
  }
  const generate = injected.codexGenerate ?? createCodexImageCliGenerator({ settingsPath: () => store.path, tempRoot: tmpdir });
  return {
    async capabilities() {
      const routeContext = await context();
      return { ...aiToolCapabilities(await store.executionSettings(), routeContext), codexImageAvailable: codexImageGenerationAvailable() };
    },
    async invoke(name, args, signal, document) {
      if (!Array.isArray(args)) return invalid();
      const [query, limit] = args;
      if (name === "web-search" || name === "image-search") {
        if (args.length > 2 || !string(query, 500) || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 20))) return invalid();
      } else if (name === "read-url") {
        if (args.length > 2 || !string(query, 8192) || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))) return invalid();
      } else if (name === "fetch-image") {
        if (args.length !== 1 || !string(query, 8192) || (!/^https?:\/\//i.test(query) && !readGeneratedImage(query))) return invalid();
      } else if (name === "generate-image" || name === "analyze-media") {
        if (args.length !== 1 || !object(query) || !string(document?.path, 8192) || !isAbsolute(document.path)) return invalid();
        if (name === "generate-image") {
          if (!string(query.prompt, 200_000) || ["model", "aspectRatio", "imageSize"].some(key => query[key] !== undefined && !string(query[key], 256)) ||
            query.transparentBackground !== undefined && typeof query.transparentBackground !== "boolean" || query.referenceImageUrls !== undefined && !mediaUrls(query.referenceImageUrls)) return invalid();
        } else if (!string(query.requirements, 200_000) || !mediaUrls(query.mediaUrls) || !query.mediaUrls.length) return invalid();
      } else return invalid();
      signal.throwIfAborted();
      const routeContext = name === "generate-image" || name === "analyze-media" ? await context(true) : undefined;
      signal.throwIfAborted();
      const { settings, secrets } = await store.executionContext();
      return requestSecrets.run(secrets, () => owned(signal, async () => {
        if (name === "generate-image" || name === "analyze-media") {
          const options = { mediaRoots: documentMediaRoots(document.path), context: routeContext, signal };
          signal.throwIfAborted();
          return requestGenerator.run(generate, () => name === "generate-image"
            ? generateImageTool(store.path, query, options)
            : analyzeMediaTool(store.path, query, options));
        }
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
