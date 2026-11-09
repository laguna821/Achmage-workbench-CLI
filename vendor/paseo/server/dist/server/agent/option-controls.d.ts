import type { ProviderOptions } from "@getpaseo/protocol/agent-types";
/**
 * A patch over an agent's own options: top-level keys replace, `null` removes the key so the
 * `config.json` default (or the provider's own default) applies again.
 */
export type ProviderOptionsPatch = Record<string, unknown>;
export declare function applyProviderOptionsPatch(input: {
    options: ProviderOptions | undefined;
    patch: ProviderOptionsPatch;
}): ProviderOptions;
/** COMPAT(featureValues): added in v0.15.0, remove after 2027-05-01. */
export interface LegacyFeatureValues {
    featureValues?: Record<string, unknown>;
}
/**
 * COMPAT(codexFastPreference): added in v0.10.0, remove after 2027-03-29 once saved Fast
 * preferences have migrated. Codex used to take `fast_mode`; it takes `service_tier` now. Old
 * data (stored records, config.json defaults, profiles, older clients, hooks) is converted here
 * as it enters, so nothing past this point sees `fast_mode` for Codex. A `service_tier` in the
 * same input wins. A patch's `null` stays `null`, which removes the speed.
 */
interface LegacyOptionsInput<O> {
    provider: string | undefined;
    options: O;
}
/** A legacy option value the conversion cannot read. */
export declare class MalformedLegacyOptionError extends Error {
    constructor(message: string);
}
export declare function convertLegacyOptions(input: LegacyOptionsInput<Record<string, unknown>>): Record<string, unknown>;
export declare function convertLegacyOptions(input: LegacyOptionsInput<Record<string, unknown> | undefined>): Record<string, unknown> | undefined;
/**
 * The built-in adapter a provider id runs on: a custom provider is named by the one it
 * `extends`, followed until a provider that extends nothing. `extendsOf` is where the caller
 * reads that link (the registry's definitions, or `config.json`'s `providers` section).
 */
export declare function resolveAdapter(input: {
    provider: string;
    extendsOf: (provider: string) => string | null | undefined;
}): string;
/**
 * COMPAT(featureValues): added in v0.15.0, remove after 2027-05-01.
 * Older clients, stored records, profiles, and plugin hooks carry composer values in
 * `featureValues`. This is the one place they become `providerOptions`; an explicit
 * `providerOptions` key wins over a `featureValues` key of the same name.
 */
export declare function foldFeatureValues<T extends {
    providerOptions?: ProviderOptions | null;
    featureValues?: Record<string, unknown> | null;
}>(config: T): Omit<T, "featureValues">;
/**
 * COMPAT(featureValues): added in v0.15.0, remove after 2027-05-01.
 * A plugin written against the previous SDK reads and edits `config.featureValues`, so a
 * hook sees a copy of the config's options there. What the hook did to that copy (set,
 * replaced or deleted a key, or dropped the field) is applied as a patch over the options it
 * returned; keys it left alone change nothing.
 */
export declare function exposeFeatureValuesToHook<T extends {
    providerOptions?: ProviderOptions | null;
    featureValues?: Record<string, unknown>;
}>(config: T): T;
export declare function foldHookFeatureValues<T extends {
    providerOptions?: ProviderOptions | null;
    featureValues?: Record<string, unknown>;
}>(input: {
    returned: T;
    sent: T;
    /** Brings what the hook returned to the form of the copy it was sent. */
    convert: (options: Record<string, unknown>) => Record<string, unknown>;
}): Omit<T, "featureValues">;
type ConvertedOptions = Record<string, unknown> | undefined;
interface ProfileOptionFields {
    provider?: string;
    options?: Record<string, unknown>;
    featureValues?: Record<string, unknown>;
}
/**
 * COMPAT(featureValues): added in v0.15.0, remove after 2027-05-01.
 * Profiles saved before options carry `featureValues`; when one comes from storage, `options`
 * wins over a stale `featureValues` key.
 *
 * A write that carries `options`, empty included, is from a client that knows them: its
 * `featureValues` fold over those. A write without `options` is from the unchanged app, whose
 * form only knows the controls: its `featureValues` are a patch (`null` deletes) over the
 * options stored for that profile, so options the form never shows, such as `sandbox_mode`,
 * survive an edit. A profile moved to another provider starts from no options, because the old
 * provider's keys mean nothing to the new one. A profile with no options is stored without the
 * key.
 */
export declare function foldProfileFeatureValues<T extends ProfileOptionFields>(input: {
    profile: T;
    stored: ProfileOptionFields | undefined;
    source: "stored" | "client write";
    /** Renames old option keys for the adapter the profile's provider runs on. */
    convert: (provider: string, options: Record<string, unknown> | undefined) => ConvertedOptions;
}): Omit<T, "featureValues">;
/**
 * COMPAT(featureValues): added in v0.15.0, remove after 2027-05-01.
 * The unchanged app reads a profile's options from `featureValues`; the config API answers with
 * both fields.
 */
export declare function withLegacyProfileFeatureValues<T extends ProfileOptionFields>(profile: T): T;
export {};
