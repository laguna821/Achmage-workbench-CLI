import type { CSSProperties } from "react";
import type { Artifact } from "@workbench/contracts";
import type { IconName } from "./Icon.tsx";
import chat from "../vendor/icons8-liquid-glass/chat.png";
import document from "../vendor/icons8-liquid-glass/document.png";
import file from "../vendor/icons8-liquid-glass/file.png";
import folder from "../vendor/icons8-liquid-glass/folder.png";
import globe from "../vendor/icons8-liquid-glass/globe.png";
import image from "../vendor/icons8-liquid-glass/image.png";
import word from "../vendor/icons8-liquid-glass/ms-word.png";
import sheet from "../vendor/icons8-liquid-glass/ms-excel.png";
import project from "../vendor/icons8-liquid-glass/create-new.png";
import design from "../vendor/icons8-liquid-glass/paint-palette.png";
import pdf from "../vendor/icons8-liquid-glass/pdf.png";
import slides from "../vendor/icons8-liquid-glass/presentation.png";
import "../styles/item-icons.css";

// Item icons (atlas-look, the owner 2026-11-15): the things a person works with — 프로젝트, 폴더, 대화,
// 웹 페이지 and each kind of document — wear the artwork Atlas File Manager uses, Icons8's "Liquid Glass"
// (vendor/icons8-liquid-glass/NOTICE.md; the attribution is in 설정 › 정보). The PNGs are white glass, which
// vanishes on a white list, so each is drawn through its own shape (a CSS mask) in one hue per kind (the
// --item-* tokens, light and dark). The rail, toolbars, keys and state glyphs keep the line set (Icon.tsx);
// a state is said by its glyph and word, never by an item icon's colour. Same box as the line icon it
// replaces (size × size), so no row moves.

export type ItemKind = "project" | "folder" | "folderOpen" | "chat" | "web" | "markdown" | "hwp" | "word" | "slides" | "sheet" | "pdf" | "design" | "image" | "file";

const ART: Record<ItemKind, string> = {
  project, folder, folderOpen: folder, chat, web: globe, markdown: document, hwp: document, word, slides, sheet, pdf, design, image, file,
};

export function ItemIcon({ kind, size = 16, className }: { kind: ItemKind; size?: number; className?: string }) {
  const style = { width: size, height: size, "--item-art": `url("${ART[kind]}")` } as CSSProperties;
  return <span className={`item-icon item-${kind}${className ? ` ${className}` : ""}`} style={style} aria-hidden="true" />;
}

/** A document's kind for its icon (format, and a picture by its name). */
export function artifactKind(artifact: Pick<Artifact, "format" | "name">): ItemKind {
  switch (artifact.format) {
    case "markdown": case "text": return "markdown";
    case "hwp": case "hwpx": return "hwp";
    case "docx": case "doc": return "word";
    case "pptx": case "ppt": return "slides";
    case "xlsx": case "ods": return "sheet";
    case "pdf": return "pdf";
    case "html": return "web";
    case "design": case "xmind": return "design";
    default: return /\.(png|jpe?g|gif|webp|svg|heic)$/i.test(artifact.name) ? "image" : "file";
  }
}

/** The item kind a line icon name stood for at a call site that draws items (null: not an item). */
export function itemKindOf(name: IconName | string): ItemKind | null {
  const map: Record<string, ItemKind> = { project: "project", folder: "folder", folderOpen: "folderOpen", chat: "chat", globe: "web", page: "markdown", mindmap: "markdown", palette: "design", image: "image", file: "file" };
  return map[name] ?? null;
}
