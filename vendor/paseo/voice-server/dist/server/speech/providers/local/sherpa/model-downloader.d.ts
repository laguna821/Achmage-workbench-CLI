import type pino from "pino";
import { type SherpaOnnxModelId } from "./model-catalog.js";
export type SherpaOnnxModelInstallProgress = {
    phase: "downloading";
    receivedBytes: number;
    totalBytes: number;
} | {
    phase: "extracting";
};
export interface EnsureSherpaOnnxModelOptions {
    modelsDir: string;
    modelId: SherpaOnnxModelId;
    logger: pino.Logger;
    signal?: AbortSignal;
    onProgress?: (progress: SherpaOnnxModelInstallProgress) => void;
    expectedSha256?: string;
}
export declare function getSherpaOnnxModelDir(modelsDir: string, modelId: SherpaOnnxModelId): string;
export interface DownloadToFileOptions {
    url: string;
    outputPath: string;
    expectedBytes: number;
    expectedSha256?: string;
    integrity?: string;
    maximumBytes?: number;
    signal?: AbortSignal;
    onProgress?: (receivedBytes: number, totalBytes: number) => void;
}
export declare function downloadToFile(options: DownloadToFileOptions): Promise<void>;
export declare function extractTarArchive(archivePath: string, destDir: string, signal?: AbortSignal): Promise<void>;
export declare function isSherpaOnnxModelInstalled(modelsDir: string, modelId: SherpaOnnxModelId): Promise<boolean>;
export declare function ensureSherpaOnnxModel(options: EnsureSherpaOnnxModelOptions): Promise<string>;
export declare function deleteSherpaOnnxModel(modelsDir: string, modelId: SherpaOnnxModelId): Promise<void>;
export declare function ensureSherpaOnnxModels(options: {
    modelsDir: string;
    modelIds: SherpaOnnxModelId[];
    logger: pino.Logger;
    signal?: AbortSignal;
}): Promise<Record<SherpaOnnxModelId, string>>;
/** Workbench verifies pins before extracting or activating optional voice downloads. */
export declare function verifyVoiceArchive(filePath: string, options: {
    expectedBytes: number;
    expectedSha256?: string;
    integrity?: string;
}): Promise<void>;
