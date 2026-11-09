// Extracted from Paseo 1fff127f45b11c1c9c573fbbd12791673004c912, Apache-2.0.
// Original modules and their hashes are preserved in upstream/ and source.json.
export type MessageInputEnterAction = "alternate-send" | "default-send";

export interface MessageInputEnterContext {
  submitOnEnter: boolean;
  sendShortcut: "enter" | "mod-enter";
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  isAgentRunning: boolean;
  onQueue: (() => void) | undefined;
}

export function resolveMessageInputEnterAction(
  ctx: MessageInputEnterContext,
): MessageInputEnterAction | null {
  if (!ctx.submitOnEnter) return null;
  if (ctx.shiftKey) return null;
  const hasModifier = ctx.metaKey || ctx.ctrlKey;
  if (ctx.sendShortcut === "mod-enter") return hasModifier ? "default-send" : null;
  if (hasModifier && ctx.isAgentRunning && ctx.onQueue) return "alternate-send";
  return "default-send";
}
