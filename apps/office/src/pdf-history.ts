/** Immutable source of the original renderer's pending-edit coordinates.
 * Saved bases are small revision references; only an unsaved recovery base owns bytes. */
export interface PdfHistoryBase { readonly revision: number; readonly recovery?: ArrayBuffer }
interface PdfHistoryPort {
  writable: boolean;
  capture(): PdfHistoryBase;
  unsaved(): boolean;
  busyChanged(busy: boolean): void;
  restore<T>(base: PdfHistoryBase, load: () => Promise<T>): Promise<T>;
}
let port: PdfHistoryPort;
let pending: Promise<unknown> | null = null;
export function bindPdfHistory(value: PdfHistoryPort) { port = value; }
export const pdfHistory = {
  capture: () => port.capture(),
  writable: () => port.writable,
  unsaved: () => port.unsaved(),
  busy: () => pending !== null,
  restore: <T>(base: PdfHistoryBase, load: () => Promise<T>) => port.restore(base, load),
  track(task: Promise<unknown>) {
    pending = task;
    port.busyChanged(true);
    void task.finally(() => { if (pending === task) { pending = null; port.busyChanged(false); } }).catch(() => {});
  },
  async idle() { while (pending) await pending; },
};

/** Allow the original React mirrors and close-save subscription to commit. */
export const pdfHistoryRendered = () => new Promise<void>((resolve) => {
  const timer = window.setTimeout(resolve, 100);
  requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
});
