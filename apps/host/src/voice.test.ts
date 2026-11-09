import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { createServer, type RequestListener } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { OpenAISTT } from "@workbench/paseo-voice-server/openai-stt";
import { OpenAITTS } from "@workbench/paseo-voice-server/openai-tts";
import { downloadToFile } from "@workbench/paseo-voice-server/model-downloader";
import type { StreamingTranscriptionSession } from "@workbench/paseo-voice-server/speech-provider";
import { VoiceService } from "./voice.ts";
import { applyVoiceTranscript } from "@workbench/contracts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const run of cleanup.splice(0).reverse()) await run(); });
async function directory() { const path = await mkdtemp(join(tmpdir(), "workbench-voice-")); cleanup.push(() => rm(path, { recursive: true, force: true })); return path; }
const start = { captureId: "capture-fixture", draftId: "draft-fixture", generation: 4, sessionId: "session-fixture", format: "audio/pcm;rate=24000", onlineConsent: true };
async function configured(service: VoiceService) { await service.updateSettings({ enabled: true, sttModelId: "openai-whisper-1", onlineConsent: true, apiKey: "fixture-key" }); }
async function server(handler: RequestListener) {
  const instance = createServer(handler);
  await new Promise<void>(resolve => instance.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => { instance.closeAllConnections(); instance.close(error => error ? reject(error) : resolve()); }));
  const address = instance.address(); if (!address || typeof address === "string") throw Error("Missing test port");
  return `http://127.0.0.1:${address.port}`;
}

describe("original voice runtime integration", () => {
  it("starts disabled and cancelled captures cannot replace typed drafts or revive late results", async () => {
    let requestedSignal: AbortSignal | undefined, speechSignal: AbortSignal | undefined, closed = false;
    const emitter = new EventEmitter();
    const session: StreamingTranscriptionSession = {
      requiredSampleRate: 24000, async connect() {}, appendPcm16() {},
      commit() { emitter.emit("committed", { segmentId: "segment", previousSegmentId: null }); },
      clear() {}, close() { closed = true; }, on(event, listener) { emitter.on(event, listener); },
    };
    const service = new VoiceService({ dataDir: await directory(), sessionExists: () => true,
      providers: { stt: async (_model, signal) => { requestedSignal = signal; return { provider: { id: "fixture", createSession: () => session }, close() {} }; },
        tts: signal => { speechSignal = signal; return { synthesizeSpeech: () => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })) }; } } });
    cleanup.push(() => service.close());
    await expect(service.startCapture(start)).rejects.toMatchObject({ status: 409 });
    expect(requestedSignal).toBeUndefined(); expect((await service.status()).settings.enabled).toBe(false);
    await configured(service); await service.startCapture(start);
    await service.appendCapture(start.captureId, { seq: 0, audioBase64: Buffer.from([0, 32, 0, 32]).toString("base64"), format: start.format });
    await service.finishCapture(start.captureId, 0);
    const cancelled = service.cancelCapture(start.captureId);
    emitter.emit("transcript", { segmentId: "segment", transcript: "늦게 온 받아쓰기", isFinal: true });
    expect(requestedSignal?.aborted).toBe(true); expect(closed).toBe(true);
    expect(service.getCapture(start.captureId).state).toEqual(cancelled.state);
    const typed = { ...cancelled.state, text: "직접 입력한 문장" };
    expect(applyVoiceTranscript(typed, { ...start, generation: 3, language: "ko", text: "늦게 온 받아쓰기" })).toBe(typed);
    expect((await service.status()) as unknown as Record<string, unknown>).not.toHaveProperty("apiKey");
    const speech = service.synthesize({ speechId: "speech-cancel", sessionId: start.sessionId, text: "읽는 중 취소", onlineConsent: true });
    service.cancelSpeech("speech-cancel"); await expect(speech).rejects.toThrow("cancelled"); expect(speechSignal?.aborted).toBe(true);
  });

  it("calls the preserved OpenAI STT/TTS adapters with Korean data through a loopback fixture", async () => {
    let transcriptions = 0, speeches = 0, ttsInput = "", multipart = "";
    const origin = await server((request, response) => {
      const chunks: Buffer[] = []; request.on("data", chunk => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        const body = Buffer.concat(chunks);
        if (request.url === "/v1/audio/transcriptions") {
          transcriptions++; multipart = body.toString("utf8"); response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ text: "안녕하세요. 회의 내용을 정리합니다." }));
        } else if (request.url === "/v1/audio/speech") {
          speeches++; ttsInput = (JSON.parse(body.toString()) as { input: string }).input;
          response.setHeader("content-type", "audio/wav"); response.end(Buffer.from("RIFF-fixture-WAVE"));
        } else { response.statusCode = 404; response.end(); }
      });
    });
    const logger = pino({ level: "silent" });
    const service = new VoiceService({ dataDir: await directory(), sessionExists: () => true, providers: {
      stt: async (_id, signal) => ({ provider: new OpenAISTT({ apiKey: "fixture", baseUrl: `${origin}/v1`, signal }, logger), close() {} }),
      tts: signal => new OpenAITTS({ apiKey: "fixture", baseUrl: `${origin}/v1`, responseFormat: "wav", signal }, logger),
    } });
    cleanup.push(() => service.close()); await configured(service);
    await service.startCapture(start);
    await service.appendCapture(start.captureId, { seq: 0, audioBase64: Buffer.from([0, 32, 0, 32]).toString("base64"), format: start.format });
    await service.finishCapture(start.captureId, 0);
    await expect.poll(() => service.getCapture(start.captureId).state.phase).toBe("ready");
    expect(service.getCapture(start.captureId).state.text).toBe("안녕하세요. 회의 내용을 정리합니다.");
    expect(multipart).toContain('name="language"\r\n\r\nko'); expect(multipart).toContain("RIFF"); expect(transcriptions).toBe(1);
    const speech = { speechId: "speech-fixture", sessionId: start.sessionId, text: "안녕하세요", onlineConsent: true };
    const result = await service.synthesize(speech); expect(result.mimeType).toBe("audio/wav");
    await service.synthesize(speech); expect(speeches).toBe(1); expect(ttsInput).toBe("안녕하세요");
    expect(service.speechSessionId(speech.speechId)).toBe(start.sessionId);
  });

  it("rejects a corrupt download before replacing the previous file", async () => {
    const origin = await server((_request, response) => { response.end("corrupt"); });
    const file = join(await directory(), "runtime.tgz"); await writeFile(file, "previous-verified");
    await expect(downloadToFile({ url: origin, outputPath: file, expectedBytes: 7, expectedSha256: "0".repeat(64) })).rejects.toThrow("SHA256");
    expect(await readFile(file, "utf8")).toBe("previous-verified");
  });
});
