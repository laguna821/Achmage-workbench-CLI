import type { Session } from "@workbench/contracts";
import type { ChildLine } from "../../companion.ts";
import { EngineMark } from "../EngineMark.tsx";
import { Icon } from "../Icon.tsx";
import { agentTitle } from "./AgentColumn.tsx";

/**
 * In the main conversation: what its documents' and pages' AIs are doing, one line each (who,
 * which document, its state). The main conversation is never held by them; a line opens that AI's
 * conversation beside its document or page.
 */
export function ChildWork({ lines, onOpen }: { lines: ChildLine[]; onOpen: (session: Session) => void }) {
  if (!lines.length) return null;
  return (
    <div className="child-work" role="group" aria-label="이 대화의 문서·웹 AI">
      {lines.map((line) => (
        <button key={line.session.id} type="button" className="child-work-line" title="이 AI의 대화를 문서 옆에 엽니다" onClick={() => onOpen(line.session)}>
          <span className={`dot dot-${line.tone}`} aria-hidden />
          <EngineMark provider={line.session.provider} size={14} />
          <span className="child-work-who">{agentTitle(line.kind, line.name)}</span>
          <span className="child-work-state">{line.state}</span>
          {line.last ? <span className="child-work-last" title={line.last}>{line.last}</span> : null}
          <Icon name="chevronRight" size={14} />
        </button>
      ))}
    </div>
  );
}
