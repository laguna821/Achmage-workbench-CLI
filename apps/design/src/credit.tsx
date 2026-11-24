import { DOORY_ATTRIBUTION } from "@workbench/contracts";

/**
 * The Doory credit (vendor/doory/LICENSE clause 2; upstream NOTICE: "for a web app: on its pages"): the design
 * editor's top line, every time the editor opens, editable or read-only, on a PC or a phone. Prominent: the
 * editor's normal ink at 12px, never behind a menu or hover, never cut — on a narrow screen it wraps.
 */
export function DooryCredit() {
  return (
    <p className="wb-design-credit" role="note" aria-label="디자인 편집기 저작자 표시">
      <b>Doory</b> · {DOORY_ATTRIBUTION.name}, {DOORY_ATTRIBUTION.role} ·{" "}
      <a href={DOORY_ATTRIBUTION.url} target="_blank" rel="noreferrer">{DOORY_ATTRIBUTION.url}</a>
    </p>
  );
}
