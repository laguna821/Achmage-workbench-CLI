// Small inline icon set (stroke icons, 1.75px), so the UI ships no icon font.

const PATHS = {
  chevronDown: "M6 9l6 6 6-6",
  chevronUp: "M6 15l6-6 6 6",
  chevronRight: "M9 6l6 6-6 6",
  // Fold or unfold a whole tree: two chevrons closing on a line, or opening away from it.
  collapseAll: "M8 4l4 4 4-4M8 20l4-4 4 4M4.5 12h15",
  expandAll: "M8 8l4-4 4 4M8 16l4 4 4-4M4.5 12h15",
  // Two panes: a page split down the middle ("오른쪽에 열기"), and the two trading places.
  columns: "M4.5 5h15a1 1 0 011 1v12a1 1 0 01-1 1h-15a1 1 0 01-1-1V6a1 1 0 011-1zM12 5v14M15 12h3M16.5 10.5v3",
  swap: "M19.5 8.5H5M8.5 5L5 8.5 8.5 12M4.5 15.5H19M15.5 12l3.5 3.5-3.5 3.5",
  arrowLeft: "M19 12H5M11 18l-6-6 6-6",
  arrowRight: "M5 12h14M13 6l6 6-6 6",
  send: "M4 12l16-8-6 16-2.5-6.5L4 12z",
  plus: "M12 5v14M5 12h14",
  check: "M5 12.5l4.5 4.5L19 7.5",
  shield: "M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6l7-3z",
  bolt: "M13 3L5 13.5h6L10 21l8-10.5h-6L13 3z",
  refresh: "M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6",
  home: "M4 10.5L12 4l8 6.5V20h-5.5v-5.5h-5V20H4z",
  unlock: "M6 11h12v10H6zM8.5 11V7.5a3.5 3.5 0 0 1 6.8-1.2",
  x: "M6 6l12 12M18 6L6 18",
  folder: "M3.5 7.5a2 2 0 012-2h4l2 2.5h7a2 2 0 012 2v7.5a2 2 0 01-2 2h-13a2 2 0 01-2-2z",
  file: "M7 3.5h7l4.5 4.5v12a1 1 0 01-1 1h-10.5a1 1 0 01-1-1v-15.5a1 1 0 011-1zM13.5 3.5v5h5",
  search: "M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4",
  terminal: "M4.5 6.5l5 5.5-5 5.5M12 18h7.5",
  edit: "M4 20h4L19 9a2.8 2.8 0 00-4-4L4 16v4z",
  globe: "M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3c2.5 2.7 3.5 5.7 3.5 9s-1 6.3-3.5 9c-2.5-2.7-3.5-5.7-3.5-9s1-6.3 3.5-9z",
  grid: "M4.5 4.5h6v6h-6zM13.5 4.5h6v6h-6zM4.5 13.5h6v6h-6zM13.5 13.5h6v6h-6z",
  sidebar: "M4 5.5h16a1 1 0 011 1v11a1 1 0 01-1 1H4a1 1 0 01-1-1v-11a1 1 0 011-1zM9 5.5v13",
  sun: "M12 16.5a4.5 4.5 0 100-9 4.5 4.5 0 000 9zM12 2.5v2M12 19.5v2M4.5 12h-2M21.5 12h-2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4",
  moon: "M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z",
  tool: "M14.5 6.5a4 4 0 00-5.4 5L3.5 17v3.5H7l5.5-5.6a4 4 0 005.2-5.3l-2.6 2.6-2.4-.6-.6-2.4z",
  chat: "M4.5 5.5h15a1 1 0 011 1v9a1 1 0 01-1 1h-8l-4.5 3.5v-3.5h-2.5a1 1 0 01-1-1v-9a1 1 0 011-1z",
  project: "M4 6.5A1.5 1.5 0 015.5 5h13A1.5 1.5 0 0120 6.5v11a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 014 17.5zM4 9.5h16",
  page: "M7 3.5h7l4.5 4.5v12a1 1 0 01-1 1h-10.5a1 1 0 01-1-1v-15.5a1 1 0 011-1zM13.5 3.5v5h5M9 13h6M9 16.5h6",
  mindmap: "M12 9.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zM14.3 11l4.2-3M14.3 13l4.2 3M9.7 11L5.5 8M9.7 13l-4.2 3",
  pin: "M9 3.5h6l-1 5.5 3.5 3v1.5h-11V12L10 9 9 3.5zM12 14v6.5",
  archive: "M3.5 5h17v4.5h-17zM5 9.5v9a1 1 0 001 1h12a1 1 0 001-1v-9M10 13.5h4",
  copy: "M9 9h10.5v11.5H9zM5.5 15V4h10.5",
  download: "M12 4v11M7 10.5l5 5 5-5M5 20h14",
  bell: "M6 16.5V11a6 6 0 0112 0v5.5l1.5 2h-15zM10 20.5a2 2 0 004 0",
  clock: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2",
  eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 15a3 3 0 100-6 3 3 0 000 6z",
  folderOpen: "M3.5 17.5v-10a2 2 0 012-2h4l2 2.5h6a2 2 0 012 2v1M3.5 17.5l2.6-6a1.5 1.5 0 011.4-1h12.6l-2.8 7a1.5 1.5 0 01-1.4 1h-11a1.4 1.4 0 01-1.4-1z",
  restore: "M4.5 12a7.5 7.5 0 107.5-7.5 7.8 7.8 0 00-5.5 2.3L4.5 9M4.5 4.5V9H9",
  palette: "M12 3.5a8.5 8.5 0 000 17c1.2 0 1.8-.9 1.4-1.9-.4-1 .2-2.1 1.3-2.1h2a3.8 3.8 0 003.8-4.5A8.5 8.5 0 0012 3.5zM8 12.5h.01M9.5 8h.01M14.5 8h.01",
  markdown: "M3.5 6.5h17v11h-17zM6.5 14.5v-5l2.5 3 2.5-3v5M15.5 9.5v5M13.5 12.5l2 2 2-2",
  image: "M4.5 5h15a1 1 0 011 1v12a1 1 0 01-1 1h-15a1 1 0 01-1-1V6a1 1 0 011-1zM8.75 11a1.75 1.75 0 100-3.5 1.75 1.75 0 000 3.5zM20.5 15l-5-5-11 9",
  link: "M4 8h15M15.5 4.5L19 8l-3.5 3.5M20 16H5M8.5 12.5L5 16l3.5 3.5",
  openNew: "M13.5 4.5h6v6M19.5 4.5l-8 8M17.5 13.5v5a1 1 0 01-1 1h-11a1 1 0 01-1-1v-11a1 1 0 011-1h5",
  // Folder icons of the vault mirror (Notebook Navigator's icon ids map to these).
  mail: "M4 6.5h16a1 1 0 011 1v9a1 1 0 01-1 1H4a1 1 0 01-1-1v-9a1 1 0 011-1zM3.5 7.5l8.5 6 8.5-6",
  info: "M12 21a9 9 0 100-18 9 9 0 000 18zM12 11v5.5M12 7.5v.5",
  // Callout kinds (Obsidian's set, drawn in the same stroke).
  alert: "M10.3 4.3L2.9 17.2A2 2 0 004.6 20.2h14.8a2 2 0 001.7-3L13.7 4.3a2 2 0 00-3.4 0zM12 9.5v4.5M12 17.2v.3",
  help: "M12 21a9 9 0 100-18 9 9 0 000 18zM9.6 9.4a2.5 2.5 0 014.8.9c0 1.7-2.4 2.2-2.4 3.7M12 17v.3",
  quote: "M5 7.5h5v5H7.2c0 2 .8 3.3 2.3 4M14 7.5h5v5h-2.8c0 2 .8 3.3 2.3 4",
  list: "M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.3M4.5 12h.3M4.5 17.5h.3",
  flame: "M12 21c-3.6 0-6-2.5-6-5.7 0-3 2.2-4.6 3.3-7.3.5 1.7 1.4 2.6 2.4 3 .2-3.2 1.8-5.6 3.8-7.5-.2 3.2 4.5 5.8 4.5 11.1 0 3.6-3.1 6.4-8 6.4z",
  bug: "M8.5 9.5a3.5 3.5 0 017 0V15a3.5 3.5 0 01-7 0zM12 10v8.5M4.5 13h4M15.5 13h4M5.5 8l3 2M18.5 8l-3 2M5.5 18.5l3-2M18.5 18.5l-3-2M9.5 6.2L8 4.5M14.5 6.2L16 4.5",
  clipboard: "M9 3.5h6v3H9zM9 5H6.5a1 1 0 00-1 1v13.5a1 1 0 001 1h11a1 1 0 001-1V6a1 1 0 00-1-1H15M9 12h6M9 15.5h4",
  book: "M12 6.5c-1.8-1.4-4.6-2-8-1.8v13c3.4-.2 6.2.4 8 1.8 1.8-1.4 4.6-2 8-1.8v-13c-3.4-.2-6.2.4-8 1.8zM12 6.5v13",
  star: "M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.6L12 16.7l-5.1 2.7 1-5.6-4.1-4 5.7-.8z",
  tag: "M3.5 12.2V4.5a1 1 0 011-1h7.7l8.3 8.3a1.5 1.5 0 010 2.1l-6.2 6.2a1.5 1.5 0 01-2.1 0zM8 8h.01",
  run: "M13.5 5.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM7 21l3.5-6.5L13 17v4M10.5 14.5L12 9l-3 1.5-1.5 3M12 9l2.5 2.5 3 .5",
  bulb: "M9 18h6M10 21h4M12 3a6 6 0 00-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0012 3z",
  external: "M14 4h6v6M20 4l-9 9M18 13.5V19a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5.5",
} as const;

export type IconName = keyof typeof PATHS | "dots" | "stop";

/** An icon name that came as data (the vault mirror's folder icons), or null when this set lacks it. */
export const iconName = (name: string | null | undefined): IconName | null => (name && (name in PATHS || name === "dots" || name === "stop") ? (name as IconName) : null);

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
