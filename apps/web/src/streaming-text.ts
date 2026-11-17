import { useEffect, useRef, useState } from "react";

/**
 * A3 (perf G1): the text a streaming answer draws. While `live`, it follows `text` at most once every `every` ms
 * (the first change after a quiet moment at once, then the latest text at the end of each wait), so the
 * answer's Markdown is parsed ~10 times a second instead of once per token — O(n) instead of O(n²) over a long
 * answer. Not live (the answer ended, or a finished one): exactly `text`, at once.
 */
export function useStreamingText(text: string, live: boolean, every = 100): string {
  const [shown, setShown] = useState(text);
  const last = useRef(0);
  useEffect(() => {
    if (!live || shown === text) return;
    const wait = last.current + every - Date.now();
    const show = () => { last.current = Date.now(); setShown(text); };
    if (wait <= 0) { show(); return; }
    const timer = window.setTimeout(show, wait);
    return () => window.clearTimeout(timer);
  }, [text, live, every, shown]);
  return live ? shown : text;
}
