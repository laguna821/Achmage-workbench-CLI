import { existsSync, lstatSync, readFileSync } from "node:fs";
import { fork } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { DictationStreamManager } from "@workbench/paseo-voice-server/dictation";
import type { DictationStreamOutboundMessage } from "@workbench/paseo-voice-server/dictation";
import { OpenAISTT } from "@workbench/paseo-voice-server/openai-stt";
import { OpenAITTS } from "@workbench/paseo-voice-server/openai-tts";
import { LocalSpeechWorkerClient, WorkerBackedSpeechToTextProvider } from "@workbench/paseo-voice-server/local-worker";
import { applySherpaLoaderEnv } from "@workbench/paseo-voice-server/runtime-env";
import type { SpeechToTextProvider, TextToSpeechProvider } from "@workbench/paseo-voice-server/speech-provider";
import { ensurePrivateDirectory, ensurePrivateFile, writePrivateFileAtomicSync } from "@workbench/paseo-server-transport/private-files";
import { applyVoiceTranscript, type VoiceCapture, type VoiceCaptureChunk, type VoiceCaptureStart, type VoiceDictationMessage,
  type VoiceSettings, type VoiceSettingsUpdate, type VoiceSpeech, type VoiceSpeechRequest, type VoiceStatus } from "@workbench/contracts";
import { VoiceModels } from "./voice-models.ts";

const limits = { maxCaptureBytes: 32 * 1024 * 1024, maxChunkBytes: 192 * 1024, maxSpeechCharacters: 4000 };
const defaults: VoiceSettings = { enabled: false, sttModelId: "whisper-base", ttsModelId: "openai-tts-1", language: "ko", onlineConsent: false };
const logger = pino({ level: "silent" }); // Provider diagnostics must not persist transcripts or audio.
type ProviderHandle = { provider: SpeechToTextProvider; close(): void };
type Capture = { value: VoiceCapture; request: VoiceCaptureStart; manager: DictationStreamManager | null; controller: AbortController;
  release: (() => void) | null; chunks: Map<number, string>; bytes: number; touchedAt: number; ready: Promise<void> | null };
type SpeechTask = { request: VoiceSpeechRequest; controller: AbortController; promise: Promise<VoiceSpeech>; finished: boolean; finishedAt: number | null; released: boolean };

export class VoiceServiceError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function fail(status: number, message: string): never { throw new VoiceServiceError(status, message); }
function identity(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !/^[\w:.-]{1,160}$/.test(value)) fail(400, `${name} ID를 확인해 주세요.`);
}
function validSettings(value: VoiceSettings): VoiceSettings {
  if (typeof value.enabled !== "boolean" || typeof value.onlineConsent !== "boolean" ||
      !["whisper-base", "openai-whisper-1"].includes(value.sttModelId) || value.ttsModelId !== "openai-tts-1" ||
      !["ko", "en", "ja", "zh"].includes(value.language)) fail(400, "음성 모델·언어·동의 설정을 확인해 주세요.");
  return value;
}
function privatePath(path: string, directory: boolean) {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error("음성 설정 경로를 안전하게 열 수 없습니다.");
}

/** Workbench lifecycle adapter around the original Paseo dictation/providers, not a second STT engine. */
export class VoiceService {
  private readonly file: string;
  private readonly sessionExists: (id: string) => boolean;
  private readonly providers?: { stt?: (modelId: string, signal: AbortSignal) => Promise<ProviderHandle>; tts?: (signal: AbortSignal) => TextToSpeechProvider };
  private readonly captures = new Map<string, Capture>();
  private readonly speeches = new Map<string, SpeechTask>();
  private readonly models: VoiceModels;
  private readonly timer: ReturnType<typeof setInterval>;
  private settings: VoiceSettings = { ...defaults };
  private apiKey = "";
  private closed = false;

