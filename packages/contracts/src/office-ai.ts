/** One user run may contain many provider round trips and document tools. */
export type OfficeTurnStart = { turnId: string; instruction: string; revision: number; selection?: string };
export type OfficeTurnEvent =
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  | { kind: "reasoning"; id: string; text: string }
  | { kind: "tool"; id: string; name: string; summary: string; input: string; output: string | null; status: "running" | "completed" | "failed" };
export type OfficeTurnEvents = { turnId: string; seq: number; events: OfficeTurnEvent[] };
export type OfficeTurnFinish = { turnId: string; status: "completed" | "interrupted" | "failed"; error?: string };
export type OfficeTurnReceipt = { turnId: string; sessionId: string; duplicate: boolean; status: "running" | "completed" | "interrupted" | "failed" };
