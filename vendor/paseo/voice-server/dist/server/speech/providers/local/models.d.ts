import { DEFAULT_LOCAL_STT_MODEL, DEFAULT_LOCAL_TTS_MODEL, LocalSpeechModelIdSchema, LocalSttModelIdSchema, LocalTtsModelIdSchema, listSherpaOnnxModels, type LocalSpeechModelId, type LocalSttModelId, type LocalTtsModelId } from "./sherpa/model-catalog.js";
export { DEFAULT_LOCAL_STT_MODEL, DEFAULT_LOCAL_TTS_MODEL, LocalSpeechModelIdSchema, LocalSttModelIdSchema, LocalTtsModelIdSchema, type LocalSpeechModelId, type LocalSttModelId, type LocalTtsModelId, };
export type LocalSpeechModelSpec = ReturnType<typeof listSherpaOnnxModels>[number];
export declare function listLocalSpeechModels(): LocalSpeechModelSpec[];
export declare function getLocalSpeechModelDir(modelsDir: string, modelId: LocalSpeechModelId): string;
export declare function ensureLocalSpeechModels(options: {
    modelsDir: string;
    modelIds: LocalSpeechModelId[];
    logger: import("pino").Logger;
    signal?: AbortSignal;
}): Promise<Record<LocalSpeechModelId, string>>;
