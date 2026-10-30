import { AgentLoop as OriginalAgentLoop, type AgentLoopOptions, type AgentRunResult } from "../../../vendor/ieumoffice/packages/agent-core/src/loop.ts";
import type { AgentImage, AgentMessage, AgentToolCall } from "../../../vendor/ieumoffice/packages/agent-core/src/types.ts";
import type { OfficeTurnEvent, OfficeTurnFinish } from "../../../packages/contracts/src/office-ai.ts";
import type { OfficeSkillContext } from "../../../packages/contracts/src/office-skills.ts";

/** The renderer owns no conversation database. Every run borrows the selected Workbench session. */
export type OfficeRun = {
  history: AgentMessage[];
  images?: AgentImage[];
  append(events: OfficeTurnEvent[]): Promise<void>;
  save(): Promise<void>;
  finish(status: OfficeTurnFinish["status"], error?: string): Promise<void>;
};
export type OfficeConversationPort = {
  begin(instruction: string, signal: AbortSignal, images?: AgentImage[], skills?: OfficeSkillContext): Promise<OfficeRun>;
  attach(loop: WorkbenchAgentLoop<unknown>): () => void;
};
let conversation: OfficeConversationPort | null = null;
export function installOfficeConversation(value: OfficeConversationPort) { conversation = value; }
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Keep the original validation, redaction, retries, snapshots and tool loop. Only its
 * persistence boundary is different: a tool cannot run ahead of its durable start record,
 * and a follow-up model call cannot run ahead of the saved document/tool result. */
export class WorkbenchAgentLoop<TSnapshot = unknown> {
  private readonly original: OriginalAgentLoop<TSnapshot>;
  private readonly options: AgentLoopOptions<TSnapshot>;
  private readonly port: OfficeConversationPort | null;
  private runState: OfficeRun | null = null;
  private pending = false;
  private ending = false;
  private detached = false;
  private abort = new AbortController();
  private queue: Promise<void> = Promise.resolve();
  private fault: string | null = null;
  private assistantId = "";
  private assistantText = "";
  private reasoningText = "";
  private readonly toolIds = new Map<AgentToolCall, string>();
  private release = () => {};
  private resolveSettled = () => {};
  settled: Promise<void> = Promise.resolve();

  constructor(options: AgentLoopOptions<TSnapshot>, port = conversation) {
    this.options = options; this.port = port;
    const enqueue = (task: () => Promise<void>) => this.enqueue(task);
    const events = options.events;
    this.original = new OriginalAgentLoop({
      ...options,
      skill: new Proxy(options.skill, {
        get: (skill, key) => key === "executeTool" ? async (call: AgentToolCall, signal?: AbortSignal) => {
          await this.queue;
          if (this.fault) throw new Error(this.fault);
          if (this.abort.signal.aborted || signal?.aborted) throw new Error("요청을 취소했습니다.");
          return skill.executeTool(call, signal);
        } : Reflect.get(skill, key, skill),
      }),
      transport: {
        stream: (request, callbacks) => {
          let handle: { cancel(): void } | null = null, cancelled = false;
          void this.queue.then(() => {
            if (this.fault) { callbacks.onError(this.fault); return; }
            if (cancelled || this.abort.signal.aborted) { callbacks.onDone(); return; }
            handle = options.transport.stream(request, {
              ...callbacks,
              onReasoning: (delta) => {
                this.reasoningText += delta;
                callbacks.onReasoning?.(delta);
              },
            });
          }).catch((error) => callbacks.onError(messageOf(error)));
          return { cancel: () => { cancelled = true; handle?.cancel(); } };
        },
      },
      events: {
        ...events,
        onText: (text) => {
          this.assistantText = text;
          // Coalesce cumulative stream updates while a previous write is in flight.
          this.scheduleText();
          if (!this.detached) events?.onText?.(text);
        },
        onToolStart: (call) => {
          const id = crypto.randomUUID(); this.toolIds.set(call, id);
          const event: OfficeTurnEvent = { kind: "tool", id, name: call.name, summary: call.name, input: JSON.stringify(call.input), output: null, status: "running" };
          enqueue(() => this.runState!.append([event]));
          if (!this.detached) events?.onToolStart?.(call);
        },
        onToolExecuted: (event) => {
          const { call, execution } = event;
          const record: OfficeTurnEvent = { kind: "tool", id: this.toolIds.get(call) ?? crypto.randomUUID(), name: call.name, summary: execution.summary, input: JSON.stringify(call.input), output: execution.output, status: execution.isError ? "failed" : "completed" };
          enqueue(async () => {
            await this.runState!.append([record]);
            if (execution.mutated) await this.runState!.save();
          });
          if (!this.detached) events?.onToolExecuted?.(event);
        },
        onTurnEnd: () => {
          this.sealText();
          this.assistantId = crypto.randomUUID(); this.assistantText = ""; this.reasoningText = "";
          if (!this.detached) events?.onTurnEnd?.();
        },
        onDone: (result) => { void this.finish(result); },
        onError: (error) => { void this.finish(undefined, error); },
      },
    });
  }

