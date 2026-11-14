/**
 * Test documents for the Hangul text census, built here (never taken from third parties): the
 * engine's own HWPX export of a blank document gives the package and header; the section is
 * written below so that every container kind holds text of its own, with a known length.
 */
import JSZip from "jszip";
import { HwpDocument } from "../../../third_party/hop/rhwp-core/rhwp.js";

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const SUB = (paragraphs: string) => `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${paragraphs}</hp:subList>`;
let ids = 100;
/** One paragraph; `inner` is the content of its single run (text and controls). */
export const para = (inner: string) => `<hp:p id="${ids++}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0">${inner}</hp:run></hp:p>`;
export const text = (value: string) => `<hp:t>${xml(value)}</hp:t>`;
/** A tab and a line break (Shift+Enter) inside a run, as the engine itself writes them. */
export const tab = `<hp:t><hp:tab width="4000" leader="0" type="1"/></hp:t>`;
export const lineBreak = `<hp:t><hp:lineBreak/></hp:t>`;
const POS = (treatAsChar: number) => `<hp:pos treatAsChar="${treatAsChar}" affectLSpacing="0" flowWithText="0" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>`;
const MARGIN = (tag: string) => `<hp:${tag} left="283" right="283" top="283" bottom="283"/>`;
export const caption = (paragraphs: string) => `<hp:caption side="BOTTOM" fullSz="0" width="8504" gap="850" lastWidth="20000">${SUB(paragraphs)}</hp:caption>`;

/** A table of one row; each cell holds the given paragraphs. */
export function table(cells: string[], options: { caption?: string } = {}) {
  const width = 40000, cell = Math.floor(width / cells.length);
  const tcs = cells.map((paragraphs, col) => `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="3">${SUB(paragraphs)}<hp:cellAddr colAddr="${col}" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="${cell}" height="1282"/><hp:cellMargin left="510" right="510" top="141" bottom="141"/></hp:tc>`).join("");
  return `<hp:tbl id="${ids++}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="NONE" repeatHeader="0" rowCnt="1" colCnt="${cells.length}" cellSpacing="0" borderFillIDRef="3" noAdjust="0"><hp:sz width="${width}" widthRelTo="ABSOLUTE" height="1282" heightRelTo="ABSOLUTE" protect="0"/>${POS(0)}${MARGIN("outMargin")}${options.caption ?? ""}<hp:inMargin left="510" right="510" top="141" bottom="141"/><hp:tr>${tcs}</hp:tr></hp:tbl>`;
}

/** A rectangle with a text box (글상자). */
export function textBox(paragraphs: string, options: { caption?: string } = {}) {
  return `<hp:rect id="${ids++}" zOrder="1" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${ids++}" ratio="0"><hp:offset x="0" y="0"/><hp:orgSz width="12000" height="4000"/><hp:curSz width="12000" height="4000"/><hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="6000" centerY="2000" rotateimage="0"/><hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo><hp:lineShape color="#000000" width="33" style="SOLID" endCap="FLAT" headStyle="NORMAL" tailStyle="NORMAL" headfill="1" tailfill="1" headSz="MEDIUM_MEDIUM" tailSz="MEDIUM_MEDIUM" outlineStyle="NORMAL" alpha="0"/><hc:fillBrush><hc:winBrush faceColor="#FFFFFF" hatchColor="#000000" alpha="0"/></hc:fillBrush><hp:drawText lastWidth="12000" name="" editable="0">${SUB(paragraphs)}${MARGIN("textMargin")}</hp:drawText><hc:pt0 x="0" y="0"/><hc:pt1 x="12000" y="0"/><hc:pt2 x="12000" y="4000"/><hc:pt3 x="0" y="4000"/><hp:sz width="12000" widthRelTo="ABSOLUTE" height="4000" heightRelTo="ABSOLUTE" protect="0"/>${POS(0)}${MARGIN("outMargin")}${options.caption ?? ""}</hp:rect>`;
}
const note = (tag: "footNote" | "endNote", paragraphs: string) => `<hp:ctrl><hp:${tag} number="1" suffixChar="41" instId="${ids++}">${SUB(paragraphs)}</hp:${tag}></hp:ctrl>`;
export const footnote = (paragraphs: string) => note("footNote", paragraphs);
export const endnote = (paragraphs: string) => note("endNote", paragraphs);
export const header = (paragraphs: string) => `<hp:ctrl><hp:header id="${ids++}" applyPageType="BOTH">${SUB(paragraphs)}</hp:header></hp:ctrl>`;
export const footer = (paragraphs: string) => `<hp:ctrl><hp:footer id="${ids++}" applyPageType="BOTH">${SUB(paragraphs)}</hp:footer></hp:ctrl>`;
export const hiddenComment = (paragraphs: string) => `<hp:ctrl><hp:hiddenComment>${SUB(paragraphs)}</hp:hiddenComment></hp:ctrl>`;
/** A memo anchored on the text that follows it (`anchored`), as the engine itself writes one. */
export const memo = (memoText: string, anchored: string) => `<hp:ctrl><hp:fieldBegin id="${ids}" type="MEMO" name="" editable="1" dirty="1"><hp:parameters cnt="6" name=""><hp:integerParam name="Prop">0</hp:integerParam><hp:stringParam name="Command">MEMO/65535/1/1/2654435762/a/\\;;</hp:stringParam><hp:stringParam name="ID">memo${ids}</hp:stringParam><hp:integerParam name="Number">1</hp:integerParam><hp:stringParam name="Author">a</hp:stringParam><hp:stringParam name="MemoShapeIDRef">65535</hp:stringParam></hp:parameters>${SUB(para(text(memoText)))}</hp:fieldBegin></hp:ctrl>${text(anchored)}<hp:ctrl><hp:fieldEnd beginIDRef="${ids++}"/></hp:ctrl>`;

