import type { Provider } from "@workbench/contracts";

// Own simple marks (not the vendors' logos): a filled spark for Claude, an outlined
// hexagon with a prompt for Codex. Shape alone already tells them apart, color adds to it.

const SPARK = (() => {
  const points: string[] = [];
  const rays = 10;
  for (let index = 0; index < rays * 2; index += 1) {
    const angle = (Math.PI * index) / rays - Math.PI / 2;
    const radius = index % 2 === 0 ? 11 : 3.2;
    points.push(`${(12 + radius * Math.cos(angle)).toFixed(2)},${(12 + radius * Math.sin(angle)).toFixed(2)}`);
  }
  return `M${points.join("L")}Z`;
})();

export function EngineMark({ provider, size = 16, className }: { provider: Provider; size?: number; className?: string }) {
  if (provider === "claude") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" className={`engine-mark ${className ?? ""}`} aria-hidden>
        <path d={SPARK} fill="currentColor" strokeLinejoin="round" stroke="currentColor" strokeWidth={0.8} />
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
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`engine-mark ${className ?? ""}`}
      aria-hidden
    >
      <path d="M12 2.6l8.2 4.7v9.4L12 21.4l-8.2-4.7V7.3z" />
      <path d="M8.4 9.6l2.6 2.4-2.6 2.4M12.8 14.6h3" />
    </svg>
  );
}
