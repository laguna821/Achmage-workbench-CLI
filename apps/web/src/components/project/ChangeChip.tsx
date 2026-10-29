import { useEffect, useState } from "react";
import type { ChangeLine, Session } from "@workbench/contracts";
import { Icon } from "../Icon.tsx";
import { useOptionalPkm } from "../pkm/PkmContext.tsx";
import "../../styles/project.css";

/**
 * "알릴 변경 N" above the input: what the next request will tell the engine changed in the project
 * since this session's last request (documents others edited, its proposals people applied or
 * dropped, the note's stage and decisions). All of it goes by default; a line can be left out.
 */
export function ChangeChip({ session, omit, onOmit, pulse }: { session: Session | null; omit: string[]; onOmit: (omit: string[]) => void; pulse: string }) {
  const pkm = useOptionalPkm();
  const [lines, setLines] = useState<ChangeLine[]>([]);
  const [open, setOpen] = useState(false);
  const idle = session?.status === "idle" || session?.status === "error";
  useEffect(() => {
    if (!pkm || !session || !idle) return setLines([]);
    let cancelled = false;
    pkm.api
      .changes(session.id)
      .then((next) => !cancelled && setLines(next))
      .catch(() => !cancelled && setLines([]));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, idle, pulse]);
  if (!lines.length) return null;
  const sent = lines.filter((line) => !omit.includes(line.id)).length;
  return (
    <div className="change-chip-area">
      <button type="button" className="change-chip" aria-expanded={open} onClick={() => setOpen(!open)} title="다음 요청과 함께 엔진에 알릴, 지난 요청 뒤에 바뀐 것">
        <Icon name="refresh" size={12} /> 알릴 변경 {sent}
        {sent !== lines.length ? <span className="muted"> / {lines.length}</span> : null}
        <Icon name={open ? "chevronUp" : "chevronDown"} size={11} />
      </button>
      {open ? (
        <ul className="change-list" aria-label="알릴 변경">
          {lines.map((line) => (
            <li key={line.id}>
              <label>
                <input type="checkbox" checked={!omit.includes(line.id)} onChange={(event) => onOmit(event.target.checked ? omit.filter((id) => id !== line.id) : [...omit, line.id])} />
                <span>{line.text}</span>
              </label>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
