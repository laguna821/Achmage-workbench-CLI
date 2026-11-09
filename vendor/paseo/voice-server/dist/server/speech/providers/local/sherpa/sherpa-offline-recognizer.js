import { existsSync } from "node:fs";
import path from "node:path";
import { engineFiles } from "./model-catalog.js";
import { loadSherpaOnnxNode } from "./sherpa-onnx-node-loader.js";
function assertFileExists(filePath, label) {
    if (!existsSync(filePath)) {
        throw new Error(`Missing ${label}: ${filePath}`);
    }
}
// Each engine family takes its own block under sherpa's modelConfig.
function buildModelConfig(modelDir, engine) {
    const file = (name) => path.join(modelDir, name);
    switch (engine.family) {
        case "transducer":
            return {
                transducer: {
                    encoder: file(engine.encoder),
                    decoder: file(engine.decoder),
                    joiner: file(engine.joiner),
                },
                modelType: "nemo_transducer",
            };
        case "whisper":
            // An empty language makes Whisper detect the spoken language.
            return {
                whisper: {
                    encoder: file(engine.encoder),
                    decoder: file(engine.decoder),
                    language: "",
                    task: "transcribe",
                },
            };
        case "sense_voice":
            return {
                senseVoice: { model: file(engine.model), language: "", useInverseTextNormalization: 1 },
            };
        case "dolphin":
            return { dolphin: { model: file(engine.model) } };
        case "nemo_ctc":
            return { nemoCtc: { model: file(engine.model) } };
    }
}
export class SherpaOfflineRecognizerEngine {
    recognizer;
    sampleRate;
    logger;
    constructor(config, logger) {
        this.logger = logger.child({
            module: "speech",
            provider: "local",
            component: "offline-recognizer",
        });
        for (const name of engineFiles(config.engine)) {
            assertFileExists(path.join(config.modelDir, name), `${config.engine.family} model file`);
        }
        const sherpa = loadSherpaOnnxNode();
        const recognizerConfig = {
            featConfig: {
                sampleRate: config.sampleRate ?? 16000,
                featureDim: config.featureDim ?? 80,
            },
            modelConfig: {
                ...buildModelConfig(config.modelDir, config.engine),
                tokens: path.join(config.modelDir, config.engine.tokens),
                numThreads: config.numThreads ?? 1,
                provider: config.provider ?? "cpu",
                debug: config.debug ?? 0,
            },
            decodingMethod: config.decodingMethod ?? "greedy_search",
            maxActivePaths: config.maxActivePaths ?? 4,
        };
        this.recognizer = new sherpa.OfflineRecognizer(recognizerConfig);
        const sr = this.recognizer?.config?.featConfig?.sampleRate;
        this.sampleRate =
            typeof sr === "number" && Number.isFinite(sr) && sr > 0
                ? sr
                : recognizerConfig.featConfig.sampleRate;
        this.logger.info({ sampleRate: this.sampleRate, numThreads: recognizerConfig.modelConfig.numThreads }, "Sherpa offline recognizer initialized");
    }
    createStream() {
        return this.recognizer.createStream();
    }
    acceptWaveform(stream, sampleRate, samples) {
        if (!stream || typeof stream.acceptWaveform !== "function") {
            throw new Error("Unexpected sherpa offline stream: missing acceptWaveform()");
        }
        // sherpa-onnx-node expects: acceptWaveform({ samples, sampleRate })
        // sherpa-onnx (WASM) expects: acceptWaveform(sampleRate, samples)
        if (stream.acceptWaveform.length <= 1) {
            stream.acceptWaveform({ samples, sampleRate });
        }
        else {
            stream.acceptWaveform(sampleRate, samples);
        }
    }
    free() {
        try {
            this.recognizer?.free?.();
        }
        catch (err) {
            this.logger.warn({ err }, "Failed to free sherpa offline recognizer");
        }
    }
}
