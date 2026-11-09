import type pino from "pino";
import type { SpeechStreamResult, TextToSpeechProvider } from "../../speech-provider.js";
export type { SpeechStreamResult };
export interface TTSConfig {
    apiKey: string;
    signal?: AbortSignal;
    maxRetries?: number;
    baseUrl?: string;
    model?: "tts-1" | "tts-1-hd" | (string & {});
    voice?: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer" | (string & {});
    responseFormat?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
}
export declare class OpenAITTS implements TextToSpeechProvider {
    private readonly openaiClient;
    private readonly config;
    private readonly logger;
    constructor(ttsConfig: TTSConfig, parentLogger: pino.Logger);
    getConfig(): TTSConfig;
    synthesizeSpeech(text: string): Promise<SpeechStreamResult>;
}