let template: Promise<{ zip: Uint8Array; head: string }> | null = null;
/** The engine's own HWPX package for a blank document, and its first paragraph up to the section settings. */
function blankPackage() {
  template ??= (async () => {
    const doc = HwpDocument.createEmpty();
    let bytes: Uint8Array;
    try { doc.createBlankDocument(); bytes = doc.exportHwpx(); } finally { doc.free(); }
    const section = await (await JSZip.loadAsync(bytes)).file("Contents/section0.xml")!.async("string");
    const end = section.indexOf("</hp:secPr>");
    const colEnd = section.indexOf("</hp:ctrl>", end) + "</hp:ctrl>".length;
    if (end < 0 || colEnd < end) throw new Error("the engine's blank HWPX has no section settings");
    return { zip: bytes, head: section.slice(0, colEnd) };
  })();
  return template;
}

/** One section: the run of its first paragraph after the section settings, and the paragraphs that follow. */
export type FixtureSection = { first: string; body: string[] };
/**
 * An HWPX document whose sections hold the given paragraphs (made with `para`). The first paragraph
 * of each section also carries the section settings (its run continues with `first`).
 */
export async function buildHwpx(first: string, body: string[], more: FixtureSection[] = []): Promise<Uint8Array> {
  const { zip, head } = await blankPackage();
  const out = await JSZip.loadAsync(zip);
  const sections = [{ first, body }, ...more];
  sections.forEach((section, index) => out.file(`Contents/section${index}.xml`, `${head}${section.first}</hp:run></hp:p>${section.body.join("")}</hs:sec>`));
  if (more.length) {
    let hpf = await out.file("Contents/content.hpf")!.async("string");
    const items = more.map((_, index) => `<opf:item id="section${index + 1}" href="Contents/section${index + 1}.xml" media-type="application/xml"/>`).join("");
    const refs = more.map((_, index) => `<opf:itemref idref="section${index + 1}" linear="yes"/>`).join("");
    hpf = hpf.replace(/(<opf:item id="section0"[^>]*\/>)/, `$1${items}`).replace(/(<opf:itemref idref="section0"[^>]*\/>)/, `$1${refs}`);
    out.file("Contents/content.hpf", hpf);
  }
  // the preview text of the blank template would not match the new body
  out.remove("Preview/PrvText.txt");
  out.file("mimetype", await out.file("mimetype")!.async("string"), { compression: "STORE" });
  return out.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

/** A document whose footnote, endnote, header and memo hold tabs and line breaks (regression N2-1). */
export const notesWithBreaks = () => buildHwpx(text("본문") + header(para(text("머리") + tab + text("말"))), [
  para(text("둘") + footnote(para(text("각주") + tab + text("끝") + lineBreak + text("다음"))) + endnote(para(text("미주") + lineBreak + text("끝") + tab))),
  para(memo("메모\t글", "셋")),
]);

/**
 * A document whose body, footnote and header hold a carriage return (and the header a vertical tab)
 * written as character references, as generated files (lxml, .NET) serialise them — regression
 * N3-1 / T1. The table cell holds `cell`, so a save that empties it can be told apart. The memo holds
 * none: Ieum's vendored memo check (third_party/ieumoffice/hwp/memos.ts, older than these units)
 * matches memo text exactly and refuses an HWPX save whose memo held a CR the writer dropped.
 */
export const withControlCharacters = (cell = "성명 홍길동") => buildHwpx(text("본문") + header(para(`<hp:t>머리&#11;말&#13;</hp:t>`)), [
  para(`<hp:t>가&#13;나다</hp:t>` + footnote(para(`<hp:t>각주&#13;끝</hp:t>`))),
  para(table([para(text(cell))])),
  para(memo("메모글", "셋")),
]);
