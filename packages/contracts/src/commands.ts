// "/" in the input: what a request can start with, as the engine reports it.

/**
 * An engine command or skill. `command`: the engine's own (Claude Code built-ins, `/compact`);
 * `skill`: one the user, a project or a plugin defined (Claude commands and skills, Codex skills).
 */
export type EngineCommand = { name: string; description: string; hint: string | null; kind: "command" | "skill" };
