import type { Agent } from "node:http";
/** Install once at startup; return ignored variable names for logging without exposing credentials. */
export declare function initializeEnvironmentProxy(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string[];
/** ws uses Node HTTP agents rather than the fetch dispatcher. */
export declare function webSocketProxyAgent(address: string): Agent | undefined;
