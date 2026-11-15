import { fold } from "../../../third_party/textfold/fold.ts";

/**
 * A reply folded to its points (textfold's fold, no model call) when that saves a quarter of it;
 * short replies, and those that hardly fold, are shown whole (null).
 */
export function foldedReply(text: string) {
  const folded = fold(text, 3).text;
  return text.length > 240 && folded.length <= text.length * 0.75 ? folded : null;
}
