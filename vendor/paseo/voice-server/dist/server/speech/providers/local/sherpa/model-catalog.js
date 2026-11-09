import { z } from "zod";
// Every sherpa-onnx release archive extracts to a directory named after the archive.
function releaseArchive(tag, name) {
    return {
        archiveUrl: `https://github.com/k2-fsa/sherpa-onnx/releases/download/${tag}/${name}.tar.bz2`,
        extractedDir: name,
    };
}
const PARAKEET_INT8_ENGINE = {
    family: "transducer",
    encoder: "encoder.int8.onnx",
    decoder: "decoder.int8.onnx",
    joiner: "joiner.int8.onnx",
    tokens: "tokens.txt",
};
function whisperEngine(size) {
    return {
        family: "whisper",
        encoder: `${size}-encoder.int8.onnx`,
        decoder: `${size}-decoder.int8.onnx`,
        tokens: `${size}-tokens.txt`,
    };
}
function piperEngine(voice) {
    return {
        family: "vits",
        model: `${voice}.onnx`,
        tokens: "tokens.txt",
        dataDir: "espeak-ng-data",
    };
}
// Parakeet TDT v3 transcribes these 25 European languages and detects which one is spoken.
const PARAKEET_V3_LANGUAGES = [
    "bg",
    "hr",
    "cs",
    "da",
    "nl",
    "en",
    "et",
    "fi",
    "fr",
    "de",
    "el",
    "hu",
    "it",
    "lv",
    "lt",
    "mt",
    "pl",
    "pt",
    "ro",
    "sk",
    "sl",
    "es",
    "sv",
    "ru",
    "uk",
];
// The 99 languages multilingual Whisper models transcribe, detecting which one is spoken.
const WHISPER_LANGUAGES = [
    "en",
    "zh",
    "de",
    "es",
    "ru",
    "ko",
    "fr",
    "ja",
    "pt",
    "tr",
    "pl",
    "ca",
    "nl",
    "ar",
    "sv",
    "it",
    "id",
    "hi",
    "fi",
    "vi",
    "he",
    "uk",
    "el",
    "ms",
    "cs",
    "ro",
    "da",
    "hu",
    "ta",
    "no",
    "th",
    "ur",
    "hr",
    "bg",
    "lt",
    "la",
    "mi",
    "ml",
    "cy",
    "sk",
    "te",
    "fa",
    "lv",
    "bn",
    "sr",
    "az",
    "sl",
    "kn",
    "et",
    "mk",
    "br",
    "eu",
    "is",
    "hy",
    "ne",
    "mn",
    "bs",
    "kk",
    "sq",
    "sw",
    "gl",
    "mr",
    "pa",
    "si",
    "km",
    "sn",
    "yo",
    "so",
    "af",
    "oc",
    "ka",
    "be",
    "tg",
    "sd",
    "gu",
    "am",
    "yi",
    "lo",
    "uz",
    "fo",
    "ht",
    "ps",
    "tk",
    "nn",
    "mt",
    "sa",
    "lb",
    "my",
    "bo",
    "tl",
    "mg",
    "as",
    "tt",
    "haw",
    "ln",
    "ha",
    "ba",
    "jv",
    "su",
];
// Dolphin's 40 Eastern languages. It also covers 22 Chinese dialects under "zh".
const DOLPHIN_LANGUAGES = [
    "zh",
    "ja",
    "th",
    "ru",
    "ko",
    "id",
    "vi",
    "yue",
    "hi",
    "ur",
    "ms",
    "uz",
    "ar",
    "fa",
    "bn",
    "ta",
    "te",
    "ug",
    "gu",
    "my",
    "tl",
    "kk",
    "or",
    "ne",
    "mn",
    "km",
    "jv",
    "lo",
    "si",
    "fil",
    "ps",
    "pa",
    "kab",
    "ba",
    "ks",
    "tg",
    "su",
    "mr",
    "ky",
    "az",
];
export const SHERPA_ONNX_MODEL_CATALOG = {
    "parakeet-tdt-0.6b-v2-int8": {
        kind: "stt-offline",
        label: "Parakeet v2",
        description: "Accurate English transcription that runs well on a laptop CPU.",
        languages: ["en"],
        downloadSizeBytes: 482_468_385,
        ...releaseArchive("asr-models", "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8"),
        engine: PARAKEET_INT8_ENGINE,
        defaultFor: "stt",
    },
    "parakeet-tdt-110m-en-int8": {
        kind: "stt-offline",
        label: "Parakeet Small",
        description: "Small, fast English model with punctuation. A quick download for any laptop.",
        languages: ["en"],
        downloadSizeBytes: 108_035_095,
        ...releaseArchive("asr-models", "sherpa-onnx-nemo-parakeet_tdt_transducer_110m-en-36000-int8"),
        engine: PARAKEET_INT8_ENGINE,
    },
    "parakeet-tdt-0.6b-v3-int8": {
        kind: "stt-offline",
        label: "Parakeet v3",
        description: "Parakeet for 25 European languages, detecting which one you speak.",
        languages: PARAKEET_V3_LANGUAGES,
        downloadSizeBytes: 487_170_055,
        ...releaseArchive("asr-models", "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8"),
        engine: PARAKEET_INT8_ENGINE,
    },
    "whisper-tiny-en": {
        kind: "stt-offline",
        label: "Whisper Tiny (English)",
        description: "Small English Whisper model. Quick to download, less accurate than Parakeet.",
        languages: ["en"],
        downloadSizeBytes: 118_071_777,
        ...releaseArchive("asr-models", "sherpa-onnx-whisper-tiny.en"),
        engine: whisperEngine("tiny.en"),
    },
    "whisper-base": {
        kind: "stt-offline",
        label: "Whisper Base",
        description: "Compact Whisper model for 99 languages, detecting which one you speak.",
        languages: WHISPER_LANGUAGES,
        downloadSizeBytes: 207_557_382,
        ...releaseArchive("asr-models", "sherpa-onnx-whisper-base"),
        engine: whisperEngine("base"),
    },
    "whisper-turbo": {
        kind: "stt-offline",
        label: "Whisper Turbo",
        description: "Whisper's most accurate model for 99 languages and Cantonese. Slower on a CPU.",
        languages: [...WHISPER_LANGUAGES, "yue"],
        downloadSizeBytes: 563_790_207,
        ...releaseArchive("asr-models", "sherpa-onnx-whisper-turbo"),
        engine: whisperEngine("turbo"),
    },
    "sense-voice-int8": {
        kind: "stt-offline",
        label: "SenseVoice",
        description: "Chinese, Cantonese, English, Japanese and Korean, detecting which one you speak.",
        languages: ["zh", "yue", "en", "ja", "ko"],
        downloadSizeBytes: 165_783_878,
        ...releaseArchive("asr-models", "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09"),
        engine: { family: "sense_voice", model: "model.int8.onnx", tokens: "tokens.txt" },
    },
    "dolphin-base-int8": {
        kind: "stt-offline",
        label: "Dolphin",
        description: "Small model for 40 Asian and Middle Eastern languages and Chinese dialects.",
        languages: DOLPHIN_LANGUAGES,
        downloadSizeBytes: 80_671_385,
        ...releaseArchive("asr-models", "sherpa-onnx-dolphin-base-ctc-multi-lang-int8-2025-04-02"),
        engine: { family: "dolphin", model: "model.int8.onnx", tokens: "tokens.txt" },
    },
    "giga-am-v3-ru": {
        kind: "stt-offline",
        label: "GigaAM v3 (Russian)",
        description: "Russian transcription with punctuation.",
        languages: ["ru"],
        downloadSizeBytes: 170_197_019,
        ...releaseArchive("asr-models", "sherpa-onnx-nemo-transducer-punct-giga-am-v3-russian-2025-12-16"),
        engine: {
            family: "transducer",
            encoder: "encoder.int8.onnx",
            decoder: "decoder.onnx",
            joiner: "joiner.onnx",
            tokens: "tokens.txt",
        },
    },
    "parakeet-tdt-ctc-0.6b-ja-int8": {
        kind: "stt-offline",
        label: "Parakeet (Japanese)",
        description: "Japanese transcription with punctuation.",
        languages: ["ja"],
        downloadSizeBytes: 489_389_564,
        ...releaseArchive("asr-models", "sherpa-onnx-nemo-parakeet-tdt_ctc-0.6b-ja-35000-int8"),
        engine: { family: "nemo_ctc", model: "model.int8.onnx", tokens: "tokens.txt" },
    },
    "kokoro-en-v0_19": {
        kind: "tts",
        label: "Kokoro (English)",
        description: "Natural-sounding English voice for voice mode replies.",
        languages: ["en"],
        downloadSizeBytes: 319_625_534,
        ...releaseArchive("tts-models", "kokoro-en-v0_19"),
        engine: {
            family: "kokoro",
            model: "model.onnx",
            voices: "voices.bin",
            tokens: "tokens.txt",
            dataDir: "espeak-ng-data",
        },
        defaultFor: "tts",
    },
    "kokoro-int8-en-v0_19": {
        kind: "tts",
        label: "Kokoro Lite (English)",
        description: "The same Kokoro English voices, quantized to a third of the download.",
        languages: ["en"],
        downloadSizeBytes: 103_248_205,
        ...releaseArchive("tts-models", "kokoro-int8-en-v0_19"),
        engine: {
            family: "kokoro",
            model: "model.int8.onnx",
            voices: "voices.bin",
            tokens: "tokens.txt",
            dataDir: "espeak-ng-data",
        },
    },
    "kokoro-int8-multi-lang-v1_1": {
        kind: "tts",
        label: "Kokoro (Chinese and English)",
        description: "Kokoro voices that speak both Mandarin Chinese and English.",
        languages: ["zh", "en"],
        downloadSizeBytes: 147_031_220,
        ...releaseArchive("tts-models", "kokoro-int8-multi-lang-v1_1"),
        engine: {
            family: "kokoro",
            model: "model.int8.onnx",
            voices: "voices.bin",
            tokens: "tokens.txt",
            dataDir: "espeak-ng-data",
            lexicons: ["lexicon-us-en.txt", "lexicon-zh.txt"],
            dictDir: "dict",
            ruleFsts: ["date-zh.fst", "phone-zh.fst", "number-zh.fst"],
        },
    },
    // Kitten v0.8 needs a newer sherpa-onnx than we pin; v0.2 loads on 1.12.28.
    "kitten-nano-en-v0_2-fp16": {
        kind: "tts",
        label: "Kitten Nano (English)",
        description: "Tiny, very fast English voice.",
        languages: ["en"],
        downloadSizeBytes: 26_586_708,
        ...releaseArchive("tts-models", "kitten-nano-en-v0_2-fp16"),
        engine: {
            family: "kitten",
            model: "model.fp16.onnx",
            voices: "voices.bin",
            tokens: "tokens.txt",
            dataDir: "espeak-ng-data",
        },
    },
    "piper-en-us-libritts-r": {
        kind: "tts",
        label: "Piper LibriTTS (US English)",
        description: "Lightweight American English voice.",
        languages: ["en-US"],
        downloadSizeBytes: 23_398_348,
        ...releaseArchive("tts-models", "vits-piper-en_US-libritts_r-medium-int8"),
        engine: piperEngine("en_US-libritts_r-medium"),
    },
    "piper-en-gb-alba": {
        kind: "tts",
        label: "Piper Alba (British English)",
        description: "Lightweight British English voice.",
        languages: ["en-GB"],
        downloadSizeBytes: 21_104_326,
        ...releaseArchive("tts-models", "vits-piper-en_GB-alba-medium-int8"),
        engine: piperEngine("en_GB-alba-medium"),
    },
    "piper-de-thorsten": {
        kind: "tts",
        label: "Piper Thorsten (German)",
        description: "Lightweight German voice.",
        languages: ["de"],
        downloadSizeBytes: 20_949_833,
        ...releaseArchive("tts-models", "vits-piper-de_DE-thorsten-medium-int8"),
        engine: piperEngine("de_DE-thorsten-medium"),
    },
    "piper-fr-siwis": {
        kind: "tts",
        label: "Piper Siwis (French)",
        description: "Lightweight French voice.",
        languages: ["fr"],
        downloadSizeBytes: 20_914_888,
        ...releaseArchive("tts-models", "vits-piper-fr_FR-siwis-medium-int8"),
        engine: piperEngine("fr_FR-siwis-medium"),
    },
    "piper-es-davefx": {
        kind: "tts",
        label: "Piper Davefx (Spanish)",
        description: "Lightweight Spanish voice.",
        languages: ["es"],
        downloadSizeBytes: 21_171_632,
        ...releaseArchive("tts-models", "vits-piper-es_ES-davefx-medium-int8"),
        engine: piperEngine("es_ES-davefx-medium"),
    },
};
const ALL_MODEL_IDS = Object.keys(SHERPA_ONNX_MODEL_CATALOG).filter((k) => k in SHERPA_ONNX_MODEL_CATALOG);
function isLocalSttModelId(id) {
    return SHERPA_ONNX_MODEL_CATALOG[id].kind !== "tts";
}
function isLocalTtsModelId(id) {
    return SHERPA_ONNX_MODEL_CATALOG[id].kind === "tts";
}
export const LOCAL_STT_MODEL_IDS = ALL_MODEL_IDS.filter(isLocalSttModelId);
export const LOCAL_TTS_MODEL_IDS = ALL_MODEL_IDS.filter(isLocalTtsModelId);
function resolveDefaultModelId(role) {
    const match = ALL_MODEL_IDS.find((id) => {
        const entry = SHERPA_ONNX_MODEL_CATALOG[id];
        return entry.defaultFor === role;
    });
    if (!match) {
        throw new Error(`No default model configured for role '${role}'`);
    }
    return match;
}
export const DEFAULT_LOCAL_STT_MODEL = resolveDefaultModelId("stt");
export const DEFAULT_LOCAL_TTS_MODEL = resolveDefaultModelId("tts");
function createModelIdSchema(modelIds) {
    const validIds = new Set(modelIds);
    return z
        .string()
        .trim()
        .toLowerCase()
        .refine((value) => validIds.has(value), {
        message: "Invalid model id",
    })
        .transform((value) => value);
}
export const LocalSpeechModelIdSchema = createModelIdSchema(ALL_MODEL_IDS);
export const LocalSttModelIdSchema = createModelIdSchema(LOCAL_STT_MODEL_IDS);
export const LocalTtsModelIdSchema = createModelIdSchema(LOCAL_TTS_MODEL_IDS);
export function listSherpaOnnxModels() {
    return ALL_MODEL_IDS.map(getSherpaOnnxModelSpec);
}
export function getSherpaOnnxModelSpec(id) {
    const spec = SHERPA_ONNX_MODEL_CATALOG[id];
    if (!spec) {
        throw new Error(`Unknown local speech model id: ${id}`);
    }
    return {
        id,
        ...spec,
        requiredFiles: engineFiles(spec.engine),
    };
}
// Every path an engine names, so the downloader can verify an install.
export function engineFiles(engine) {
    return Object.entries(engine).flatMap(([key, value]) => {
        if (key === "family")
            return [];
        return typeof value === "string" ? [value] : value;
    });
}
export function getLocalSttEngine(id) {
    return SHERPA_ONNX_MODEL_CATALOG[id].engine;
}
export function getLocalTtsEngine(id) {
    return SHERPA_ONNX_MODEL_CATALOG[id].engine;
}
