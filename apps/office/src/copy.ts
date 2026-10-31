import type { OfficeOutputFormat, OfficeOutputPlan } from "../../../packages/contracts/src/office-output.ts";
import { listen, post, type Init } from "./bridge.ts";
import { prepareOutput, commitOutput, cancelOutput } from "./output.ts";
import { recovery } from "./recovery.ts";

let active: OfficeCopy | null = null;
let aiBusy = () => false;
export const setCopyAiBusy = (check: () => boolean) => { aiBusy = check; };
export const officeCopyBusy = () => active !== null;
export const cancelOfficeCopy = () => { active?.cancel(); };
// Installed before the original renderers: their window-level shortcuts and paste
// listeners must not save the source while focus sits on our progress overlay.
window.addEventListener("keydown", (event) => {
  if (!active?.locked) return;
  if (event.key === "Tab" || (event.key === "Enter" || event.key === " ") && event.target instanceof HTMLButtonElement && event.target.closest(".workbench-copy-progress")) { event.stopImmediatePropagation(); return; }
  event.preventDefault(); event.stopImmediatePropagation();
  if (event.key === "Escape") active.cancel();
}, true);
for (const type of ["beforeinput", "paste", "cut", "drop"]) window.addEventListener(type, (event) => {
  if (active?.locked) { event.preventDefault(); event.stopImmediatePropagation(); }
}, true);

/** A short transaction around the original serializer. Its recovery belongs to the
 * original until the parent accepts the copy; no navigation is a source-file save. */
export class OfficeCopy {
  readonly preparationId = crypto.randomUUID();
  plan: OfficeOutputPlan | null = null;
  private source: Init;
  private revision: number;
  private restore: (() => void) | null = null;
  private stop: () => void;
  private committed: string | null = null;
  private committing = false;
  private button: HTMLButtonElement | null = null;
  get locked() { return this.restore !== null; }
  constructor(init: Init, revision: number) {
    this.source = init; this.revision = revision;
    this.stop = listen((message) => {
      if (message.type === "office:copy-rejected" && message.artifactId === this.committed) {
        this.release();
        post({ type: "office:error", message: "사본은 문서 목록에 저장했습니다. 현재 탭의 편집 내용은 그대로 유지합니다." });
      }
    });
  }
  lock() {
    if (this.restore) return;
    const focus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const roots = [...document.body.children].filter((node): node is HTMLElement => node instanceof HTMLElement).map((node) => [node, node.inert] as const);
    for (const [node] of roots) node.inert = true;
    const cover = document.createElement("div");
    cover.className = "workbench-copy-progress";
    cover.setAttribute("role", "status"); cover.setAttribute("aria-live", "polite");
    Object.assign(cover.style, { position: "fixed", inset: "0", zIndex: "2147483647", background: "#ffffffcc", display: "flex", alignItems: "center", justifyContent: "center", gap: "12px", color: "#222", font: "14px sans-serif" });
    const label = document.createElement("span"); label.textContent = "사본을 저장하는 중…";
    const button = document.createElement("button"); button.type = "button"; button.textContent = "취소"; button.onclick = () => this.cancel();
    this.button = button; cover.append(label, button); document.body.append(cover); button.focus();
    this.restore = () => { for (const [node, inert] of roots) node.inert = inert; cover.remove(); this.button = null; if (focus?.isConnected) focus.focus({ preventScroll: true }); };
  }
  /** PDF first asks about its annotations inside its own modal. */
  unlock() { this.restore?.(); this.restore = null; }
  private release() { this.unlock(); this.stop(); if (active === this) active = null; }
  cancel() {
    if (active !== this || this.committing || this.committed) return;
    void cancelOutput(this.plan?.id, this.preparationId).catch(() => {}); this.release();
  }
  async commit(bytes: ArrayBuffer, recoveryBytes = bytes) {
    if (active !== this || !this.plan) throw new Error("사본 저장을 취소했습니다.");
    this.lock(); this.committing = true; if (this.button) this.button.disabled = true;
    try {
      if (!(bytes instanceof ArrayBuffer) || !(recoveryBytes instanceof ArrayBuffer)) throw new Error("현재 문서 내용을 아직 받지 못했습니다. 문서를 연 뒤 다시 저장해 주세요.");
      // If the source view changes before the parent accepts this handoff, its draft survives.
      await recovery.put(this.source.artifact.id, { baseRevision: this.revision, bytes: recoveryBytes, at: Date.now() });
      const saved = await commitOutput(this.plan.id, bytes);
      this.committed = saved.artifactId;
      post({ type: "office:copied", artifactId: saved.artifactId });
      // Keep input locked until the old frame is replaced. A rejected handoff unlocks it.
      return saved;
    } catch (error) { void cancelOutput(this.plan.id, this.preparationId).catch(() => {}); this.release(); throw error; }
    finally { this.committing = false; }
  }
}

export async function beginOfficeCopy(init: Init, revision: number, format: OfficeOutputFormat) {
  if (active) throw new Error("이미 사본을 저장하고 있습니다.");
  if (aiBusy()) throw new Error("이 문서의 AI 편집이 끝난 뒤 사본을 저장해 주세요.");
  const turn = new OfficeCopy(init, revision); active = turn; turn.lock();
  try {
    turn.plan = await prepareOutput(revision, format, turn.preparationId);
    if (!turn.plan || active !== turn) { turn.cancel(); return null; }
    return turn;
  } catch (error) { turn.cancel(); throw error; }
}

export async function copyOfficeBytes(init: Init, revision: number, format: OfficeOutputFormat, capture: () => Promise<ArrayBuffer>) {
  const turn = await beginOfficeCopy(init, revision, format);
  if (!turn) return null;
  try { return await turn.commit(await capture()); }
  finally { turn.cancel(); }
}