  get busy() { return this.pending || this.original.busy; }
  get messages() { return this.original.messages; }
  restore(messages: AgentMessage[]) { if (!this.busy) this.original.restore(messages); }
  run(instruction: string, images?: AgentImage[], skills?: OfficeSkillContext): void {
    if (this.busy || !instruction.trim()) return;
    if (!this.port) { this.options.events?.onError?.("Workbench 문서 세션을 먼저 연결해 주세요."); return; }
    this.pending = true; this.ending = false; this.detached = false; this.fault = null;
    this.abort = new AbortController(); this.queue = Promise.resolve(); this.toolIds.clear();
    this.assistantId = crypto.randomUUID(); this.assistantText = ""; this.reasoningText = "";
    this.settled = new Promise((resolve) => { this.resolveSettled = resolve; });
    try { this.release = this.port.attach(this as WorkbenchAgentLoop<unknown>); }
    catch (error) { void this.finish(undefined, messageOf(error)); return; }
    void this.port.begin(instruction, this.abort.signal, images, skills).then((run) => {
      this.runState = run;
      if (this.abort.signal.aborted) { void this.finish({ text: "", cancelled: true, turnLimit: false }); return; }
      this.original.reset(); this.original.restore(run.history);
      this.original.run(instruction, run.images ?? images);
    }).catch((error) => { void this.finish(undefined, messageOf(error)); });
  }
  cancel(): void { this.abort.abort(); this.original.cancel(); }
  reset(): void {
    // Unmounting a panel must not erase or silently abandon a Workbench run.
    this.detached = true; this.cancel();
    if (!this.pending) this.original.reset();
  }
  private enqueue(task: () => Promise<void>) {
    this.queue = this.queue.then(async () => {
      if (this.fault) return;
      try { await task(); }
      catch (error) { this.fault = messageOf(error); this.cancel(); }
    });
  }
  private textTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduleText() {
    if (this.textTimer) return;
    // A local host can acknowledge faster than the model emits characters. Limit
    // cumulative rewrites so a long answer cannot exhaust the host's run byte cap.
    this.textTimer = setTimeout(() => {
      this.textTimer = null;
      const event: OfficeTurnEvent = { kind: "assistant", id: this.assistantId, text: this.assistantText, streaming: true };
      this.enqueue(() => this.runState!.append([event]));
    }, 250);
  }
  private sealText() {
    if (this.textTimer) { clearTimeout(this.textTimer); this.textTimer = null; }
    const events: OfficeTurnEvent[] = [];
    if (this.assistantText) events.push({ kind: "assistant", id: this.assistantId, text: this.assistantText, streaming: false });
    if (this.reasoningText) events.push({ kind: "reasoning", id: `${this.assistantId}_reasoning`, text: this.reasoningText });
    if (events.length) this.enqueue(() => this.runState!.append(events));
  }
  private async finish(result?: AgentRunResult, error?: string) {
    if (this.ending) return;
    this.ending = true;
    this.sealText();
    await this.queue;
    const failed = error ?? this.fault;
    let failure = failed;
    try { await this.runState?.finish(failed ? "failed" : result?.cancelled || this.abort.signal.aborted ? "interrupted" : "completed", failed ?? undefined); }
    catch (error) { failure = messageOf(error); }
    this.runState = null; this.pending = false; this.release(); this.resolveSettled();
    if (this.detached) { this.original.reset(); return; }
    if (failure) this.options.events?.onError?.(failure);
    else if (result) this.options.events?.onDone?.(result);
  }
}
