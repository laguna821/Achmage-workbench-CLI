interface CutoverProxy {
    fetch(request: Request): Promise<Response>;
}
export declare function createCutoverProxy(origin: string): CutoverProxy;
export {};
