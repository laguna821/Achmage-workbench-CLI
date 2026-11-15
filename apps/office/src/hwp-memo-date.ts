// A memo's date as rhwp 0.9.0 gives it (H4b): the local wall time with a literal "Z", the form
// Hangul writes (rhwp src/model/memo_time.rs: "한글 SaveAs는 현지 시각에 리터럴 Z를 붙인다";
// a memo typed now gets the same). Ieum's memo panel parses the string as UTC and shows it moved
// by the time zone (in Korea a memo typed at 17:39 read "다음 날 오전 2:39"). The panel's
// memoDateText is pointed at this reading (apps/office/vite.config.ts, hwpMemoDatePatch).

/** The instant to show for `raw`: a "…T…Z" date read as local wall time; anything else as the browser reads it. */
export function hwpMemoInstant(raw: string): Date {
  const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(raw);
  if (!local) return new Date(raw);
  const [, year, month, day, hour, minute, second] = local.map(Number) as number[];
  return new Date(year!, month! - 1, day!, hour!, minute!, second!);
}

const NEEDLE = "  const parsed = new Date(raw)\n";
/** Ieum's MemoPanel.tsx with memoDateText reading the date through hwpMemoInstant; throws when its text changed. */
export function hwpMemoDatePatch(code: string, helper: string): string {
  if (code.split(NEEDLE).length !== 2) throw new Error("Ieum memo panel date reading changed: review apps/office/src/hwp-memo-date.ts");
  return `import { hwpMemoInstant as __workbenchMemoInstant } from ${JSON.stringify(helper)}\n` + code.replace(NEEDLE, "  const parsed = __workbenchMemoInstant(raw)\n");
}
