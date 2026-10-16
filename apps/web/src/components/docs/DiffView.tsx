import { diffLines, diffWordsWithSpace } from "diff";
import { Fragment, useMemo } from "react";

type Row = { kind: "same" | "add" | "del"; text: string; pair?: string };

/** Line diff with word marks inside changed lines; long unchanged runs fold. */
export function DiffView({ before, after, beforeLabel, afterLabel }: { before: string; after: string; beforeLabel: string; afterLabel: string }) {
  const rows = useMemo(() => {
    const out: Row[] = [];
    const parts = diffLines(before, after);
    parts.forEach((part, index) => {
      const lines = part.value.replace(/\n$/, "").split("\n");
      const kind = part.added ? "add" : part.removed ? "del" : "same";
      // Pair a removed run with the added run right after it, for word-level marks.
      const next = parts[index + 1];
      const prev = parts[index - 1];
      const partner = part.removed && next?.added ? next.value.replace(/\n$/, "").split("\n") : part.added && prev?.removed ? prev.value.replace(/\n$/, "").split("\n") : null;
      lines.forEach((text, line) => out.push({ kind, text, pair: partner?.[line] }));
    });
    return out;
  }, [before, after]);

  const changes = rows.filter((row) => row.kind !== "same").length;
  return (
    <div className="diff-view">
      <div className="diff-legend">
        <span className="diff-del">− {beforeLabel}</span>
        <span className="diff-add">+ {afterLabel}</span>
        <span className="muted">바뀐 줄 {changes}</span>
      </div>
      <div className="diff-lines">
        {rows.map((row, index) => {
          if (row.kind === "same") {
            // Keep three lines of context around changes.
            const near = rows.slice(Math.max(0, index - 3), index + 4).some((other) => other.kind !== "same");
            if (!near) {
              const previousShown = index > 0 && rows.slice(Math.max(0, index - 4), index + 3).some((other) => other.kind !== "same");
              return previousShown ? (
                <div key={index} className="diff-fold">
                  ⋯
                </div>
              ) : null;
            }
            return (
              <div key={index} className="diff-line same">
                <span className="diff-sign"> </span>
                {row.text || " "}
              </div>
            );
          }
          const words = row.pair !== undefined ? diffWordsWithSpace(row.kind === "del" ? row.text : row.pair, row.kind === "del" ? row.pair : row.text) : null;
          return (
            <div key={index} className={`diff-line ${row.kind}`}>
              <span className="diff-sign">{row.kind === "add" ? "+" : "−"}</span>
              {words
                ? words.map((word, at) =>
                    (row.kind === "add" && word.removed) || (row.kind === "del" && word.added) ? null : (
                      <Fragment key={at}>{word.added || word.removed ? <mark>{word.value}</mark> : word.value}</Fragment>
                    ),
                  )
                : row.text || " "}
            </div>
          );
        })}
      </div>
    </div>
  );
}
