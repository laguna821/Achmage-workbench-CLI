import { OpenAI } from "openai";
import { Readable } from "node:stream";
export class OpenAITTS {
    openaiClient;
    config;
    logger;
    constructor(ttsConfig, parentLogger) {
        this.config = {
            model: "tts-1",
            voice: "alloy",
            responseFormat: "pcm",
            ...ttsConfig,
        };
        this.logger = parentLogger.child({ module: "agent", provider: "openai", component: "tts" });
        this.openaiClient = new OpenAI({
            apiKey: ttsConfig.apiKey,
            maxRetries: ttsConfig.maxRetries ?? 0,
            timeout: 120_000,
            ...(ttsConfig.baseUrl ? { baseURL: ttsConfig.baseUrl } : {}),
        });
        this.logger.info({ voice: this.config.voice, model: this.config.model, format: this.config.responseFormat }, "TTS (OpenAI) initialized");
    }
    getConfig() {
        return this.config;
    }
    async synthesizeSpeech(text) {
        if (!text || text.trim().length === 0) {
            throw new Error("Cannot synthesize empty text");
        }
        const startTime = Date.now();
        try {
            this.logger.debug({ textLength: text.length }, "Synthesizing speech");
            const response = await this.openaiClient.audio.speech.create({
                model: this.config.model,
                voice: this.config.voice,
                input: text,
                response_format: this.config.responseFormat,
            }, { signal: this.config.signal });
            // Prefetched speech can wait through playback of an earlier sentence. Consume
            // the response here so fetch cannot collect it and cancel its unread body.
            const audioStream = Readable.from([Buffer.from(await response.arrayBuffer())]);
            const duration = Date.now() - startTime;
            this.logger.debug({ duration }, "Speech synthesis stream ready");
            return {
                stream: audioStream,
                format: this.config.responseFormat || "mp3",
            };
        }
        catch (error) {
            this.logger.error({ err: error }, "Speech synthesis error");
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`TTS synthesis failed: ${message}`, { cause: error });
        }
    }
}
