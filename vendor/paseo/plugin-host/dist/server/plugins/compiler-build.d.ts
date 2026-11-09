export declare function compilePlugin(entryPaths: {
    client: string | null;
    server: string | null;
}): Promise<{
    clientBundle: string | null;
    serverBundle: string | null;
}>;
export declare function compileDirectoryPlugin(directory: string, version: string, builtinId?: string): Promise<{
    manifest: {
        id: string;
        name?: string;
        description?: string;
        icon?: string;
        media?: string[];
        requirements?: {
            paseo?: string;
        };
        build?: string[][];
    };
    clientBundle: string | null;
    serverBundle: string | null;
}>;
