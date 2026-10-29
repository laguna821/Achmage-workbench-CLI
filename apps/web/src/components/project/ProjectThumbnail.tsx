import type { ProjectSummary } from "@workbench/contracts";
import { useEffect, useRef, useState } from "react";
import { thumbPath } from "../../pkm.ts";
import { Picture } from "../pkm/CardListView.tsx";

export function ProjectThumbnail({ summary, small = false }: { summary?: ProjectSummary; small?: boolean }) {
  const path = thumbPath(summary?.thumb ?? null, summary?.thumbUpdatedAt ?? summary?.noteUpdatedAt ?? 0);
  const box = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!path || !box.current || visible) return;
    if (typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "160px" });
    observer.observe(box.current);
    return () => observer.disconnect();
  }, [path, visible]);
  return path ? <span ref={box} className={`project-thumbnail${small ? " small" : ""}`} aria-hidden>{visible ? <Picture path={path} alt="" /> : null}</span> : null;
}
