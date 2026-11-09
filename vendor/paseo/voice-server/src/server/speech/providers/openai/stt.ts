// Workbench adaptation; original bytes and change list are preserved in upstream/ and source.json.
import { EventEmitter } from "node:events";
import type pino from "pino";
import { OpenAI, toFile } from "openai";
import { v4 } from "uuid";
import { inferAudioExtension } from "../../../agent/audio-utils.js";
import type {
  LogprobToken,
  SpeechToTextProvider,
  StreamingTranscriptionSession,
  TranscriptionResult,
} from "../../speech-provider.js";

export type { LogprobToken, TranscriptionResult };

export interface STTConfig {
  apiKey: string;
  signal?: AbortSignal;
  maxRetries?: number;
  baseUrl?: string;
  model?: "whisper-1" | "gpt-4o-transcribe" | "gpt-4o-mini-transcribe" | (string & {});
  confidenceThreshold?: number; // Default: -3.0
}

function isObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null;
}

function isLogprobToken(value: unknown): value is LogprobToken {
  if (!isObject(value)) {
    return false;
  }
  if (typeof value.token !== "string") {
    return false;
  }
  if (typeof value.logprob !== "number") {
    return false;
  }
  if (value.bytes === undefined) {
    return true;
  }
  return Array.isArray(value.bytes) && value.bytes.every((entry) => typeof entry === "number");
}

function isLogprobTokenArray(value: unknown): value is LogprobToken[] {
  return Array.isArray(value) && value.every((entry) => isLogprobToken(entry));
}

export class OpenAISTT implements SpeechToTextProvider {
  private readonly openaiClient: OpenAI;
  private readonly config: STTConfig;
  private readonly logger: pino.Logger;
  public readonly id = "openai" as const;

  constructor(sttConfig: STTConfig, parentLogger: pino.Logger) {
    this.config = sttConfig;
    this.logger = parentLogger.child({ module: "agent", provider: "openai", component: "stt" });
    this.openaiClient = new OpenAI({
      apiKey: sttConfig.apiKey,
      maxRetries: sttConfig.maxRetries ?? 0,
      timeout: 120_000,
      ...(sttConfig.baseUrl ? { baseURL: sttConfig.baseUrl } : {}),
    });
    this.logger.info({ model: sttConfig.model || "whisper-1" }, "STT (OpenAI Whisper) initialized");
  }

