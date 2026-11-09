const RPC_NAME = /^[a-z][a-z0-9._-]*$/;
export function defineRpc(definition) {
    const name = definition.name.trim();
    if (!RPC_NAME.test(name))
        throw new Error(`Invalid plugin RPC method: ${definition.name}`);
    return { ...definition, name };
}
export async function callPluginRpc(contract, invoke, input) {
    const output = await invoke(contract.name, input);
    return contract.output.parseAsync(output);
}
export function defineSubscription(definition) {
    const name = definition.name.trim();
    if (!RPC_NAME.test(name))
        throw new Error(`Invalid plugin subscription: ${definition.name}`);
    return { ...definition, name };
}
export function subscribePluginRpc(contract, subscribe, input, onEvent, options = {}) {
    // The plugin parses the input into the schema's output, so it receives the input as given.
    contract.input.parse(input);
    let closed = false;
    function close(error) {
        if (closed)
            return;
        closed = true;
        options.onClosed?.(error ? { error } : {});
    }
    const handle = subscribe(contract.name, input, {
        event(event) {
            if (closed)
                return;
            const parsed = contract.event.safeParse(event);
            if (parsed.success)
                return onEvent(parsed.data);
            handle();
            close(new Error(`Plugin subscription ${contract.name} sent an invalid event`));
        },
        closed: close,
    });
    if (options.signal) {
        if (options.signal.aborted)
            handle();
        else
            options.signal.addEventListener("abort", () => handle(), { once: true });
    }
    return handle;
}
