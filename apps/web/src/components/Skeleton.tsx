import "../styles/skeleton.css";

// Placeholder shapes while a view loads (smoothui "skeleton-loader" by Eduardo Calvo, MIT —
// third_party/ui-components/NOTICE): blocks in the shape of what is coming, breathing slowly (still
// with reduced motion). The words of the wait stay under them for screen readers and for the eye.

type Shape = "work" | "document";

export function LoadingView({ label, shape }: { label: string; shape: Shape }) {
  return (
    <main className="loading loading-skeleton" aria-busy="true" aria-live="polite">
      <div className={`skeleton-sheet skeleton-${shape}`} data-gallery="smoothui:skeleton-loader" data-component="skeleton" aria-hidden>
        {shape === "work" ? (
          <>
            <span className="skeleton-block skeleton-slip" />
            <span className="skeleton-block skeleton-line" />
            <span className="skeleton-block skeleton-line" />
            <span className="skeleton-block skeleton-line short" />
          </>
        ) : (
          <>
            <span className="skeleton-block skeleton-title" />
            <span className="skeleton-block skeleton-line" />
            <span className="skeleton-block skeleton-line" />
            <span className="skeleton-block skeleton-line" />
            <span className="skeleton-block skeleton-line short" />
          </>
        )}
      </div>
      <p className="loading-label">{label}</p>
    </main>
  );
}
