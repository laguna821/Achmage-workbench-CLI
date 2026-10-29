import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import type { ProjectStage, Work } from "@workbench/contracts";
import { buildGraph, filterGraph, pointShape, shortLabel, type GraphInput } from "../../graph.ts";
import { forcesOf, readGraphSettings, writeGraphSettings, type GraphSettings } from "../../graph-settings.ts";
import { GraphView, type GraphMemory } from "../../graph-view.ts";
import { stageOf } from "../../project.ts";
import { Icon } from "../Icon.tsx";
import { GraphSettingsPanel } from "./GraphSettingsPanel.tsx";
import "../../styles/graph.css";

/** One project as the graph draws it. */
export type GraphItem = { work: Work; stage: string | null; tags: string[]; related: string[]; sessions: number; archived?: boolean };

/** What the graph showed when it was last left (this window only): coming back shows the same picture. */
const memory: GraphMemory = { positions: new Map(), view: null, follow: true };

const REDUCED = "(prefers-reduced-motion: reduce)";

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && Boolean(window.matchMedia?.(REDUCED).matches));
  useEffect(() => {
    const list = window.matchMedia?.(REDUCED);
    if (!list) return;
    const onChange = () => setReduced(list.matches);
    list.addEventListener?.("change", onChange);
    return () => list.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

/**
 * "그래프" in home "프로젝트", in the manner of Obsidian's graph view: projects (coloured by stage,
 * sized by sessions) and, if shown, their tags, with lines for "관련" and for tags; the points move
 * under live forces and can be dragged (neighbours follow). The wheel zooms at the cursor, the
 * background pans. A project opens its page, a tag lights its projects. The gear opens the
 * settings (filters, colours, display, forces), kept on this device.
 */
export function ProjectsGraph({
  items,
  stages,
  openProject,
  loading = false,
  groupColor,
}: {
  items: GraphItem[];
  stages: ProjectStage[];
  openProject: (work: Work) => void;
  loading?: boolean;
  /** The view's group colour of a project (home's views): it colours the point before the stage does. */
  groupColor?: (workId: string) => string | null;
}) {
  const [settings, setSettings] = useState<GraphSettings>(readGraphSettings);
  const change = useCallback((next: GraphSettings) => {
    setSettings(next);
    writeGraphSettings(next);
  }, []);
  const reduced = useReducedMotion();
  const [panel, setPanel] = useState(false);
  const [focus, setFocus] = useState<string | null>(null);
  const [pinned, setPinned] = useState(0);
  const [size, setSize] = useState({ width: 900, height: 560 });
  const frame = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const world = useRef<SVGGElement>(null);
  const gear = useRef<HTMLButtonElement>(null);
  const paths = useRef<(SVGPathElement | null)[]>([]);
  const view = useRef<GraphView | null>(null);
  if (!view.current) view.current = new GraphView(forcesOf(settings), memory);
  const engine = view.current;

  useLayoutEffect(() => {
    const [tag, related, arrows, tagLit, relatedLit, arrowsLit] = paths.current as SVGPathElement[];
    engine.onPinned = setPinned;
    engine.onBackground = () => setFocus(null);
    engine.attach({ svg: svg.current!, world: world.current!, tag: tag!, related: related!, arrows: arrows!, tagLit: tagLit!, relatedLit: relatedLit!, arrowsLit: arrowsLit! });
    return () => engine.detach(memory);
  }, [engine]);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const measure = () => {
      const width = Math.max(480, element.clientWidth);
      setSize((current) => {
        const next = { width, height: Math.max(420, Math.min(720, Math.round(width * 0.62))) };
        return current.width === next.width && current.height === next.height ? current : next;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The parent draws often (sessions change); the graph's input only changes with what it shows.
  // Nothing is laid out until the projects' notes are read (their "관련").
  const key = loading ? "" : JSON.stringify(items.map((item) => [item.work.id, item.work.title, item.tags, item.related, item.sessions, Boolean(item.archived)]));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const input: GraphInput = useMemo(() => (loading ? [] : items.map((item) => ({ id: item.work.id, title: item.work.title, tags: item.tags, related: item.related, sessions: item.sessions, archived: item.archived }))), [key]);
  const latest = useRef(items);
  latest.current = items;

  const { filter, display, color, force } = settings;
  const graph = useMemo(() => filterGraph(input, filter), [input, filter.tags, filter.archived, filter.orphans, filter.search]); // eslint-disable-line react-hooks/exhaustive-deps
  const shapes = useMemo(() => new Map(graph.nodes.map((node) => [node.id, pointShape(node, display.nodeScale, display.labelSize)] as const)), [graph, display.nodeScale, display.labelSize]);

  useLayoutEffect(() => {
    engine.setDrawing({ relatedWidth: display.relatedWidth, arrows: display.arrows, textFade: display.textFade, showRelated: filter.relatedLines, showTagLines: filter.tagLines });
  }, [engine, display.relatedWidth, display.arrows, display.textFade, filter.relatedLines, filter.tagLines]);
  useLayoutEffect(() => engine.setReduced(reduced), [engine, reduced]);
  useLayoutEffect(() => engine.setPinOnDrop(force.pin), [engine, force.pin]);
  useLayoutEffect(() => {
    engine.setGraph(
      graph.nodes.map((node) => ({ id: node.id, ...shapes.get(node.id)! })),
      graph.edges,
    );
  }, [engine, graph, shapes]);
  useLayoutEffect(() => engine.setForces(forcesOf(settings)), [engine, force.center, force.repel, force.relatedStrength, force.relatedDistance, force.tagStrength, force.tagDistance]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => engine.resize(size.width, size.height), [engine, size]);
  useLayoutEffect(() => engine.setFocus(focus), [engine, focus]);
  useEffect(() => {
    if (focus && !graph.nodes.some((node) => node.id === focus)) setFocus(null);
  }, [focus, graph]);

  const activate = (id: string) => {
    const item = latest.current.find((entry) => `p:${entry.work.id}` === id);
    if (item) openProject(item.work);
    else setFocus((current) => (current === id ? null : id));
  };

  // A point's colour: the view's group, else the stage (or one colour, from the settings).
  const fillOf = (item: GraphItem) => (color.projectBy === "stage" ? (groupColor?.(item.work.id) ?? stageOf(stages, item.stage)?.color) : undefined);
  // Colours by name, so the points only redraw when a colour does.
  const stageColors = items.map((item) => fillOf(item) ?? "").join(",");
  const points = useMemo(() => {
    const byId = new Map<string, GraphItem>(latest.current.map((item) => [`p:${item.work.id}`, item]));
    return graph.nodes.map((node) => {
      const shape = shapes.get(node.id)!;
      const item = byId.get(node.id);
      const fill = item ? fillOf(item) : undefined;
      return (
        <g key={node.id} className={`graph-node ${node.kind}${node.archived ? " archived" : ""}`} data-node={node.id} tabIndex={0} role="button" aria-label={node.label}>
          <title>{node.label}</title>
          {/* A wider, invisible target: small points are easy to grab, and a label never moves it. */}
          <circle className="graph-hit" r={Math.round((shape.r + 8) * 10) / 10} />
          <circle className="graph-dot" r={Math.round(shape.r * 10) / 10} style={fill ? { fill } : undefined} />
          <text y={Math.round((shape.r + display.labelSize + 2) * 10) / 10}>{shortLabel(node.label)}</text>
        </g>
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, shapes, stageColors, color.projectBy, display.labelSize]);

  // A click on a point (not the end of a drag) opens the project or lights the tag.
  const onClick = (event: ReactMouseEvent<SVGSVGElement>) => {
    const id = (event.target as Element).closest?.("g[data-node]")?.getAttribute("data-node");
    if (engine.takeClick() || !id) return;
    activate(id);
  };
  const onKeyDown = (event: ReactKeyboardEvent<SVGSVGElement>) => {
    const id = (event.target as Element).closest?.("g[data-node]")?.getAttribute("data-node");
    if (!id || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    activate(id);
  };

  const projects = graph.nodes.filter((node) => node.kind === "project").length;
  const lines = graph.edges.filter((edge) => (edge.kind === "related" ? filter.relatedLines : filter.tagLines)).length;
  const anyLines = useMemo(() => buildGraph(input, filter.tags).edges.length > 0, [input, filter.tags]);
  const focusLabel = focus ? graph.nodes.find((node) => node.id === focus)?.label : null;
  const vars = {
    "--graph-label-size": `${display.labelSize}px`,
    "--graph-related-width": String(display.relatedWidth),
    "--graph-tag-width": String(display.tagWidth),
    ...(color.projectBy === "one" && color.project ? { "--graph-project": color.project } : {}),
    ...(color.tag ? { "--graph-tag": color.tag } : {}),
    ...(color.related ? { "--graph-related": color.related } : {}),
    ...(color.tagLine ? { "--graph-tag-line": color.tagLine } : {}),
    ...(color.highlight ? { "--graph-highlight": color.highlight } : {}),
  } as CSSProperties;

  const closePanel = () => {
    setPanel(false);
    requestAnimationFrame(() => gear.current?.focus());
  };

  return (
    <div className="projects-graph">
      <div className="graph-bar">
        <span className="graph-count">
          프로젝트 {projects} · 선 {lines}
          {!anyLines ? " — 프로젝트에 '관련'이나 태그를 달면 선이 생깁니다" : ""}
        </span>
        {focusLabel ? (
          <button type="button" className="link small" onClick={() => setFocus(null)}>
            {focusLabel} 강조 풀기
          </button>
        ) : null}
        {pinned ? (
          <button type="button" className="link small" onClick={() => engine.unpinAll()}>
            고정 {pinned}개 풀기
          </button>
        ) : null}
        <span className="graph-bar-gap" />
        <button type="button" className="link small" onClick={() => engine.fit()}>
          화면에 맞추기
        </button>
        <button type="button" className="link small" onClick={() => engine.resetZoom()}>
          처음 크기로
        </button>
      </div>
      <div className="graph-stage" ref={frame} style={{ ...vars, height: size.height }}>
        <svg ref={svg} className="graph-canvas" width={size.width} height={size.height} role="group" aria-label="프로젝트 그래프" onClick={onClick} onKeyDown={onKeyDown}>
          <g ref={world} className="graph-world">
            {(["tag", "related", "arrows", "tag lit", "related lit", "arrows lit"] as const).map((name, at) => (
              <path key={name} ref={(element) => void (paths.current[at] = element)} className={name.startsWith("arrows") ? `graph-arrows${name.endsWith("lit") ? " lit" : ""}` : `graph-edges ${name}`} />
            ))}
            {points}
          </g>
        </svg>
        {!graph.nodes.length && !loading ? <div className="graph-empty">{items.length ? "필터에 맞는 프로젝트가 없습니다." : "프로젝트가 없습니다."}</div> : null}
        {panel ? (
          <GraphSettingsPanel settings={settings} onChange={change} pinned={pinned} onUnpinAll={() => engine.unpinAll()} onClose={closePanel} />
        ) : (
          <button ref={gear} type="button" className="icon-button graph-gear" aria-label="그래프 설정" title="그래프 설정" aria-expanded={false} onClick={() => setPanel(true)}>
            <Icon name="settings" size={17} />
          </button>
        )}
      </div>
    </div>
  );
}
