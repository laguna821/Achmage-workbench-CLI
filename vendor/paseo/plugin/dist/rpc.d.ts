import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
export interface PluginRpcContract<InputSchema extends ZodType = ZodType, OutputSchema extends ZodType = ZodType> {
    name: string;
    input: InputSchema;
    output: OutputSchema;
}
/**
 * `z.instanceof(Uint8Array)` infers `Uint8Array<ArrayBuffer>`; values crossing the wire accept any
 * `Uint8Array`, including a `Buffer` or a view of a shared buffer.
 */
export type PluginWireInput<Value> = Value extends Uint8Array ? Uint8Array : Value;
export type RpcInput<Contract extends PluginRpcContract> = ZodOutput<Contract["input"]>;
export type RpcOutput<Contract extends PluginRpcContract> = ZodInput<Contract["output"]>;
interface RpcDefinition<InputSchema extends ZodType, OutputSchema extends ZodType> {
    name: string;
    input: InputSchema;
    output: OutputSchema;
}
export declare function defineRpc<InputSchema extends ZodType, OutputSchema extends ZodType>(definition: RpcDefinition<InputSchema, OutputSchema>): PluginRpcContract<InputSchema, OutputSchema>;
export declare function callPluginRpc<InputSchema extends ZodType, OutputSchema extends ZodType>(contract: PluginRpcContract<InputSchema, OutputSchema>, invoke: (method: string, input: unknown) => Promise<unknown>, input: PluginWireInput<ZodInput<InputSchema>>): Promise<ZodOutput<OutputSchema>>;
export interface PluginSubscriptionContract<InputSchema extends ZodType = ZodType, EventSchema extends ZodType = ZodType> {
    name: string;
    input: InputSchema;
    event: EventSchema;
}
export type SubscriptionInput<Contract extends PluginSubscriptionContract> = ZodOutput<Contract["input"]>;
export type SubscriptionEvent<Contract extends PluginSubscriptionContract> = ZodOutput<Contract["event"]>;
interface SubscriptionDefinition<InputSchema extends ZodType, EventSchema extends ZodType> {
    name: string;
    input: InputSchema;
    event: EventSchema;
}
export declare function defineSubscription<InputSchema extends ZodType, EventSchema extends ZodType>(definition: SubscriptionDefinition<InputSchema, EventSchema>): PluginSubscriptionContract<InputSchema, EventSchema>;
/** One subscription from a client surface. Calling it or `release()` ends it. */
export type PluginSubscriptionHandle = (() => void) & {
    /** Resolves once the plugin acknowledged the subscription; rejects if it refused. */
    readonly ready: Promise<void>;
    release(): Promise<void>;
};
export interface PluginSubscriptionObserver {
    event(event: unknown): void;
    closed(error?: Error): void;
}
export interface PluginSubscriptionClosed {
    /** Set when the plugin's handler failed, the plugin stopped, or an event failed validation. */
    error?: Error;
}
export interface PluginSubscribeOptions {
    /** Aborting releases the subscription. */
    signal?: AbortSignal;
    /** Runs once when the daemon closes the subscription. Not called after a release. */
    onClosed?: (closed: PluginSubscriptionClosed) => void;
}
export declare function subscribePluginRpc<InputSchema extends ZodType, EventSchema extends ZodType>(contract: PluginSubscriptionContract<InputSchema, EventSchema>, subscribe: (method: string, input: unknown, observer: PluginSubscriptionObserver) => PluginSubscriptionHandle, input: PluginWireInput<ZodInput<InputSchema>>, onEvent: (event: ZodOutput<EventSchema>) => void, options?: PluginSubscribeOptions): PluginSubscriptionHandle;
export {};