  public createSession(params: {
    logger: pino.Logger;
    language?: string;
    prompt?: string;
  }): StreamingTranscriptionSession {
    const emitter = new EventEmitter();
    const logger = params.logger.child({ provider: "openai", component: "stt-session" });
    const requiredSampleRate = 24000;

    let connected = false;
    let segmentId = v4();
    let previousSegmentId: string | null = null;
    let pcm16: Buffer = Buffer.alloc(0);
    const transcribeAudio = this.transcribeAudioInternal.bind(this);

    const convertPCMToWavBuffer = (pcmBuffer: Buffer): Buffer => {
      const headerSize = 44;
      const channels = 1;
      const bitsPerSample = 16;
      const sampleRate = requiredSampleRate;
      const wavBuffer = Buffer.alloc(headerSize + pcmBuffer.length);
      const byteRate = (sampleRate * channels * bitsPerSample) / 8;
      const blockAlign = (channels * bitsPerSample) / 8;

      wavBuffer.write("RIFF", 0);
      wavBuffer.writeUInt32LE(36 + pcmBuffer.length, 4);
      wavBuffer.write("WAVE", 8);
      wavBuffer.write("fmt ", 12);
      wavBuffer.writeUInt32LE(16, 16);
      wavBuffer.writeUInt16LE(1, 20);
      wavBuffer.writeUInt16LE(channels, 22);
      wavBuffer.writeUInt32LE(sampleRate, 24);
      wavBuffer.writeUInt32LE(byteRate, 28);
      wavBuffer.writeUInt16LE(blockAlign, 32);
      wavBuffer.writeUInt16LE(bitsPerSample, 34);
      wavBuffer.write("data", 36);
      wavBuffer.writeUInt32LE(pcmBuffer.length, 40);
      pcmBuffer.copy(wavBuffer, 44);

      return wavBuffer;
    };

    return {
      requiredSampleRate,
      async connect() {
        connected = true;
      },
      appendPcm16(chunk: Buffer) {
        if (!connected) {
          emitter.emit("error", new Error("STT session not connected"));
          return;
        }
        pcm16 = pcm16.length === 0 ? chunk : Buffer.concat([pcm16, chunk]);
      },
      commit() {
        if (!connected) {
          emitter.emit("error", new Error("STT session not connected"));
          return;
        }

        const committedId = segmentId;
        const prev = previousSegmentId;
        emitter.emit("committed", { segmentId: committedId, previousSegmentId: prev });

        void (async () => {
          try {
            if (pcm16.length === 0) {
              emitter.emit("transcript", {
                segmentId: committedId,
                transcript: "",
                isFinal: true,
                language: params.language,
                isLowConfidence: true,
              });
              return;
            }

            const wav = convertPCMToWavBuffer(pcm16);
            const result = await transcribeAudio(
              wav,
              "audio/wav",
              params.language ?? "en",
              logger,
              params.prompt,
            );

            emitter.emit("transcript", {
              segmentId: committedId,
              transcript: result.text,
              isFinal: true,
              language: result.language,
              logprobs: result.logprobs,
              avgLogprob: result.avgLogprob,
              isLowConfidence: result.isLowConfidence,
            });
          } catch (err) {
            emitter.emit("error", err);
          } finally {
            previousSegmentId = committedId;
            segmentId = v4();
            pcm16 = Buffer.alloc(0);
          }
        })();
      },
      clear() {
        pcm16 = Buffer.alloc(0);
        segmentId = v4();
      },
      close() {
        connected = false;
        pcm16 = Buffer.alloc(0);
      },
      on(event: string, handler: (...args: never[]) => void) {
        emitter.on(event, handler as (...args: unknown[]) => void);
        return undefined;
      },
    };
  }

  private async transcribeAudioInternal(
    audioBuffer: Buffer,
    format: string,
    language: string,
    logger: pino.Logger,
    prompt?: string,
  ): Promise<TranscriptionResult> {
    const startTime = Date.now();

    try {
      const ext = inferAudioExtension(format);
      const modelToUse = this.config.model ?? "whisper-1";
      const supportsLogprobs =
        modelToUse === "gpt-4o-transcribe" || modelToUse === "gpt-4o-mini-transcribe";
      const includeLogprobs: ["logprobs"] = ["logprobs"];

      const response = await this.openaiClient.audio.transcriptions.create({
        file: await toFile(audioBuffer, `audio.${ext}`, { type: format }),
        language,
        model: modelToUse,
        ...(prompt ? { prompt } : {}),
        ...(supportsLogprobs ? { include: includeLogprobs } : {}),
        response_format: "json",
      }, { signal: this.config.signal });

      const duration = Date.now() - startTime;
      const confidenceThreshold = this.config.confidenceThreshold ?? -3.0;

      let avgLogprob: number | undefined;
      let isLowConfidence = false;
      const logprobs =
        supportsLogprobs && isObject(response) && isLogprobTokenArray(response.logprobs)
          ? response.logprobs
          : undefined;

      if (logprobs && logprobs.length > 0) {
        const totalLogprob = logprobs.reduce((sum, token) => sum + token.logprob, 0);
        avgLogprob = totalLogprob / logprobs.length;
        isLowConfidence = avgLogprob < confidenceThreshold;

        if (isLowConfidence) {
          logger.debug(
            {
              avgLogprob,
              threshold: confidenceThreshold,
            },
            "Low confidence transcription detected",
          );
        }
      }

      logger.debug({ duration, textLength: response.text.length, avgLogprob }, "Transcription complete");

      return {
        text: response.text,
        duration: duration,
        logprobs: logprobs,
        avgLogprob: avgLogprob,
        isLowConfidence: isLowConfidence,
        language:
          isObject(response) && typeof response.language === "string"
            ? response.language
            : undefined,
      };
    } catch (error) {
      logger.error({ err: error }, "Transcription error");
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`STT transcription failed: ${message}`, { cause: error });
    }
  }
}
