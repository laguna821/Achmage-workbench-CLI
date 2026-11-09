export declare const PRIVATE_DIRECTORY_MODE = 448;
export declare const PRIVATE_FILE_MODE = 384;
export declare function ensurePrivateDirectory(directoryPath: string): void;
export declare function ensurePrivateFile(filePath: string): void;
export declare function writePrivateFileAtomicSync(filePath: string, data: string | NodeJS.ArrayBufferView): void;
export declare function ensurePrivateFileAsync(filePath: string): Promise<void>;
export declare function writePrivateFileAtomic(filePath: string, data: string): Promise<void>;
