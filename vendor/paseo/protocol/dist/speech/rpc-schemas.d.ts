import { z } from "zod";
export declare const SpeechSttSettingsSchema: z.ZodUnion<readonly [z.ZodObject<{
    language: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    provider: z.ZodLiteral<"local">;
}, z.core.$loose>, z.ZodObject<{
    language: z.ZodOptional<z.ZodString>;
    confidenceThreshold: z.ZodOptional<z.ZodNumber>;
    hasApiKey: z.ZodBoolean;
    baseUrl: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    provider: z.ZodLiteral<"openai">;
}, z.core.$loose>, z.ZodObject<{
    model: z.ZodOptional<z.ZodString>;
    provider: z.ZodString;
}, z.core.$loose>]>;
export declare const SpeechTtsSettingsSchema: z.ZodUnion<readonly [z.ZodObject<{
    speakerId: z.ZodOptional<z.ZodNumber>;
    speed: z.ZodOptional<z.ZodNumber>;
    model: z.ZodOptional<z.ZodString>;
    provider: z.ZodLiteral<"local">;
}, z.core.$loose>, z.ZodObject<{
    voice: z.ZodOptional<z.ZodString>;
    hasApiKey: z.ZodBoolean;
    baseUrl: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    provider: z.ZodLiteral<"openai">;
}, z.core.$loose>, z.ZodObject<{
    model: z.ZodOptional<z.ZodString>;
    provider: z.ZodString;
}, z.core.$loose>]>;
export declare const SpeechSettingsSchema: z.ZodObject<{
    dictation: z.ZodObject<{
        enabled: z.ZodBoolean;
        stt: z.ZodUnion<readonly [z.ZodObject<{
            language: z.ZodOptional<z.ZodString>;
            model: z.ZodOptional<z.ZodString>;
            provider: z.ZodLiteral<"local">;
        }, z.core.$loose>, z.ZodObject<{
            language: z.ZodOptional<z.ZodString>;
            confidenceThreshold: z.ZodOptional<z.ZodNumber>;
            hasApiKey: z.ZodBoolean;
            baseUrl: z.ZodOptional<z.ZodString>;
            model: z.ZodOptional<z.ZodString>;
            provider: z.ZodLiteral<"openai">;
        }, z.core.$loose>, z.ZodObject<{
            model: z.ZodOptional<z.ZodString>;
            provider: z.ZodString;
        }, z.core.$loose>]>;
    }, z.core.$loose>;
    voiceMode: z.ZodObject<{
        enabled: z.ZodBoolean;
        stt: z.ZodUnion<readonly [z.ZodObject<{
            language: z.ZodOptional<z.ZodString>;
            model: z.ZodOptional<z.ZodString>;
            provider: z.ZodLiteral<"local">;
        }, z.core.$loose>, z.ZodObject<{
            language: z.ZodOptional<z.ZodString>;
            confidenceThreshold: z.ZodOptional<z.ZodNumber>;
            hasApiKey: z.ZodBoolean;
            baseUrl: z.ZodOptional<z.ZodString>;
            model: z.ZodOptional<z.ZodString>;
            provider: z.ZodLiteral<"openai">;
        }, z.core.$loose>, z.ZodObject<{
            model: z.ZodOptional<z.ZodString>;
            provider: z.ZodString;
        }, z.core.$loose>]>;
        tts: z.ZodUnion<readonly [z.ZodObject<{
            speakerId: z.ZodOptional<z.ZodNumber>;
            speed: z.ZodOptional<z.ZodNumber>;
            model: z.ZodOptional<z.ZodString>;
            provider: z.ZodLiteral<"local">;
        }, z.core.$loose>, z.ZodObject<{
            voice: z.ZodOptional<z.ZodString>;
            hasApiKey: z.ZodBoolean;
            baseUrl: z.ZodOptional<z.ZodString>;
            model: z.ZodOptional<z.ZodString>;
            provider: z.ZodLiteral<"openai">;
        }, z.core.$loose>, z.ZodObject<{
            model: z.ZodOptional<z.ZodString>;
            provider: z.ZodString;
        }, z.core.$loose>]>;
        llm: z.ZodOptional<z.ZodObject<{
            provider: z.ZodOptional<z.ZodString>;
            model: z.ZodOptional<z.ZodString>;
        }, z.core.$loose>>;
        turnDetection: z.ZodOptional<z.ZodObject<{
            provider: z.ZodOptional<z.ZodString>;
        }, z.core.$loose>>;
    }, z.core.$loose>;
}, z.core.$loose>;
export declare const SpeechSettingsPatchSchema: z.ZodObject<{
    dictation: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
        stt: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
            language: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            model: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            provider: z.ZodLiteral<"local">;
        }, z.core.$loose>, z.ZodObject<{
            language: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            confidenceThreshold: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
            apiKey: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            baseUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            model: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            provider: z.ZodLiteral<"openai">;
        }, z.core.$loose>, z.ZodObject<{
            provider: z.ZodNullable<z.ZodString>;
        }, z.core.$loose>, z.ZodObject<{
            language: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            confidenceThreshold: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
            apiKey: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            baseUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            model: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            provider: z.ZodOptional<z.ZodUndefined>;
        }, z.core.$loose>]>>;
    }, z.core.$loose>>;
    voiceMode: z.ZodOptional<z.ZodObject<{
        enabled: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
        stt: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
            language: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            model: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            provider: z.ZodLiteral<"local">;
        }, z.core.$loose>, z.ZodObject<{
            language: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            confidenceThreshold: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
            apiKey: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            baseUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            model: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            provider: z.ZodLiteral<"openai">;
        }, z.core.$loose>, z.ZodObject<{
            provider: z.ZodNullable<z.ZodString>;
        }, z.core.$loose>, z.ZodObject<{
            language: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            confidenceThreshold: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
            apiKey: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            baseUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            model: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            provider: z.ZodOptional<z.ZodUndefined>;
        }, z.core.$loose>]>>;
        tts: z.ZodOptional<z.ZodUnion<readonly [z.ZodObject<{
            speakerId: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
            speed: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
            model: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            provider: z.ZodLiteral<"local">;
        }, z.core.$loose>, z.ZodObject<{
            voice: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            apiKey: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            baseUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            model: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            provider: z.ZodLiteral<"openai">;
        }, z.core.$loose>, z.ZodObject<{
            provider: z.ZodNullable<z.ZodString>;
        }, z.core.$loose>, z.ZodObject<{
            voice: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            speakerId: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
            speed: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
            apiKey: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            baseUrl: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            model: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            provider: z.ZodOptional<z.ZodUndefined>;
        }, z.core.$loose>]>>;
        llm: z.ZodOptional<z.ZodObject<{
            provider: z.ZodOptional<z.ZodNullable<z.ZodString>>;
            model: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        }, z.core.$loose>>;
        turnDetection: z.ZodOptional<z.ZodObject<{
            provider: z.ZodOptional<z.ZodNullable<z.ZodString>>;
        }, z.core.$loose>>;
    }, z.core.$loose>>;
}, z.core.$loose>;
export type SpeechSettings = z.infer<typeof SpeechSettingsSchema>;
export type SpeechSettingsPatch = z.infer<typeof SpeechSettingsPatchSchema>;
export declare const LocalSpeechModelSchema: z.ZodObject<{
    id: z.ZodString;
    kind: z.ZodString;
    label: z.ZodString;
    description: z.ZodString;
    languages: z.ZodArray<z.ZodString>;
    downloadSizeBytes: z.ZodNumber;
    isDefault: z.ZodBoolean;
    inUse: z.ZodBoolean;
    status: z.ZodString;
    receivedBytes: z.ZodOptional<z.ZodNumber>;
    totalBytes: z.ZodOptional<z.ZodNumber>;
    error: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
export type LocalSpeechModel = z.infer<typeof LocalSpeechModelSchema>;
export declare const SpeechLocalModelsListRequestSchema: z.ZodObject<{
    type: z.ZodLiteral<"speech.local_models.list.request">;
    requestId: z.ZodString;
}, z.core.$strip>;
export declare const SpeechLocalModelsDownloadRequestSchema: z.ZodObject<{
    type: z.ZodLiteral<"speech.local_models.download.request">;
    requestId: z.ZodString;
    modelId: z.ZodString;
}, z.core.$strip>;
export declare const SpeechLocalModelsDeleteRequestSchema: z.ZodObject<{
    type: z.ZodLiteral<"speech.local_models.delete.request">;
    requestId: z.ZodString;
    modelId: z.ZodString;
}, z.core.$strip>;
export declare const SpeechLocalModelsListResponseSchema: z.ZodObject<{
    type: z.ZodLiteral<"speech.local_models.list.response">;
    payload: z.ZodObject<{
        requestId: z.ZodString;
        models: z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            kind: z.ZodString;
            label: z.ZodString;
            description: z.ZodString;
            languages: z.ZodArray<z.ZodString>;
            downloadSizeBytes: z.ZodNumber;
            isDefault: z.ZodBoolean;
            inUse: z.ZodBoolean;
            status: z.ZodString;
            receivedBytes: z.ZodOptional<z.ZodNumber>;
            totalBytes: z.ZodOptional<z.ZodNumber>;
            error: z.ZodOptional<z.ZodString>;
        }, z.core.$loose>>;
        error: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const SpeechLocalModelsDownloadResponseSchema: z.ZodObject<{
    type: z.ZodLiteral<"speech.local_models.download.response">;
    payload: z.ZodObject<{
        requestId: z.ZodString;
        error: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>;
export declare const SpeechLocalModelsDeleteResponseSchema: z.ZodObject<{
    type: z.ZodLiteral<"speech.local_models.delete.response">;
    payload: z.ZodObject<{
        requestId: z.ZodString;
        error: z.ZodNullable<z.ZodString>;
    }, z.core.$strip>;
}, z.core.$strip>;
