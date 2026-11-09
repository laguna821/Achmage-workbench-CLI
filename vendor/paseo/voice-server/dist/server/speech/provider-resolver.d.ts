export type Resolvable<T> = T | (() => T);
export declare function toResolver<T>(value: Resolvable<T>): () => T;
