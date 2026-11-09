import { createAudioEngine } from "../../../../vendor/paseo/voice-web/audio-engine.web.ts";
import { DictationStreamSender, type DictationStreamClient } from "../../../../vendor/paseo/voice-web/dictation-stream-sender.ts";
import type { AudioEngine, AudioEngineCallbacks, AudioEngineOptions } from "../../../../vendor/paseo/voice-web/audio-engine-types.ts";
import type { VoiceCapture, VoiceCaptureStart } from "../../../../packages/contracts/src/voice.ts";
import type { Api } from "../api.ts";

export const PCM_DICTATION_FORMAT = "audio/pcm;rate=16000;bits=16";
export type VoiceScope = { workId: string; sessionId: string };
export type CaptureView = { phase: "idle" | "starting" | "recording" | "transcribing" | "ready" | "cancelled" | "error"; text: string; volume: number; error: string | null };
export type VoiceApi = Pick<Api, "request">;
type RawHandler = Parameters<DictationStreamClient["subscribeRawMessages"]>[0];
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** HTTP adapts the original start/chunk/ack/final protocol; ordering stays in Paseo's sender. */
export class HttpDictationClient implements DictationStreamClient {
  private closed = false;
  private handlers = new Set<RawHandler>();
  private cursor = 0;
  private chunks: Promise<void> = Promise.resolve();
  private failure: Error | null = null;
  private start: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private api: VoiceApi;
  private identity: Omit<VoiceCaptureStart, "captureId" | "format">;
  private onError: (error: Error) => void;
  constructor(api: VoiceApi, identity: Omit<VoiceCaptureStart, "captureId" | "format">, onError: (error: Error) => void) {
    this.api = api; this.identity = identity; this.onError = onError;
  }
  get isConnected() { return !this.closed && !this.failure; }
  subscribeRawMessages(handler: RawHandler) { this.handlers.add(handler); return () => { this.handlers.delete(handler); }; }
  private consume(value: VoiceCapture) {
    if (this.closed) return value;
    for (const entry of value.messages) {
      if (entry.sequence <= this.cursor) continue;
      this.cursor = entry.sequence;
      for (const handler of this.handlers) handler(entry.message);
    }
    this.cursor = Math.max(this.cursor, value.cursor);
    if (value.state.phase === "error") throw new Error(value.state.error || "음성 변환에 실패했습니다.");
    return value;
  }
  private path(id: string, suffix = "") { return `/api/voice/captures/${encodeURIComponent(id)}${suffix}?after=${this.cursor}`; }
  startDictationStream(id: string, format: string) {
    this.start = this.api.request<VoiceCapture>("POST", "/api/voice/captures", { ...this.identity, captureId: id, format }).then(value => { this.consume(value); });
    return this.start;
  }
  sendDictationStreamChunk(id: string, seq: number, audioBase64: string, format: string) {
    if (!this.isConnected) throw this.failure || new Error("받아쓰기가 취소되었습니다.");
    this.chunks = this.chunks.then(async () => {
      if (!this.isConnected) return;
      this.consume(await this.api.request<VoiceCapture>("POST", this.path(id, "/chunks"), { seq, audioBase64, format }));
    }).catch(error => {
      if (this.closed) return;
      this.failure = new Error(message(error)); this.onError(this.failure);
    });
  }
  async finishDictationStream(id: string, finalSeq: number) {
    await this.chunks;
    if (!this.isConnected) throw this.failure || new Error("받아쓰기가 취소되었습니다.");
    let value = this.consume(await this.api.request<VoiceCapture>("POST", this.path(id, "/finish"), { finalSeq }));
    while (value.state.phase === "transcribing" || value.state.phase === "recording") {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { this.wake = null; resolve(); }, 500);
        this.wake = () => { clearTimeout(timer); this.wake = null; resolve(); };
      });
      if (!this.isConnected) throw this.failure || new Error("받아쓰기가 취소되었습니다.");
      value = this.consume(await this.api.request<VoiceCapture>("GET", this.path(id)));
    }
    if (this.closed || value.state.phase !== "ready") throw new Error(value.state.error || "받아쓰기가 취소되었습니다.");
    return { dictationId: id, text: value.state.text };
  }
  cancelDictationStream(id: string) {
    this.closed = true; this.wake?.();
    // Cancellation may race the start response. Delete the admitted capture after start settles.
    void (this.start ?? Promise.resolve()).catch(() => undefined).then(() => this.api.request<VoiceCapture>("POST", this.path(id, "/cancel"), {})).catch(() => undefined);
  }
}

