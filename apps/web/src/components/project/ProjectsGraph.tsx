import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import type { ProjectStage, Work } from "@workbench/contracts";
import { buildGraph, layout, type GraphInput } from "../../graph.ts";
import { stageOf } from "../../project.ts";

/** One project as the graph draws it. */
export type GraphItem = { work: Work; stage: string | null; tags: string[]; related: string[]; sessions: number };

/**
 * "그래프" in home "프로젝트": projects (coloured by stage, sized by sessions) and, if shown, their
 * tags; lines for "관련" and for tags. Laid out once (static, also with reduced motion); the wheel
 * zooms, the background drags. A project opens its page; a tag highlights its projects.
 */
export function ProjectsGraph({ items, stages, openProject }: { items: GraphItem[]; stages: ProjectStage[]; openProject: (work: Work) => void }) {
  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 900, height: 560 });
  const [withTags, setWithTags] = useState(true);
  const [hover, setHover] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const pan = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const measure = () => setSize({ width: Math.max(480, element.clientWidth), height: Math.max(420, Math.min(720, Math.round(element.clientWidth * 0.62))) });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const input: GraphInput = useMemo(() => items.map((item) => ({ id: item.work.id, title: item.work.title, tags: item.tags, related: item.related, sessions: item.sessions })), [items]);
  const { nodes, edges } = useMemo(() => buildGraph(input, withTags), [input, withTags]);
  const placed = useMemo(() => layout(nodes, edges, size), [nodes, edges, size]);
  const at = useMemo(() => new Map(placed.map((node) => [node.id, node] as const)), [placed]);
  const works = useMemo(() => new Map<string, GraphItem>(items.map((item) => [`p:${item.work.id}`, item])), [items]);

  // Who is lit: the hovered (or focused tag's) point and its neighbours; everything else dims.
  const lit = useMemo(() => {
    const centre = hover ?? focus;
    if (!centre) return null;
    const set = new Set([centre]);
    for (const edge of edges) {
      if (edge.from === centre) set.add(edge.to);
      if (edge.to === centre) set.add(edge.from);
    }
    return set;
  }, [hover, focus, edges]);

  const onWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - box.left;
    const py = event.clientY - box.top;
    const k = Math.min(3, Math.max(0.4, view.k * (event.deltaY < 0 ? 1.12 : 1 / 1.12)));
    setView({ k, x: px - ((px - view.x) / view.k) * k, y: py - ((py - view.y) / view.k) * k });
  };
  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if ((event.target as Element).closest(".graph-node")) return;
    pan.current = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const start = pan.current;
    if (start) setView({ ...view, x: start.vx + event.clientX - start.x, y: start.vy + event.clientY - start.y });
  };

  return (
    <div className="projects-graph" ref={frame}>
      <div className="graph-bar">
        <label className="check-row">
          <input type="checkbox" checked={withTags} onChange={(event) => setWithTags(event.target.checked)} /> 태그도 점으로
        </label>
        <span className="muted">
          프로젝트 {items.length} · 선 {edges.length}
          {!edges.length ? " — 프로젝트에 '관련'이나 태그를 달면 선이 생깁니다" : ""}
        </span>
        {focus ? (
          <button type="button" className="link small" onClick={() => setFocus(null)}>
            {at.get(focus)?.label} 강조 풀기
          </button>
        ) : null}
        <button type="button" className="link small" onClick={() => setView({ x: 0, y: 0, k: 1 })}>
          처음 크기로
        </button>
      </div>
      <svg
        className="graph-canvas"
        width={size.width}
        height={size.height}
        role="img"
        aria-label="프로젝트 그래프"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => (pan.current = null)}
      >
        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {edges.map((edge) => {
            const a = at.get(edge.from);
            const b = at.get(edge.to);
            if (!a || !b) return null;
            const dim = lit && !(lit.has(edge.from) && lit.has(edge.to));
            return <line key={`${edge.from}|${edge.to}`} className={`graph-edge ${edge.kind}${dim ? " dim" : ""}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
          })}
          {placed.map((node) => {
            const item = works.get(node.id);
            const stage = item ? stageOf(stages, item.stage) : null;
            const r = node.kind === "project" ? 5 + node.weight * 0.9 : 4 + node.weight;
            const dim = lit && !lit.has(node.id);
            return (
              <g
                key={node.id}
                className={`graph-node ${node.kind}${dim ? " dim" : ""}`}
                data-node={node.id}
                transform={`translate(${node.x} ${node.y})`}
                tabIndex={0}
                role="button"
                aria-label={node.label}
                onPointerEnter={() => setHover(node.id)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(node.id)}
                onBlur={() => setHover(null)}
                onClick={() => (item ? openProject(item.work) : setFocus(focus === node.id ? null : node.id))}
                onKeyDown={(event) => {
                  if (event.key === "Enter") item ? openProject(item.work) : setFocus(focus === node.id ? null : node.id);
                }}
              >
                <circle r={r} style={stage ? { fill: stage.color } : undefined} />
                <text y={r + 13}>{node.label.length > 18 ? `${node.label.slice(0, 17)}…` : node.label}</text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
