import { ensureSherpaOnnxModels, getSherpaOnnxModelDir } from "./sherpa/model-downloader.js";
import { DEFAULT_LOCAL_STT_MODEL, DEFAULT_LOCAL_TTS_MODEL, LocalSpeechModelIdSchema, LocalSttModelIdSchema, LocalTtsModelIdSchema, listSherpaOnnxModels, } from "./sherpa/model-catalog.js";
export { DEFAULT_LOCAL_STT_MODEL, DEFAULT_LOCAL_TTS_MODEL, LocalSpeechModelIdSchema, LocalSttModelIdSchema, LocalTtsModelIdSchema, };
export function listLocalSpeechModels() {
    return listSherpaOnnxModels();
}
export function getLocalSpeechModelDir(modelsDir, modelId) {
    return getSherpaOnnxModelDir(modelsDir, modelId);
}
export async function ensureLocalSpeechModels(options) {
    return ensureSherpaOnnxModels({
        modelsDir: options.modelsDir,
        modelIds: options.modelIds,
        logger: options.logger,
        signal: options.signal,
    });
}
