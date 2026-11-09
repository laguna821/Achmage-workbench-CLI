import { z } from "zod";
export declare const PluginRegistryIdSchema: z.ZodString;
export declare const PluginRegistryIdentitySchema: z.ZodObject<{
    url: z.ZodString;
    id: z.ZodString;
}, z.core.$strip>;
export declare const PluginRegistriesSchema: z.ZodRecord<z.ZodString, z.ZodObject<{
    authorization: z.ZodString;
}, z.core.$strip>>;
export declare const PluginRegistryArtifactSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{
    kind: z.ZodLiteral<"npm">;
    package: z.ZodString;
    version: z.ZodString;
    resolved: z.ZodString;
    integrity: z.ZodString;
}, z.core.$strip>, z.ZodObject<{
    kind: z.ZodLiteral<"git">;
    remote: z.ZodString;
    commit: z.ZodString;
    pluginPath: z.ZodOptional<z.ZodString>;
}, z.core.$strip>], "kind">;
/**
 * Listing text in other languages, keyed by language tag such as `zh-CN`. A missing field falls back
 * to the English `name` or `description`, which stay required so older clients keep working.
 */
export declare const PluginListingTranslationsSchema: z.ZodRecord<z.ZodString, z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
}, z.core.$strip>>;
export declare const PublishedPluginSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    description: z.ZodString;
    translations: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    license: z.ZodOptional<z.ZodString>;
    categories: z.ZodArray<z.ZodString>;
    author: z.ZodObject<{
        github: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
        npm: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    repository: z.ZodObject<{
        url: z.ZodString;
        commit: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    artifact: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"npm">;
        package: z.ZodString;
        version: z.ZodString;
        resolved: z.ZodString;
        integrity: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"git">;
        remote: z.ZodString;
        commit: z.ZodString;
        pluginPath: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>], "kind">;
    icon: z.ZodOptional<z.ZodString>;
    media: z.ZodArray<z.ZodString>;
    submittedAt: z.ZodString;
    reviewedAt: z.ZodString;
    updatedAt: z.ZodString;
    publishedAt: z.ZodString;
    installs: z.ZodOptional<z.ZodNumber>;
}, z.core.$strip>;
/** Whether a registry media entry is a video or an image, from its path extension. */
export declare function pluginMediaKind(url: string): "image" | "video";
export declare const PublishedPluginDetailSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    description: z.ZodString;
    translations: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    license: z.ZodOptional<z.ZodString>;
    categories: z.ZodArray<z.ZodString>;
    author: z.ZodObject<{
        github: z.ZodString;
        name: z.ZodOptional<z.ZodString>;
        npm: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    repository: z.ZodObject<{
        url: z.ZodString;
        commit: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
    artifact: z.ZodDiscriminatedUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"npm">;
        package: z.ZodString;
        version: z.ZodString;
        resolved: z.ZodString;
        integrity: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
        kind: z.ZodLiteral<"git">;
        remote: z.ZodString;
        commit: z.ZodString;
        pluginPath: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>], "kind">;
    icon: z.ZodOptional<z.ZodString>;
    media: z.ZodArray<z.ZodString>;
    submittedAt: z.ZodString;
    reviewedAt: z.ZodString;
    updatedAt: z.ZodString;
    publishedAt: z.ZodString;
    installs: z.ZodOptional<z.ZodNumber>;
    readme: z.ZodString;
    overviewTranslations: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
}, z.core.$strip>;
export declare const PluginRegistryIndexSchema: z.ZodObject<{
    schemaVersion: z.ZodLiteral<1>;
    registry: z.ZodObject<{
        name: z.ZodString;
        url: z.ZodString;
    }, z.core.$strip>;
    categories: z.ZodArray<z.ZodObject<{
        slug: z.ZodString;
        label: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>;
    plugins: z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        description: z.ZodString;
        translations: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodObject<{
            name: z.ZodOptional<z.ZodString>;
            description: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>>>;
        license: z.ZodOptional<z.ZodString>;
        categories: z.ZodArray<z.ZodString>;
        author: z.ZodObject<{
            github: z.ZodString;
            name: z.ZodOptional<z.ZodString>;
            npm: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
        repository: z.ZodObject<{
            url: z.ZodString;
            commit: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>;
        artifact: z.ZodDiscriminatedUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"npm">;
            package: z.ZodString;
            version: z.ZodString;
            resolved: z.ZodString;
            integrity: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
            kind: z.ZodLiteral<"git">;
            remote: z.ZodString;
            commit: z.ZodString;
            pluginPath: z.ZodOptional<z.ZodString>;
        }, z.core.$strip>], "kind">;
        icon: z.ZodOptional<z.ZodString>;
        media: z.ZodArray<z.ZodString>;
        submittedAt: z.ZodString;
        reviewedAt: z.ZodString;
        updatedAt: z.ZodString;
        publishedAt: z.ZodString;
        installs: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    featured: z.ZodArray<z.ZodString>;
    generatedAt: z.ZodString;
}, z.core.$strip>;
export type PluginRegistryIdentity = z.infer<typeof PluginRegistryIdentitySchema>;
export type PluginRegistries = z.infer<typeof PluginRegistriesSchema>;
export declare function parsePluginRegistryReference(source: string, defaultUrl?: string): PluginRegistryIdentity | null;
