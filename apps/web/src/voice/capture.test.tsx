import { describe, expect, it, vi } from "vitest";
import type { VoiceCapture, VoiceCaptureStart } from "../../../../packages/contracts/src/voice.ts";
import type { AudioEngine, AudioEngineCallbacks } from "../../../../vendor/paseo/voice-web/audio-engine-types.ts";
import { appendVoiceTranscript, PCM_DICTATION_FORMAT, VoiceCaptureController, type CaptureView, type VoiceApi } from "./capture.ts";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function server() {
  const calls: { method: string; path: string; body: unknown }[] = [];
  let capture: VoiceCapture;
  let finish: (() => Promise<VoiceCapture>) | null = null;
  const api: VoiceApi = { async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    calls.push({ method, path, body });
    if (path === "/api/voice/captures") {
      const input = body as VoiceCaptureStart;
      capture = { state: { captureId: input.captureId, draftId: input.draftId, generation: input.generation, sessionId: input.sessionId, phase: "recording", text: "", muted: false, error: null, modelId: "fake-local", language: "ko" }, messages: [], cursor: 0 };
    } else if (path.includes("/chunks?")) {
      const input = body as { seq: number };
      capture.messages.push({ sequence: ++capture.cursor, message: { type: "dictation_stream_ack", payload: { dictationId: capture.state.captureId, ackSeq: input.seq } } });
    } else if (path.includes("/finish?")) {
      if (finish) return await finish() as T;
      capture.state = { ...capture.state, phase: "ready", text: "받아쓴 내용" };
    } else if (path.includes("/cancel?")) capture.state = { ...capture.state, phase: "cancelled" };
    return structuredClone(capture!) as T;
  } };
  return { api, calls, get: () => structuredClone(capture), deferFinish: (action: () => Promise<VoiceCapture>) => { finish = action; } };
}
function microphone(start?: Promise<void>) {
  let callbacks!: AudioEngineCallbacks;
  const engine: AudioEngine = { initialize: vi.fn(async () => {}), destroy: vi.fn(async () => {}), startCapture: vi.fn(async () => { await start; }), stopCapture: vi.fn(async () => {}), toggleMute: () => false, isMuted: () => false, play: vi.fn(async () => 0), stop: vi.fn(), clearQueue: vi.fn(), isPlaying: () => false };
  return { engine, factory: (next: AudioEngineCallbacks) => { callbacks = next; return engine; }, emit: () => callbacks.onCaptureData(new Uint8Array([0x00, 0x01, 0x02, 0x03])) };
}
const input = { draftId: "work:project-a:session-a", sessionId: "session-a", onlineConsent: false, maxCaptureBytes: 1024 };

describe("Workbench adapter with the original Paseo dictation sender", () => {
  it("sends ordered PCM and ACKs, keeps the actual draft identity, then exposes text for review", async () => {
    const host = server(), mic = microphone(), views: CaptureView[] = [];
    const capture = new VoiceCaptureController(host.api, view => views.push(view), mic.factory);
    await capture.begin(input); mic.emit(); mic.emit(); await capture.finish();
    expect(host.calls[0]?.body).toMatchObject({ draftId: input.draftId, sessionId: input.sessionId, format: PCM_DICTATION_FORMAT, onlineConsent: false });
    expect(host.calls.filter(call => call.path.includes("/chunks?")).map(call => call.body)).toEqual([
      { seq: 0, audioBase64: "AAECAw==", format: PCM_DICTATION_FORMAT }, { seq: 1, audioBase64: "AAECAw==", format: PCM_DICTATION_FORMAT },
    ]);
    expect(host.calls.find(call => call.path.includes("/finish?"))?.body).toEqual({ finalSeq: 1 });
    expect(views.at(-1)).toMatchObject({ phase: "ready", text: "받아쓴 내용" });
    expect(mic.engine.stopCapture).toHaveBeenCalledOnce(); expect(mic.engine.play).not.toHaveBeenCalled();
    expect(appendVoiceTranscript({ key: input.draftId, text: "녹음 중 새로 타이핑한 내용" }, input.draftId, views.at(-1)!.text)).toBe("녹음 중 새로 타이핑한 내용\n받아쓴 내용");
  });
  it("closes an old permission-prompt capture when cancellation wins the start race", async () => {
    const permission = deferred<void>(), host = server(), mic = microphone(permission.promise), views: CaptureView[] = [];
    const capture = new VoiceCaptureController(host.api, view => views.push(view), mic.factory);
    const starting = capture.begin(input);
    await vi.waitFor(() => expect(mic.engine.startCapture).toHaveBeenCalledOnce());
    capture.cancel(); permission.resolve(); await starting;
    expect(mic.engine.destroy).toHaveBeenCalledTimes(2);
    expect(views.some(view => view.phase === "recording")).toBe(false);
    expect(views.at(-1)?.phase).toBe("cancelled");
  });
  it("discards a late final transcript after cancel and never applies it to another draft", async () => {
    const result = deferred<VoiceCapture>(), host = server(), mic = microphone(), views: CaptureView[] = [];
    host.deferFinish(() => result.promise);
    const capture = new VoiceCaptureController(host.api, view => views.push(view), mic.factory);
    await capture.begin(input); mic.emit(); const finishing = capture.finish();
    await vi.waitFor(() => expect(host.calls.some(call => call.path.includes("/finish?"))).toBe(true));
    const ready = host.get(); ready.state = { ...ready.state, phase: "ready", text: "늦게 도착" };
    capture.cancel(); result.resolve(ready); await finishing;
    expect(views.at(-1)?.phase).toBe("cancelled"); expect(views.some(view => view.phase === "ready")).toBe(false);
    expect(appendVoiceTranscript({ key: "work:project-b:session-b", text: "다른 초안" }, input.draftId, "늦게 도착")).toBeNull();
  });
  it("enforces the byte limit and releases the microphone without sending over-limit audio", async () => {
    const host = server(), mic = microphone(), views: CaptureView[] = [];
    const capture = new VoiceCaptureController(host.api, view => views.push(view), mic.factory);
    await capture.begin({ ...input, maxCaptureBytes: 2 }); mic.emit();
    expect(views.at(-1)?.phase).toBe("error"); expect(mic.engine.destroy).toHaveBeenCalled();
    expect(host.calls.some(call => call.path.includes("/chunks?"))).toBe(false);
  });
});
