import { afterAll, afterEach, describe, it } from "vitest";
import { cleanAll, runShapeCell, shapeCells } from "./matrix-kit.ts";

// Fix round 5, ruling Q6: the matrix covers shapes, not only endings (Slack). The same forms as the
// Telegram file, as text and as a photo's caption (Slack has no forwarded message in a DM), while the
// step waits at the PC (the hold) and after it ended by 취소, a timeout or a restart. Caught: not to
// the AI, answered once with [그대로 보내기] (Slack cannot delete it). Made-up values only.

afterEach(cleanAll);
const cells = shapeCells("slack");
afterAll(() => {
  const na = cells.filter((cell) => typeof cell.expect === "object");
  console.log(`input-shape matrix (Slack): ${cells.length} cells, ${cells.length - na.length} run, ${na.length} not applicable: ${na[0] ? (na[0].expect as { na: string }).na : ""}`);
});

describe("ruling Q6 (Slack): the next message's shape during and after the hold", () => {
  for (const cell of cells) {
    if (typeof cell.expect === "object") continue;
    it(`${cell.kind} · ${cell.ending} · ${cell.carrier} · ${cell.form.name} → ${cell.expect}`, () => runShapeCell(cell));
  }
});
