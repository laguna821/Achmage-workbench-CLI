import { memo, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { REMARK_BASE } from "../../markdown/plugins.ts";
import { diagramComponents } from "../Diagram.tsx";

const DRAWN = diagramComponents();

/** Lines shown before a request folds; about this many lines of the reading column. */
export const FOLD_LINES = 6;
/** Characters of Korean prose per line of the 720px column, for guessing wrapped lines. */
const LINE_CHARS = 48;

/** How many lines a request takes, wrapped lines included (a guess without layout). */
export function requestLines(text: string) {
  return text.split("\n").reduce((lines, line) => lines + Math.max(1, Math.ceil(line.length / LINE_CHARS)), 0);
}

type MdNode = { type: string; value?: string; children?: MdNode[] };

/**
 * A line break typed in a request stays a line break (Markdown would join the lines). Code keeps
 * its own lines anyway.
 */
function remarkLineBreaks() {
  const walk = (node: MdNode) => {
    if (!node.children) return;
    const next: MdNode[] = [];
    for (const child of node.children) {
      if (child.type === "text" && child.value?.includes("\n")) {
        child.value.split("\n").forEach((part, index) => {
          if (index > 0) next.push({ type: "break" });
          if (part) next.push({ type: "text", value: part });
        });
      } else {
        walk(child);
        next.push(child);
      }
    }
    node.children = next;
  };
  return (tree: MdNode) => walk(tree);
}

const TYPED = [...REMARK_BASE, remarkLineBreaks];

/**
 * A request's words as Markdown, folded after a few lines with "더 보기" (the words only: what came
 * with the request stays in view). `received`: another session's answer handed over by a link (its
 * own line breaks are Markdown's). `reveal`: a counter; each new value opens it (every search hit
 * or jump that lands inside, however it was folded since).
 */
export const RequestText = memo(function RequestText({ text, received = false, fold = true, reveal = 0 }: {
  text: string;
  received?: boolean;
  fold?: boolean;
  reveal?: number;
}) {
  const long = fold && requestLines(text) > FOLD_LINES;
  const [open, setOpen] = useState(reveal > 0);
  useLayoutEffect(() => { if (reveal) setOpen(true); }, [reveal]);
  // The guess can be wrong on a wide column: once laid out, a fold that hides nothing goes away.
  const [fits, setFits] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = body.current;
    if (!long || open || !element || !element.clientHeight) return;
    setFits(element.scrollHeight <= element.clientHeight + 1);
  }, [long, open, text]);
  const folded = long && !open && !fits;
  return (
    <div className={`request-text${received ? " received" : ""}`}>
      <div ref={body} className={`markdown${folded ? " folded" : ""}`} style={folded ? { ["--fold-lines" as string]: FOLD_LINES } : undefined}>
        <Markdown remarkPlugins={received ? REMARK_BASE : TYPED} components={DRAWN}>
          {text}
        </Markdown>
      </div>
      {long && !fits ? (
        <button type="button" className="request-more" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "접기" : "더 보기"}
        </button>
      ) : null}
    </div>
  );
});