  constructor(options: { dataDir: string; sessionExists: (id: string) => boolean;
    providers?: { stt?: (modelId: string, signal: AbortSignal) => Promise<ProviderHandle>; tts?: (signal: AbortSignal) => TextToSpeechProvider } }) {
    this.sessionExists = options.sessionExists; this.providers = options.providers;
    const directory = join(options.dataDir, "voice"); this.file = join(directory, "settings.json");
    privatePath(directory, true); ensurePrivateDirectory(directory); privatePath(this.file, false);
    if (existsSync(this.file)) {
      ensurePrivateFile(this.file);
      const stored = JSON.parse(readFileSync(this.file, "utf8")) as { settings: VoiceSettings; apiKey: string };
      this.settings = validSettings({ ...defaults, ...stored.settings });
      if (typeof stored.apiKey === "string") this.apiKey = stored.apiKey;
    }
    this.models = new VoiceModels(options.dataDir);
    this.timer = setInterval(() => this.prune(), 30_000); this.timer.unref();
  }
  async status(): Promise<VoiceStatus> {
    return { settings: { ...this.settings }, models: await this.models.list(), apiKeyConfigured: !!this.key(),
      destination: "https://api.openai.com", audioRetention: "none", localTtsLanguages: [], limits: { ...limits } };
  }
  async updateSettings(update: VoiceSettingsUpdate): Promise<VoiceStatus> {
    if (!update || typeof update !== "object" || Array.isArray(update)) fail(400, "음성 설정을 확인해 주세요.");
    const { apiKey, ...settings } = update;
    if (Object.keys(settings).some(key => !Object.hasOwn(defaults, key))) fail(400, "알 수 없는 음성 설정입니다.");
    const next = validSettings({ ...this.settings, ...settings });
    if (apiKey !== undefined && (typeof apiKey !== "string" || apiKey.length > 512 || /[\s\u0000-\u001f]/.test(apiKey))) fail(400, "API 키를 확인해 주세요.");
    const nextKey = apiKey ?? this.apiKey;
    privatePath(this.file, false);
    writePrivateFileAtomicSync(this.file, `${JSON.stringify({ settings: next, apiKey: nextKey })}\n`);
    this.settings = next; this.apiKey = nextKey;
    // Revocation also cancels work already admitted under the previous settings.
    if (!next.enabled || !next.onlineConsent || apiKey !== undefined) {
      for (const capture of this.captures.values()) {
        if (!next.enabled || capture.value.state.modelId.startsWith("openai-")) this.cancelCapture(capture.value.state.captureId);
      }
      for (const id of this.speeches.keys()) this.cancelSpeech(id);
    }
    return this.status();
  }
  async downloadModel(id: string, accepted: boolean) { this.models.startDownload(id, accepted); return this.status(); }
  async cancelDownload(id: string) { this.models.cancelDownload(id); return this.status(); }

