import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectStage, ProjectSummary, PropertyField } from "@workbench/contracts";
import type { Api } from "../../api.ts";
import type { State } from "../../state.ts";

// What every project's note says (stage, tags, properties), the stages and the properties
// template: home's views group and filter by them. Read again when a note or the stages change;
// the last answer is kept for this window, so switching modes draws at once.

export type ProjectData = {
  summaries: Map<string, ProjectSummary>;
  stages: ProjectStage[];
  template: PropertyField[];
  /** The first answer came (or failed). */
  loaded: boolean;
  reload: () => void;
};

let last: { summaries: Map<string, ProjectSummary>; stages: ProjectStage[]; template: PropertyField[] } | null = null;

export function useProjectData(api: Api, state: State, enabled = true): ProjectData {
  const [data, setData] = useState(() => last ?? { summaries: new Map<string, ProjectSummary>(), stages: [] as ProjectStage[], template: [] as PropertyField[] });
  const [loaded, setLoaded] = useState(() => Boolean(last));
  const version = useMemo(
    () =>
      Object.entries(state.pkm)
        .filter(([key]) => key.startsWith("project:"))
        .map(([key, value]) => `${key}=${value}`)
        .join(","),
    [state.pkm],
  );
  const works = useMemo(
    () =>
      Object.values(state.works)
        .map((work) => `${work.id}:${work.archivedAt ?? 0}`)
        .join(","),
    [state.works],
  );
  const reload = useCallback(() => {
    void Promise.all([api.projects(), api.projectStages(), api.propertyTemplate().catch(() => [] as PropertyField[])])
      .then(([list, stages, template]) => {
        last = { summaries: new Map(list.map((entry) => [entry.workId, entry])), stages, template };
        setData(last);
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, [api]);
  useEffect(() => {
    if (enabled) reload();
  }, [enabled, reload, version, works]);
  return { ...data, loaded, reload };
}
