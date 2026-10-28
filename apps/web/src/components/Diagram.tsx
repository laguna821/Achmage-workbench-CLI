import { useEffect, useRef, useState } from "react";
import type { Components } from "react-markdown";

/**
 * A Mermaid block drawn by Pele (the renderer Obsidian 1.15 uses): no code runs, the layout adapts
 * to the width (a mind map turns into a vertical tree when narrow), colours come from the look's
 * CSS variables. Loaded on demand, one diagram type at a time.
 */
export function Diagram({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let cancelled = false;
    let mounted: { destroy(): void } | null = null;
    setError(null);
    import("pele/lazy")
      .then(({ mountAsync }) => mountAsync(element, source, { zoom: "auto", onError: (problem) => setError(problem instanceof Error ? problem.message : String(problem)) }))
      .then((done) => {
        if (cancelled) done.destroy();
        else mounted = done;
      })
      .catch((problem: unknown) => !cancelled && setError(problem instanceof Error ? problem.message : String(problem)));
    return () => {
      cancelled = true;
      mounted?.destroy();
    };
  }, [source]);
  return (
    <figure className="diagram">
      <div ref={ref} className="pele" />
      {error ? (
        <figcaption className="diagram-error">
          도식을 그리지 못했습니다: {error}
          <pre>{source}</pre>
        </figcaption>
      ) : null}
    </figure>
  );
}

type Hast = { type: string; tagName?: string; value?: string; properties?: { className?: unknown }; children?: Hast[] };

const textOf = (node: Hast): string => (node.type === "text" ? (node.value ?? "") : (node.children ?? []).map(textOf).join(""));

/**
 * react-markdown parts that draw ```mermaid blocks with Pele. While a reply is still streaming the
 * block stays as code (half a diagram does not parse).
 */
export function diagramComponents(streaming = false): Components {
  return {
    pre({ node, children, ...rest }) {
      const code = (node as Hast | undefined)?.children?.[0];
      const classes = code?.properties?.className;
      const mermaid = code?.tagName === "code" && Array.isArray(classes) && classes.includes("language-mermaid");
      if (mermaid && !streaming) return <Diagram source={textOf(code).trim()} />;
      return <pre {...rest}>{children}</pre>;
    },
  };
}
