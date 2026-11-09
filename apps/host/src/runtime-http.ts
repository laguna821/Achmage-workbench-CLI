import type { IncomingMessage, ServerResponse } from "node:http";
import type { ExtensionActivation, ExtensionCall, ExtensionInstallRequest, VoiceCaptureChunk, VoiceCaptureStart, VoiceSettingsUpdate, VoiceSpeechRequest } from "@workbench/contracts";
import type { ExtensionService } from "./extensions/service.ts";
import { VoiceServiceError, type VoiceService } from "./voice.ts";
import { HttpError } from "./errors.ts";
import { readBody, sendJson } from "./http.ts";

/** Owner HTTP authentication or the current device capability gate runs before this adapter. */
export async function handleRuntimeHttp(req: IncomingMessage, res: ServerResponse, url: URL, services: { voice?: VoiceService; extensions?: ExtensionService }): Promise<boolean> {
  const p = url.pathname.split("/").filter(Boolean).slice(1), method = req.method;
  if (p[0] !== "voice" && p[0] !== "extensions") return false;
  const body = async () => {
    let result: unknown;
    try { result = JSON.parse((await readBody(req, 400_000)).toString("utf8") || "{}"); }
    catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, "runtime_json", "JSON 요청 형식을 확인해 주세요."); }
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new HttpError(400, "runtime_json", "요청 객체가 필요합니다.");
    return result as Record<string, unknown>;
  };
  let value: unknown, matched = true;
  try {
    if (p[0] === "voice" && services.voice) {
      const voice = services.voice, id = p[2]!, after = Number(url.searchParams.get("after") ?? 0);
      if (method === "GET" && p.length === 1) value = await voice.status();
      else if (method === "PUT" && p[1] === "settings" && p.length === 2) value = await voice.updateSettings(await body() as VoiceSettingsUpdate);
      else if (method === "POST" && p[1] === "models" && p.length === 4 && p[3] === "download") value = await voice.downloadModel(id, (await body()).accepted === true);
      else if (method === "POST" && p[1] === "models" && p.length === 4 && p[3] === "cancel") value = await voice.cancelDownload(id);
      else if (method === "POST" && p[1] === "captures" && p.length === 2) value = await voice.startCapture(await body() as VoiceCaptureStart, after);
      else if (method === "GET" && p[1] === "captures" && p.length === 3) value = voice.getCapture(id, after);
      else if (method === "POST" && p[1] === "captures" && p.length === 4 && p[3] === "chunks") value = await voice.appendCapture(id, await body() as VoiceCaptureChunk, after);
      else if (method === "POST" && p[1] === "captures" && p.length === 4 && p[3] === "finish") value = await voice.finishCapture(id, (await body()).finalSeq as number, after);
      else if (method === "POST" && p[1] === "captures" && p.length === 4 && p[3] === "cancel") value = voice.cancelCapture(id, after);
      else if (method === "POST" && p[1] === "speech" && p.length === 2) value = await voice.synthesize(await body() as VoiceSpeechRequest);
      else if (method === "POST" && p[1] === "speech" && p.length === 4 && p[3] === "cancel") value = voice.cancelSpeech(id);
      else matched = false;
    } else if (p[0] === "extensions" && services.extensions) {
      const extensions = services.extensions, id = p[1]!;
      if (method === "GET" && p.length === 1) value = extensions.state();
      else if (method === "POST" && p.length === 2 && id === "install") value = await extensions.install(await body() as ExtensionInstallRequest);
      else if (method === "POST" && p.length === 2 && id === "run") value = await extensions.run(await body() as ExtensionCall);
      else if (method === "POST" && p.length === 2 && id === "screen") value = await extensions.screen(await body() as ExtensionCall);
      else if (method === "POST" && p.length === 3 && id === "screen" && p[2] === "call") value = await extensions.screenCall(await body() as { nonce: string; call: ExtensionCall });
      else if (method === "POST" && p.length === 3 && p[2] === "activate") value = await extensions.activate(id, await body() as ExtensionActivation);
      else if (method === "POST" && p.length === 3 && p[2] === "disable") value = await extensions.disable(id, (await body()).expectedGeneration as number);
      else if (method === "POST" && p.length === 3 && p[2] === "update") value = await extensions.update(id, await body() as ExtensionInstallRequest);
      else if (method === "POST" && p.length === 3 && p[2] === "rollback") value = await extensions.rollback(id, (await body()).expectedGeneration as number);
      else matched = false;
    } else matched = false;
  } catch (error) { if (error instanceof VoiceServiceError) throw new HttpError(error.status, "voice_request", error.message); throw error; }
  if (!matched) throw new HttpError(404, "runtime_route", "음성 또는 확장 기능 경로가 없습니다.");
  sendJson(res, 200, value ?? { ok: true }); return true;
}
