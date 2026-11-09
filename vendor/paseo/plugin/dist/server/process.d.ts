import { type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
export interface ExecCommandOptions {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    encoding?: BufferEncoding;
    killSignal?: NodeJS.Signals;
    timeout?: number;
    maxBuffer?: number;
    shell?: boolean | string;
    signal?: AbortSignal;
}
interface ExecCommandResult {
    stdout: string;
    stderr: string;
}
/** Launch a CLI with Windows command-script handling and argv quoting. The caller owns env. */
export declare function spawnProcess(command: string, args: string[], options: SpawnOptions & {
    stdio: "pipe";
}): ChildProcessWithoutNullStreams;
export declare function spawnProcess(command: string, args: string[], options?: SpawnOptions): ChildProcess;
export declare function execCommand(command: string, args: string[], options?: ExecCommandOptions): Promise<ExecCommandResult>;
/** Force-stop a CLI, including descendants behind Windows command-script launchers. */
export declare function terminateProcess(child: ChildProcess, signal?: NodeJS.Signals): Promise<void>;
export {};