  async startCapture(request: VoiceCaptureStart, after = 0): Promise<VoiceCapture> {
    this.admit(request?.sessionId);
    identity(request.captureId, "녹음"); identity(request.draftId, "초안");
    if (!Number.isSafeInteger(request.generation) || request.generation < 0 || typeof request.format !== "string" ||
        !/^audio\/pcm;rate=(8000|16000|22050|24000|44100|48000)(;bits=16)?$/.test(request.format)) fail(400, "PCM 녹음 형식·초안 세대를 확인해 주세요.");
    const existing = this.captures.get(request.captureId);
    if (existing) {
      if (JSON.stringify(existing.request) !== JSON.stringify(request)) fail(409, "이미 다른 녹음에 사용한 ID입니다.");
      await existing.ready; return this.getCapture(request.captureId, after);
    }
    if ([...this.captures.values()].filter(c => c.value.state.phase === "recording" || c.value.state.phase === "transcribing").length >= 4) fail(429, "진행 중인 음성 입력을 먼저 중지해 주세요.");
    const modelId = this.settings.sttModelId, language = this.settings.language;
    if (modelId.startsWith("openai-")) this.admitOnline(request.onlineConsent);
    const capture: Capture = { request: { ...request }, controller: new AbortController(), manager: null, release: null, chunks: new Map(), bytes: 0, touchedAt: Date.now(), ready: null,
      value: { state: { captureId: request.captureId, draftId: request.draftId, generation: request.generation, sessionId: request.sessionId,
        phase: "recording", text: "", muted: false, error: null, modelId, language }, messages: [], cursor: 0 } };
    this.captures.set(request.captureId, capture);
    capture.ready = this.prepareCapture(capture, modelId, language);
    await capture.ready;
    return this.getCapture(request.captureId, after);
  }
  private async prepareCapture(capture: Capture, modelId: string, language: string) {
    try {
      const handle = await this.stt(modelId, capture.controller.signal);
      capture.release = handle.close;
      if (capture.controller.signal.aborted) { this.release(capture); return; }
      capture.manager = new DictationStreamManager({ logger, stt: handle.provider, language, sessionId: capture.request.sessionId,
        persistDebugAudio: false, autoCommitSeconds: 0, finalTimeoutMs: 60_000, emit: message => this.receive(capture, message) });
      await capture.manager.handleStart(capture.request.captureId, capture.request.format);
    } catch (error) {
      if (!capture.controller.signal.aborted) this.receive(capture, { type: "dictation_stream_error", payload: { dictationId: capture.request.captureId, error: error instanceof Error ? error.message : String(error), retryable: false } });
    }
  }
  getCapture(id: string, after = 0): VoiceCapture {
    const capture = this.capture(id);
    const cursor = Number.isSafeInteger(after) && after >= 0 ? after : 0;
    return { state: { ...capture.value.state }, cursor: capture.value.cursor, messages: capture.value.messages.filter(event => event.sequence > cursor).map(event => ({ sequence: event.sequence, message: structuredClone(event.message) })) };
  }
  async appendCapture(id: string, input: VoiceCaptureChunk, after = 0) {
    const capture = this.capture(id); await capture.ready;
    if (!input || !Number.isSafeInteger(input.seq) || input.seq < 0 || input.seq > 20000 || input.format !== capture.request.format ||
        typeof input.audioBase64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.audioBase64)) fail(400, "음성 청크를 확인해 주세요.");
    const previous = capture.chunks.get(input.seq);
    if (previous !== undefined && previous !== input.audioBase64) fail(409, "동일한 청크 번호에 다른 오디오를 보낼 수 없습니다.");
    if (capture.value.state.phase !== "recording" && capture.value.state.phase !== "transcribing") return this.getCapture(id, after);
    const bytes = Buffer.byteLength(input.audioBase64, "base64");
    if (!bytes || bytes % 2 || bytes > limits.maxChunkBytes || (previous === undefined && capture.bytes + bytes > limits.maxCaptureBytes)) fail(413, "음성 입력 크기 제한을 넘었습니다. 녹음을 중지한 뒤 다시 시작해 주세요.");
    if (previous === undefined) { capture.bytes += bytes; capture.chunks.set(input.seq, input.audioBase64); }
    capture.touchedAt = Date.now();
    await capture.manager?.handleChunk({ dictationId: id, ...input });
    return this.getCapture(id, after);
  }
  async finishCapture(id: string, finalSeq: number, after = 0) {
    const capture = this.capture(id); await capture.ready;
    if (!Number.isSafeInteger(finalSeq) || finalSeq < -1 || finalSeq > 20000) fail(400, "마지막 음성 청크 번호를 확인해 주세요.");
    if (capture.value.state.phase === "recording") {
      capture.value.state.phase = "transcribing"; capture.touchedAt = Date.now();
      await capture.manager?.handleFinish(id, finalSeq);
    }
    return this.getCapture(id, after);
  }
  cancelCapture(id: string, after = 0) {
    const capture = this.capture(id);
    capture.value.state = { ...capture.value.state, phase: "cancelled", text: "", muted: true, error: null };
    capture.value.messages = []; capture.touchedAt = Date.now();
    this.release(capture);
    return this.getCapture(id, after);
  }
  private receive(capture: Capture, message: DictationStreamOutboundMessage) {
    if (capture.controller.signal.aborted || message.type === "activity_log") return;
    const value = capture.value, id = capture.request.captureId;
    let safe: VoiceDictationMessage;
    if (message.type === "dictation_stream_final" || message.type === "dictation_stream_partial") {
      safe = { type: message.type, payload: { dictationId: id, text: message.payload.text } };
      if (message.type === "dictation_stream_final") value.state = applyVoiceTranscript(value.state, { ...capture.request, language: value.state.language, text: message.payload.text });
      else value.state.text = message.payload.text;
    } else if (message.type === "dictation_stream_error") {
      const error = message.payload.error.slice(0, 500);
      safe = { type: message.type, payload: { dictationId: id, error, retryable: message.payload.retryable } };
      value.state = { ...value.state, phase: "error", error };
    } else safe = message;
    value.messages.push({ sequence: ++value.cursor, message: safe });
    if (value.messages.length > 128) value.messages.splice(0, value.messages.length - 128);
    capture.touchedAt = Date.now();
    if (value.state.phase === "ready" || value.state.phase === "error") queueMicrotask(() => this.release(capture));
  }
  private release(capture: Capture) {
    capture.controller.abort();
    capture.manager?.handleCancel(capture.request.captureId); capture.manager = null;
    capture.release?.(); capture.release = null; capture.chunks.clear();
  }
  async synthesize(request: VoiceSpeechRequest): Promise<VoiceSpeech> {
    this.admit(request?.sessionId); this.admitOnline(request.onlineConsent); identity(request.speechId, "재생");
    if (typeof request.text !== "string" || !request.text.trim() || request.text.length > limits.maxSpeechCharacters) fail(400, "읽을 텍스트는 1~4000자로 선택해 주세요.");
    const existing = this.speeches.get(request.speechId);
    if (existing) {
      if (JSON.stringify(existing.request) !== JSON.stringify(request)) fail(409, "이미 다른 음성 재생에 사용한 ID입니다.");
      return existing.promise;
    }
    if ([...this.speeches.values()].filter(task => !task.finished).length >= 2) fail(429, "진행 중인 음성 읽기를 먼저 중지해 주세요.");
    if (this.speeches.size >= 1024) fail(429, "음성 요청 기록 한도에 도달했습니다. 호스트를 다시 시작한 뒤 사용해 주세요.");
    const controller = new AbortController();
    const provider = this.providers?.tts?.(controller.signal) ?? new OpenAITTS({ apiKey: this.key(), model: "tts-1", voice: "alloy", responseFormat: "wav", signal: controller.signal }, logger);
    const task: SpeechTask = { request: { ...request }, controller, finished: false, finishedAt: null, released: false, promise: Promise.resolve(null as never) };
    task.promise = (async () => {
      const result = await provider.synthesizeSpeech(request.text); controller.signal.throwIfAborted();
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of result.stream) {
        controller.signal.throwIfAborted(); const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length; if (size > limits.maxCaptureBytes) { result.stream.destroy(); fail(413, "음성 응답이 너무 큽니다."); } chunks.push(bytes);
      }
      controller.signal.throwIfAborted();
      return { speechId: request.speechId, audioBase64: Buffer.concat(chunks).toString("base64"), mimeType: "audio/wav", format: "wav" as const, sampleRate: 24000 as const };
    })().finally(() => { task.finished = true; task.finishedAt = Date.now(); });
    this.speeches.set(request.speechId, task);
    // Repeated IDs never initiate a second paid request; cancellation remains a tombstone.
    void task.promise.catch(() => undefined);
    return task.promise;
  }
  cancelSpeech(id: string) { this.speeches.get(id)?.controller.abort(); return { ok: true as const }; }
  speechSessionId(id: string): string | null { return this.speeches.get(id)?.request.sessionId ?? null; }
  close() {
    this.closed = true; clearInterval(this.timer); this.models.close();
    for (const capture of this.captures.values()) this.release(capture);
    for (const task of this.speeches.values()) task.controller.abort();
    this.captures.clear(); this.speeches.clear();
  }
  private capture(id: string) {
    const value = this.captures.get(id); if (!value) return fail(404, "이 녹음은 종료되었거나 현재 호스트에 없습니다."); return value;
  }
  private admit(sessionId: string) {
    if (this.closed || !this.settings.enabled) fail(409, "음성 기능이 꺼져 있습니다. 설정에서 직접 켜 주세요.");
    identity(sessionId, "대화"); if (!this.sessionExists(sessionId)) fail(404, "현재 호스트의 활성 대화를 찾을 수 없습니다.");
  }
  private admitOnline(accepted: boolean) {
    if (!this.settings.onlineConsent || accepted !== true) fail(409, "온라인 음성의 전송 대상과 API 비용에 먼저 동의해 주세요.");
    if (!this.key()) fail(409, "호스트에 OpenAI API 키를 설정해 주세요.");
  }
  private key() { return this.apiKey || process.env.OPENAI_API_KEY || ""; }
  private async stt(modelId: string, signal: AbortSignal): Promise<ProviderHandle> {
    if (this.providers?.stt) return this.providers.stt(modelId, signal);
    if (modelId === "openai-whisper-1") return { provider: new OpenAISTT({ apiKey: this.key(), model: "whisper-1", signal }, logger), close() {} };
    const paths = await this.models.requireLocal(); signal.throwIfAborted();
    // Packaged host bundles have a separate original worker entry; source runs use the selected emit.
    const workerPath = import.meta.url.endsWith(".mjs") ? fileURLToPath(new URL("./voice-worker.mjs", import.meta.url))
      : createRequire(import.meta.url).resolve("@workbench/paseo-voice-server/worker-entry");
    const client = new LocalSpeechWorkerClient({ config: { modelsDir: paths.modelsDir, dictationSttModel: "whisper-base", voiceSttModel: "whisper-base", voiceTtsModel: "kokoro-en-v0_19" },
      runtimeNodeModules: paths.runtimeNodeModules, logger, requestTimeoutMs: 120_000, idleTtlMs: 1000,
      forkWorker: () => {
        const env = { ...process.env, NODE_PATH: paths.runtimeNodeModules };
        applySherpaLoaderEnv(env, process.platform, process.arch, paths.runtimeNodeModules);
        return fork(workerPath, [], { env, execArgv: [], serialization: "advanced", stdio: ["ignore", "ignore", "pipe", "ipc"] });
      } });
    return { provider: new WorkerBackedSpeechToTextProvider(client, "dictationStt"), close: () => client.shutdown() };
  }
  private prune() {
    const cutoff = Date.now() - 5 * 60_000;
    for (const [id, capture] of this.captures) if (capture.touchedAt < cutoff) { this.release(capture); this.captures.delete(id); }
    // Retain only short-lived in-memory response receipts, then discard audio but never replay paid IDs.
    for (const task of this.speeches.values()) if (!task.released && task.finishedAt !== null && task.finishedAt < Date.now() - 60_000) {
      task.released = true;
      task.promise = Promise.reject(new VoiceServiceError(410, "음성 응답 보관 시간이 지났습니다. 새로 읽으려면 직접 다시 선택해 주세요."));
      void task.promise.catch(() => undefined);
    }
  }
}
