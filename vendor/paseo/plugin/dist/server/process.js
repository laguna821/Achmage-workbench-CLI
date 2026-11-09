import { execFile, spawn, } from "node:child_process";
import { extname } from "node:path";
import { promisify } from "node:util";
import { isWindowsCommandScript, quoteWindowsArgument, quoteWindowsCommand, } from "./process-internal/windows-command.js";
const execFileAsync = promisify(execFile);
function hasPathSeparator(value) {
    return value.includes("/") || value.includes("\\");
}
function shouldUseWindowsShell(command, requestedShell) {
    if (isWindowsCommandScript(command)) {
        return true;
    }
    if (requestedShell !== undefined) {
        return requestedShell;
    }
    return process.platform === "win32" && !hasPathSeparator(command) && !extname(command);
}
export function spawnProcess(command, args, options) {
    const spawnOptions = options ?? {};
    const isWindows = process.platform === "win32";
    const shell = shouldUseWindowsShell(command, spawnOptions.shell);
    const shouldQuoteForShell = isWindows && shell !== false;
    const resolvedCommand = shouldQuoteForShell ? quoteWindowsCommand(command) : command;
    const resolvedArgs = shouldQuoteForShell ? args.map(quoteWindowsArgument) : args;
    return spawn(resolvedCommand, resolvedArgs, {
        ...spawnOptions,
        env: options?.env,
        shell,
        signal: options?.signal,
        windowsHide: true,
    });
}
export async function execCommand(command, args, options) {
    const isWindows = process.platform === "win32";
    const shell = shouldUseWindowsShell(command, options?.shell);
    const shouldQuoteForShell = isWindows && shell !== false;
    const resolvedCommand = shouldQuoteForShell ? quoteWindowsCommand(command) : command;
    const resolvedArgs = shouldQuoteForShell ? args.map(quoteWindowsArgument) : args;
    return execFileAsync(resolvedCommand, resolvedArgs, {
        cwd: options?.cwd,
        env: options?.env,
        encoding: options?.encoding ?? "utf8",
        signal: options?.signal,
        killSignal: options?.killSignal,
        timeout: options?.timeout,
        maxBuffer: options?.maxBuffer,
        shell,
        windowsHide: true,
    });
}
/** Force-stop a CLI, including descendants behind Windows command-script launchers. */
export async function terminateProcess(child, signal = "SIGKILL") {
    if (process.platform !== "win32") {
        child.kill(signal);
        return;
    }
    if (child.pid === undefined)
        return;
    try {
        await execCommand("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
            shell: false,
            timeout: 5000,
        });
    }
    catch (error) {
        // The process can finish between its close check and taskkill.
        if (!(error instanceof Error && "code" in error && error.code === 128))
            throw error;
    }
}
