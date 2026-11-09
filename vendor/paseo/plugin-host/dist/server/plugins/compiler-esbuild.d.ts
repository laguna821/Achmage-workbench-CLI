export declare const SERVER_HOST_MODULES: string[];
export declare function unpackedEsbuildBinaryFromPackageDir(esbuildPackageDir: string, platform: NodeJS.Platform, arch: string): string | null;
export declare function resolveExistingAsarUnpackedEsbuildBinary(esbuildPackageDir: string, platform?: NodeJS.Platform, arch?: string, exists?: (file: string) => boolean): string | null;
export declare function loadEsbuild(): typeof import("esbuild");
