import type pino from "pino";
import type { SpeechStreamResult, TextToSpeechProvider } from "../../../speech-provider.js";
import { loadSherpaOnnxNode } from "./sherpa-onnx-node-loader.js";
import { type LocalTtsModelId, type TtsEngine } from "./model-catalog.js";
export interface SherpaTtsConfig {
    modelId: LocalTtsModelId;
    modelDir: string;
    engine: TtsEngine;
    speakerId?: number;
    speed?: number;
    lengthScale?: number;
    numThreads?: number;
}
export declare class SherpaOnnxTTS implements TextToSpeechProvider {
    private readonly tts;
    private readonly speakerId;
    private readonly speed;
    private readonly logger;
    private synthesisQueue;
    private closed;
    constructor(config: SherpaTtsConfig, logger: pino.Logger, loadNative?: () => Pick<ReturnType<typeof loadSherpaOnnxNode>, "OfflineTts">);
    synthesizeSpeech(text: string): Promise<SpeechStreamResult>;
    private generateSpeech;
    free(): void;
}
