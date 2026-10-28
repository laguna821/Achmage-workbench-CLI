import wordmark from "../brand/achmage-wordmark.json";

// The Achmage wordmark and its Arc / Rune symbol, from the user's own site (laguna821/slides,
// src/lib/brand-wordmark.json and src/lib/brand.ts @ cee81c0). The letters take the text colour of
// the current look (light or dark); the crossing arc keeps the brand teal.

const SYMBOL = {
  letter: "M49.8 6.5 16 73 33 67 50.8 30 67 65 84.5 72Z",
  arc: "M6.5 62.5C28 72 55.5 55.5 89 31L84.5 47C59 68 27 84 8 74Z",
  star: "M83 10 86 19 95 22 86 25 83 34 80 25 71 22 80 19Z",
};

export function Wordmark({ className, title = "Achmage" }: { className?: string; title?: string }) {
  return (
    <svg className={`wordmark ${className ?? ""}`} viewBox={wordmark.viewBox} role="img" aria-label={title}>
      <path className="wordmark-ink" d={wordmark.inkPath} fillRule="evenodd" />
      <path className="wordmark-ink wordmark-flow" d={wordmark.flowPath} fillRule="evenodd" />
      <path className="wordmark-arc" d={wordmark.arcPath} fillRule="evenodd" />
    </svg>
  );
}

/** The compact mark (A, star and arc) for narrow places. */
export function BrandSymbol({ className, size = 24 }: { className?: string; size?: number }) {
  return (
    <svg className={`brand-symbol ${className ?? ""}`} viewBox="0 0 100 100" width={size} height={size} role="img" aria-label="Achmage">
      <defs>
        <mask id="achmage-arc-cut" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">
          <path fill="white" d="M0 0H100V100H0Z" />
          <path d={SYMBOL.arc} fill="black" stroke="black" strokeWidth="3" />
        </mask>
      </defs>
      <path className="wordmark-ink" d={SYMBOL.letter} mask="url(#achmage-arc-cut)" />
      <path className="wordmark-ink" d={SYMBOL.star} />
      <path className="wordmark-arc" d={SYMBOL.arc} />
    </svg>
  );
}
