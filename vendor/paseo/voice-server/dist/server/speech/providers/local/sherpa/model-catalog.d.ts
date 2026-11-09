import { z } from "zod";
export type SherpaOnnxModelKind = "stt-offline" | "tts";
type DefaultModelRole = "stt" | "tts";
export type SttEngine = {
    family: "transducer";
    encoder: string;
    decoder: string;
    joiner: string;
    tokens: string;
} | {
    family: "whisper";
    encoder: string;
    decoder: string;
    tokens: string;
} | {
    family: "sense_voice";
    model: string;
    tokens: string;
} | {
    family: "dolphin";
    model: string;
    tokens: string;
} | {
    family: "nemo_ctc";
    model: string;
    tokens: string;
};
export type TtsEngine = {
    family: "kokoro";
    model: string;
    voices: string;
    tokens: string;
    dataDir: string;
    lexicons?: readonly string[];
    dictDir?: string;
    ruleFsts?: readonly string[];
} | {
    family: "kitten";
    model: string;
    voices: string;
    tokens: string;
    dataDir: string;
} | {
    family: "vits";
    model: string;
    tokens: string;
    dataDir: string;
};
interface SherpaOnnxCatalogEntryBase {
    label: string;
    description: string;
    languages: readonly string[];
    downloadSizeBytes: number;
    archiveUrl: string;
    extractedDir: string;
    defaultFor?: DefaultModelRole;
}
type SherpaOnnxCatalogEntry = (SherpaOnnxCatalogEntryBase & {
    kind: "stt-offline";
    engine: SttEngine;
}) | (SherpaOnnxCatalogEntryBase & {
    kind: "tts";
    engine: TtsEngine;
});
export declare const SHERPA_ONNX_MODEL_CATALOG: {
    readonly "parakeet-tdt-0.6b-v2-int8": {
        readonly engine: {
            readonly family: "transducer";
            readonly encoder: "encoder.int8.onnx";
            readonly decoder: "decoder.int8.onnx";
            readonly joiner: "joiner.int8.onnx";
            readonly tokens: "tokens.txt";
        };
        readonly defaultFor: "stt";
        readonly archiveUrl: string;
        readonly extractedDir: string;
        readonly kind: "stt-offline";
        readonly label: "Parakeet v2";
        readonly description: "Accurate English transcription that runs well on a laptop CPU.";
        readonly languages: readonly ["en"];
        readonly downloadSizeBytes: 482468385;
    };
    readonly "parakeet-tdt-110m-en-int8": {
        readonly engine: {
            readonly family: "transducer";
            readonly encoder: "encoder.int8.onnx";
            readonly decoder: "decoder.int8.onnx";
            readonly joiner: "joiner.int8.onnx";
            readonly tokens: "tokens.txt";
        };
        readonly archiveUrl: string;
        readonly extractedDir: string;
        readonly kind: "stt-offline";
        readonly label: "Parakeet Small";
        readonly description: "Small, fast English model with punctuation. A quick download for any laptop.";
        readonly languages: readonly ["en"];
        readonly downloadSizeBytes: 108035095;
    };
    readonly "parakeet-tdt-0.6b-v3-int8": {
        readonly engine: {
            readonly family: "transducer";
            readonly encoder: "encoder.int8.onnx";
            readonly decoder: "decoder.int8.onnx";
            readonly joiner: "joiner.int8.onnx";
            readonly tokens: "tokens.txt";
        };
        readonly archiveUrl: string;
        readonly extractedDir: string;
        readonly kind: "stt-offline";
        readonly label: "Parakeet v3";
        readonly description: "Parakeet for 25 European languages, detecting which one you speak.";
        readonly languages: readonly ["bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu", "it", "lv", "lt", "mt", "pl", "pt", "ro", "sk", "sl", "es", "sv", "ru", "uk"];
        readonly downloadSizeBytes: 487170055;
    };
    readonly "whisper-tiny-en": {
        readonly engine: SttEngine;
        readonly archiveUrl: string;
        readonly extractedDir: string;
        readonly kind: "stt-offline";
        readonly label: "Whisper Tiny (English)";
        readonly description: "Small English Whisper model. Quick to download, less accurate than Parakeet.";
        readonly languages: readonly ["en"];
        readonly downloadSizeBytes: 118071777;
    };
    readonly "whisper-base": {
        readonly engine: SttEngine;
        readonly archiveUrl: string;
        readonly extractedDir: string;
        readonly kind: "stt-offline";
        readonly label: "Whisper Base";
        readonly description: "Compact Whisper model for 99 languages, detecting which one you speak.";
        readonly languages: readonly ["en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl", "ar", "sv", "it", "id", "hi", "fi", "vi", "he", "uk", "el", "ms", "cs", "ro", "da", "hu", "ta", "no", "th", "ur", "hr", "bg", "lt", "la", "mi", "ml", "cy", "sk", "te", "fa", "lv", "bn", "sr", "az", "sl", "kn", "et", "mk", "br", "eu", "is", "hy", "ne", "mn", "bs", "kk", "sq", "sw", "gl", "mr", "pa", "si", "km", "sn", "yo", "so", "af", "oc", "ka", "be", "tg", "sd", "gu", "am", "yi", "lo", "uz", "fo", "ht", "ps", "tk", "nn", "mt", "sa", "lb", "my", "bo", "tl", "mg", "as", "tt", "haw", "ln", "ha", "ba", "jv", "su"];
        readonly downloadSizeBytes: 207557382;
    };
    readonly "whisper-turbo": {
        readonly engine: SttEngine;
        readonly archiveUrl: string;
        readonly extractedDir: string;
        readonly kind: "stt-offline";
        readonly label: "Whisper Turbo";
        readonly description: "Whisper's most accurate model for 99 languages and Cantonese. Slower on a CPU.";
        readonly languages: readonly ["en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl", "ar", "sv", "it", "id", "hi", "fi", "vi", "he", "uk", "el", "ms", "cs", "ro", "da", "hu", "ta", "no", "th", "ur", "hr", "bg", "lt", "la", "mi", "ml", "cy", "sk", "te", "fa", "lv", "bn", "sr", "az", "sl", "kn", "et", "mk", "br", "eu", "is", "hy", "ne", "mn", "bs", "kk", "sq", "sw", "gl", "mr", "pa", "si", "km", "sn", "yo", "so", "af", "oc", "ka", "be", "tg", "sd", "gu", "am", "yi", "lo", "uz", "fo", "ht", "ps", "tk", "nn", "mt", "sa", "lb", "my", "bo", "tl", "mg", "as", "tt", "haw", "ln", "ha", "ba", "jv", "su", "yue"];
        readonly downloadSizeBytes: 563790207;
    };
    readonly "sense-voice-int8": {
        readonly engine: {
            readonly family: "sense_voice";
            readonly model: "model.int8.onnx";
            readonly tokens: "tokens.txt";
        };
        readonly archiveUrl: string;
        readonly extractedDir: string;
        readonly kind: "stt-offline";
        readonly label: "SenseVoice";
        readonly description: "Chinese, Cantonese, English, Japanese and Korean, detecting which one you speak.";
        readonly languages: readonly ["zh", "yue", "en", "ja", "ko"];
        readonly downloadSizeBytes: 165783878;
    };
    readonly "dolphin-base-int8": {
        readonly engine: {
            readonly family: "dolphin";
            readonly model: "model.int8.onnx";
            readonly tokens: "tokens.txt";
        };
        readonly archiveUrl: string;
        readonly extractedDir: string;
        readonly kind: "stt-offline";
        readonly label: "Dolphin";
        readonly description: "Small model for 40 Asian and Middle Eastern languages and Chinese dialects.";
        readonly languages: readonly ["zh", "ja", "th", "ru", "ko", "id", "vi", "yue", "hi", "ur", "ms", "uz", "ar", "fa", "bn", "ta", "te", "ug", "gu", "my", "tl", "kk", "or", "ne", "mn", "km", "jv", "lo", "si", "fil", "ps", "pa", "kab", "ba", "ks", "tg", "su", "mr", "ky", "az"];
        readonly downloadSizeBytes: 80671385;
    };
    readonly "giga-am-v3-ru": {
        readonly engine: {
            readonly family: "transducer";
            readonly encoder: "encoder.int8.onnx";
            readonly decoder: "decoder.onnx";
            readonly joiner: "joiner.onnx";
            readonly tokens: "tokens.txt";
        };
        readonly archiveUrl: string;
        readonly extractedDir: string;
        readonly kind: "stt-offline";
        readonly label: "GigaAM v3 (Russian)";
        readonly description: "Russian transcription with punctuation.";
        readonly languages: readonly ["ru"];
        readonly downloadSizeBytes: 170197019;
    };
    readonly "parakeet-tdt-ctc-0.6b-ja-int8": {
        readonly engine: {
            readonly family: "nemo_ctc";
            readonly model: "model.int8.onnx";
            readonly tokens: "tokens.txt";
        };
        readonly archiveUrl: string;
        readonly extractedDir: string;
        readonly kind: "stt-offline";
        readonly label: "Parakeet (Japanese)";
        readonly description: "Japanese transcription with punctuation.";
        readonly languages: readonly ["ja"];
        readonly downloadSizeBytes: 489389564;
    };
    readonly "kokoro-en-v0_19": {
        readonly engine: {
            readonly family: "kokoro";
            readonly model: "model.onnx";
            readonly voices: "voices.bin";
            readonly tokens: "tokens.txt";
            readonly dataDir: "espeak-ng-data";
        };
        readonly defaultFor: "tts";
        readonly archiveUrl: string;
        readonly extractedDir: string;
        readonly kind: "tts";
        readonly label: "Kokoro (English)";
        readonly description: "Natural-sounding English voice for voice mode replies.";
        readonly languages: readonly ["en"];
        readonly downloadSizeBytes: 319625534;
    };
    readonly "kokoro-int8-en-v0_19": {
        readonly engine: {
            readonly family: "kokoro";
            readonly model: "model.int8.onnx";
            readonly voices: "voices.bin";
            readonly tokens: "tokens.txt";
            readonly dataDir: "espeak-ng-data";
        };
        readonly archiveUrl: string;
        readonly extractedDir: string;
        readonly kind: "tts";
        readonly label: "Kokoro Lite (English)";
        readonly description: "The same Kokoro English voices, quantized to a third of the download.";
        readonly languages: readonly ["en"];
        readonly downloadSizeBytes: 103248205;
    };
    readonly "kokoro-int8-multi-lang-v1_1": {
        readonly engine: {
            readonly family: "kokoro";
            readonly model: "model.int8.onnx";
            readonly voices: "voices.bin";
            readonly tokens: "tokens.txt";
            readonly dataDir: "espeak-ng-data";
            readonly lexicons: readonly ["lexicon-us-en.txt", "lexicon-zh.txt"];
            readonly dictDir: "dict";
            readonly ruleFsts: readonly ["date-zh.fst", "phone-zh.fst", "number-zh.fst"];
        };
        readonly archiveUrl: string;
        readonly extractedDir: string;
        readonly kind: "tts";
        readonly label: "Kokoro (Chinese and English)";
        readonly description: "Kokoro voices that speak both Mandarin Chinese and English.";
        readonly languages: readonly ["zh", "en"];
        readonly downloadSizeBytes: 147031220;
    };
    readonly "kitten-nano-en-v0_2-fp16": {
        readonly engine: {
            readonly family: "kitten";
            readonly model: "model.fp16.onnx";
            readonly voices: "voices.bin";
            readonly tokens: "tokens.txt";
            readonly dataDir: "espeak-ng-data";
        };
        readonly archiveUrl: string;
        readonly extractedDir: string;
        readonly kind: "tts";
        readonly label: "Kitten Nano (English)";
        readonly description: "Tiny, very fast English voice.";
        readonly languages: readonly ["en"];
        readonly downloadSizeBytes: 26586708;
    };
    readonly "piper-en-us-libritts-r": {
        readonly engine: TtsEngine;
        readonly archiveUrl: string;
        readonly extractedDir: string;
        readonly kind: "tts";
        readonly label: "Piper LibriTTS (US English)";
        readonly description: "Lightweight American English voice.";
        readonly languages: readonly ["en-US"];
        readonly downloadSizeBytes: 23398348;
    };
    readonly "piper-en-gb-alba": {
        readonly engine: TtsEngine;
        readonly archiveUrl: string;
        readonly extractedDir: string;
        readonly kind: "tts";
        readonly label: "Piper Alba (British English)";
        readonly description: "Lightweight British English voice.";
        readonly languages: readonly ["en-GB"];
        readonly downloadSizeBytes: 21104326;
    };
    readonly "piper-de-thorsten": {
        readonly engine: TtsEngine;
        readonly archiveUrl: string;
        readonly extractedDir: string;
        readonly kind: "tts";
        readonly label: "Piper Thorsten (German)";
        readonly description: "Lightweight German voice.";
        readonly languages: readonly ["de"];
        readonly downloadSizeBytes: 20949833;
    };
    readonly "piper-fr-siwis": {
        readonly engine: TtsEngine;
        readonly archiveUrl: string;
        readonly extractedDir: string;
        readonly kind: "tts";
        readonly label: "Piper Siwis (French)";
        readonly description: "Lightweight French voice.";
        readonly languages: readonly ["fr"];
        readonly downloadSizeBytes: 20914888;
    };
    readonly "piper-es-davefx": {
        readonly engine: TtsEngine;
        readonly archiveUrl: string;
        readonly extractedDir: string;
        readonly kind: "tts";
        readonly label: "Piper Davefx (Spanish)";
        readonly description: "Lightweight Spanish voice.";
        readonly languages: readonly ["es"];
        readonly downloadSizeBytes: 21171632;
    };
};
export type SherpaOnnxModelId = keyof typeof SHERPA_ONNX_MODEL_CATALOG;
export type LocalSpeechModelId = SherpaOnnxModelId;
type ModelIdByKind<K extends SherpaOnnxModelKind> = {
    [Id in SherpaOnnxModelId]: (typeof SHERPA_ONNX_MODEL_CATALOG)[Id]["kind"] extends K ? Id : never;
}[SherpaOnnxModelId];
export type LocalSttModelId = ModelIdByKind<"stt-offline">;
export type LocalTtsModelId = ModelIdByKind<"tts">;
export declare const LOCAL_STT_MODEL_IDS: LocalSttModelId[];
export declare const LOCAL_TTS_MODEL_IDS: LocalTtsModelId[];
export declare const DEFAULT_LOCAL_STT_MODEL: LocalSttModelId;
export declare const DEFAULT_LOCAL_TTS_MODEL: LocalTtsModelId;
export declare const LocalSpeechModelIdSchema: z.ZodType<"parakeet-tdt-0.6b-v2-int8" | "parakeet-tdt-110m-en-int8" | "parakeet-tdt-0.6b-v3-int8" | "whisper-tiny-en" | "whisper-base" | "whisper-turbo" | "sense-voice-int8" | "dolphin-base-int8" | "giga-am-v3-ru" | "parakeet-tdt-ctc-0.6b-ja-int8" | "kokoro-en-v0_19" | "kokoro-int8-en-v0_19" | "kokoro-int8-multi-lang-v1_1" | "kitten-nano-en-v0_2-fp16" | "piper-en-us-libritts-r" | "piper-en-gb-alba" | "piper-de-thorsten" | "piper-fr-siwis" | "piper-es-davefx", string, z.core.$ZodTypeInternals<"parakeet-tdt-0.6b-v2-int8" | "parakeet-tdt-110m-en-int8" | "parakeet-tdt-0.6b-v3-int8" | "whisper-tiny-en" | "whisper-base" | "whisper-turbo" | "sense-voice-int8" | "dolphin-base-int8" | "giga-am-v3-ru" | "parakeet-tdt-ctc-0.6b-ja-int8" | "kokoro-en-v0_19" | "kokoro-int8-en-v0_19" | "kokoro-int8-multi-lang-v1_1" | "kitten-nano-en-v0_2-fp16" | "piper-en-us-libritts-r" | "piper-en-gb-alba" | "piper-de-thorsten" | "piper-fr-siwis" | "piper-es-davefx", string>>;
export declare const LocalSttModelIdSchema: z.ZodType<LocalSttModelId, string, z.core.$ZodTypeInternals<LocalSttModelId, string>>;
export declare const LocalTtsModelIdSchema: z.ZodType<LocalTtsModelId, string, z.core.$ZodTypeInternals<LocalTtsModelId, string>>;
export type SherpaOnnxModelSpec = SherpaOnnxCatalogEntry & {
    id: SherpaOnnxModelId;
    requiredFiles: string[];
};
export declare function listSherpaOnnxModels(): SherpaOnnxModelSpec[];
export declare function getSherpaOnnxModelSpec(id: SherpaOnnxModelId): SherpaOnnxModelSpec;
export declare function engineFiles(engine: SttEngine | TtsEngine): string[];
export declare function getLocalSttEngine(id: LocalSttModelId): SttEngine;
export declare function getLocalTtsEngine(id: LocalTtsModelId): TtsEngine;
export {};
