import type pino from "pino";
import { type SttEngine } from "./model-catalog.js";
export interface SherpaOfflineRecognizerConfig {
    modelDir: string;
    engine: SttEngine;
    numThreads?: number;
    provider?: "cpu";
    debug?: 0 | 1;
    sampleRate?: number;
    featureDim?: number;
    decodingMethod?: "greedy_search";
    maxActivePaths?: number;
}
interface SherpaOfflineRecognizerNative {
    config?: {
        featConfig?: {
            sampleRate?: number;
        };
    };
    createStream: () => unknown;
    decode: (stream: unknown) => void;
    getResult: (stream: unknown) => {
        text?: string;
    } | string | undefined;
    free?: () => void;
}
interface SherpaOfflineStreamNative {
    acceptWaveform: ((arg: {
        samples: Float32Array;
        sampleRate: number;
    }) => void) & ((sampleRate: number, samples: Float32Array) => void);
    free?: () => void;
}
export declare class SherpaOfflineRecognizerEngine {
    readonly recognizer: SherpaOfflineRecognizerNative;
    readonly sampleRate: number;
    private readonly logger;
    constructor(config: SherpaOfflineRecognizerConfig, logger: pino.Logger);
    createStream(): SherpaOfflineStreamNative;
    acceptWaveform(stream: SherpaOfflineStreamNative, sampleRate: number, samples: Float32Array): void;
    free(): void;
}
export {};
