const ROWS = [0, 1, 2, 3, 4];

/**
 * The loading boundary for every authenticated HQ destination. The pages are
 * dynamic, and Next.js will not prefetch a dynamic route without one of these,
 * so its absence is what makes a navbar click hold the previous page until the
 * destination's Postgres reads finish. See README, "Responsive HQ navigation".
 */
export default function HqPageLoading() {
  return (
    <div
      className="hq-route-loading"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Loading page"
    >
      <span className="hq-sr-only">Loading page…</span>

      <div className="hq-loading-heading" aria-hidden="true">
        <span className="hq-skeleton hq-loading-title" />
        <span className="hq-skeleton hq-loading-action" />
      </div>

      <div className="hq-loading-panel" aria-hidden="true">
        <div className="hq-loading-tools">
          <span className="hq-skeleton hq-loading-filter" />
          <span className="hq-skeleton hq-loading-filter hq-loading-filter-short" />
        </div>
        <div className="hq-loading-list">
          {ROWS.map((row) => (
            <div className="hq-loading-row" key={row}>
              <span className="hq-skeleton" />
              <span className="hq-skeleton hq-loading-secondary" />
              <span className="hq-skeleton hq-loading-meta" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
