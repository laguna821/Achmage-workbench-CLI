/** Audio is transient. Capture identity is independent of the conversation draft. */
export type VoiceCaptureState = {
  captureId: string; draftId: string; generation: number; sessionId: string;
  phase: "recording" | "transcribing" | "cancelled" | "ready" | "error";
  text: string; muted: boolean; error: string | null; modelId: string; language: string;
};
export type VoiceTranscript = {
  captureId: string; draftId: string; generation: number; language: string; text: string;
};
export function applyVoiceTranscript(state: VoiceCaptureState, result: VoiceTranscript): VoiceCaptureState {
  if (state.phase === "cancelled" || state.phase === "error" || state.captureId !== result.captureId ||
      state.draftId !== result.draftId || state.generation !== result.generation) return state;
  return { ...state, phase: "ready", text: result.text, language: result.language };
}
export interface VoiceCaptureSource {
  start(captureId: string): Promise<AsyncIterable<Uint8Array>>;
  stop(captureId: string): Promise<void>;
}
export type VoiceSettings = {
  enabled: boolean; sttModelId: string; ttsModelId: string; language: string; onlineConsent: boolean;
};
export type VoiceSettingsUpdate = Partial<VoiceSettings> & { apiKey?: string };
export type VoiceModel = {
  id: string; label: string; kind: "stt" | "tts"; online: boolean; languages: string[];
  license: string; sourceUrl: string; revision: string; sha256: string | null;
  downloadBytes: number; installedBytes: number | null; runtimeBytes: number | null;
  platforms: string[]; supported: boolean; installed: boolean;
  state: "available" | "missing" | "downloading" | "installed" | "error";
  receivedBytes: number; error: string | null; cost: string; destination: string | null;
};
export type VoiceStatus = {
  settings: VoiceSettings; models: VoiceModel[]; apiKeyConfigured: boolean;
  destination: string; audioRetention: "none"; localTtsLanguages: string[];
  limits: { maxCaptureBytes: number; maxChunkBytes: number; maxSpeechCharacters: number };
};
/** The original Paseo sender/ack/final message shapes are preserved. */
export type VoiceDictationMessage =
  | { type: "dictation_stream_ack"; payload: { dictationId: string; ackSeq: number } }
  | { type: "dictation_stream_finish_accepted"; payload: { dictationId: string; timeoutMs: number } }
  | { type: "dictation_stream_partial" | "dictation_stream_final"; payload: { dictationId: string; text: string } }
  | { type: "dictation_stream_error"; payload: { dictationId: string; error: string; retryable: boolean } };
export type VoiceCapture = { state: VoiceCaptureState; messages: { sequence: number; message: VoiceDictationMessage }[]; cursor: number };
export type VoiceCaptureStart = {
  captureId: string; draftId: string; generation: number; sessionId: string; format: string;
  onlineConsent: boolean;
};
export type VoiceCaptureChunk = { seq: number; audioBase64: string; format: string };
export type VoiceSpeechRequest = {
  speechId: string; sessionId: string; text: string; onlineConsent: boolean;
};
export type VoiceSpeech = { speechId: string; audioBase64: string; mimeType: string; format: "wav"; sampleRate: 24000 };
export type VoiceModelDownload = { modelId: string; accepted: true };
