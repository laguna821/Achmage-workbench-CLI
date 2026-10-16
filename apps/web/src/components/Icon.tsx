// Small inline icon set (stroke icons, 1.75px), so the UI ships no icon font.

const PATHS = {
  chevronDown: "M6 9l6 6 6-6",
  chevronUp: "M6 15l6-6 6 6",
  chevronRight: "M9 6l6 6-6 6",
  arrowLeft: "M19 12H5M11 18l-6-6 6-6",
  arrowRight: "M5 12h14M13 6l6 6-6 6",
  send: "M4 12l16-8-6 16-2.5-6.5L4 12z",
  plus: "M12 5v14M5 12h14",
  check: "M5 12.5l4.5 4.5L19 7.5",
  x: "M6 6l12 12M18 6L6 18",
  folder: "M3.5 7.5a2 2 0 012-2h4l2 2.5h7a2 2 0 012 2v7.5a2 2 0 01-2 2h-13a2 2 0 01-2-2z",
  file: "M7 3.5h7l4.5 4.5v12a1 1 0 01-1 1h-10.5a1 1 0 01-1-1v-15.5a1 1 0 011-1zM13.5 3.5v5h5",
  search: "M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4",
  terminal: "M4.5 6.5l5 5.5-5 5.5M12 18h7.5",
  edit: "M4 20h4L19 9a2.8 2.8 0 00-4-4L4 16v4z",
  globe: "M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3c2.5 2.7 3.5 5.7 3.5 9s-1 6.3-3.5 9c-2.5-2.7-3.5-5.7-3.5-9s1-6.3 3.5-9z",
  tool: "M14.5 6.5a4 4 0 00-5.4 5L3.5 17v3.5H7l5.5-5.6a4 4 0 005.2-5.3l-2.6 2.6-2.4-.6-.6-2.4z",
} as const;

export type IconName = keyof typeof PATHS | "dots" | "stop";

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  if (name === "dots") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
        <circle cx="5" cy="12" r="1.6" fill="currentColor" />
        <circle cx="12" cy="12" r="1.6" fill="currentColor" />
        <circle cx="19" cy="12" r="1.6" fill="currentColor" />
      </svg>
    );
  }
  if (name === "stop") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
        <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