export function pcmBase64(bytes: Uint8Array) {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return btoa(binary);
}

type Run = { generation: number; engine: AudioEngine; sender: DictationStreamSender; bytes: number };
export class VoiceCaptureController {
  private generation = 0;
  private active: Run | null = null;
  private view: CaptureView = { phase: "idle", text: "", volume: 0, error: null };
  private api: VoiceApi;
  private changed: (view: CaptureView) => void;
  private engineFactory: (callbacks: AudioEngineCallbacks, options: AudioEngineOptions) => AudioEngine;
  constructor(api: VoiceApi, changed: (view: CaptureView) => void,
    engineFactory: (callbacks: AudioEngineCallbacks, options: AudioEngineOptions) => AudioEngine = createAudioEngine) {
    this.api = api; this.changed = changed; this.engineFactory = engineFactory;
  }
  private update(next: Partial<CaptureView>) { this.view = { ...this.view, ...next }; this.changed(this.view); }
  async begin(input: { draftId: string; sessionId: string; onlineConsent: boolean; maxCaptureBytes: number }) {
    this.cancel(false);
    const generation = ++this.generation;
    this.update({ phase: "starting", text: "", volume: 0, error: null });
    const valid = () => this.active?.generation === generation;
    const fail = (error: Error) => { if (valid()) { this.cancel(false); this.update({ phase: "error", error: error.message, volume: 0 }); } };
    const client = new HttpDictationClient(this.api, { draftId: input.draftId, generation, sessionId: input.sessionId, onlineConsent: input.onlineConsent }, fail);
    const sender = new DictationStreamSender({ client, format: PCM_DICTATION_FORMAT });
    const engine = this.engineFactory({
      onCaptureData: bytes => {
        const run = this.active;
        if (!run || run.generation !== generation || !["starting", "recording"].includes(this.view.phase)) return;
        run.bytes += bytes.byteLength;
        if (run.bytes > input.maxCaptureBytes) { fail(new Error("음성 길이 한도에 도달했습니다. 짧게 나누어 녹음해 주세요.")); return; }
        sender.enqueueSegment(pcmBase64(bytes));
      },
      onVolumeLevel: volume => { if (valid()) this.update({ volume }); },
      onError: fail,
      onInterruption: () => fail(new Error("마이크 사용이 중단되었습니다. 다시 녹음해 주세요.")),
    }, { captureMode: "dictation", traceLabel: "workbench-dictation" });
    this.active = { generation, sender, engine, bytes: 0 };
    try {
      // Both original entrypoints start inside the click gesture. Waiting for HTTP first can
      // leave mobile AudioContext.resume blocked. A late permission grant still owns its engine.
      const admission = sender.restartStream("record-button");
      const microphone = engine.startCapture().then(async () => { if (!valid()) await engine.destroy(); });
      await Promise.all([admission, microphone]);
      if (!valid()) return;
      this.update({ phase: "recording" });
    } catch (error) { fail(new Error(message(error))); }
  }
  async finish() {
    const run = this.active;
    if (!run || this.view.phase !== "recording") return;
    this.update({ phase: "transcribing", volume: 0 });
    try {
      await run.engine.stopCapture();
      const result = await run.sender.finish(run.sender.getFinalSeq());
      if (this.active !== run) return;
      this.update({ phase: "ready", text: result.text });
      run.sender.dispose(); await run.engine.destroy(); if (this.active === run) this.active = null;
    } catch (error) {
      if (this.active !== run) return;
      this.cancel(false); this.update({ phase: "error", error: message(error), volume: 0 });
    }
  }
  cancel(notify = true) {
    this.generation += 1;
    const run = this.active; this.active = null;
    if (run) { run.sender.cancel(); run.sender.clearAll(); run.sender.dispose(); void run.engine.destroy().catch(() => undefined); }
    if (notify) this.update({ phase: "cancelled", text: "", volume: 0, error: null });
  }
}

/** Applying is explicit and appends to the current draft, never the text at capture start. */
export function appendVoiceTranscript(current: { key: string; text: string }, draftId: string, transcript: string): string | null {
  if (current.key !== draftId || !transcript.trim()) return null;
  return `${current.text}${current.text && !/\s$/.test(current.text) ? "\n" : ""}${transcript.trim()}`;
}
