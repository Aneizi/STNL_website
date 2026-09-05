/**
 * Loading boundary for the picker, so a navbar link to it prefetches and
 * swaps immediately like every other HQ destination (see the (app) group's
 * loading.tsx). Two banner-shaped blocks, still, in the page's own layout.
 */
export default function SelectHackathonLoading() {
  return (
    <div
      className="hq-picker"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Loading hackathons"
    >
      <span className="hq-sr-only">Loading hackathons…</span>
      <div className="hq-picker-inner" aria-hidden="true">
        <span className="hq-skeleton" style={{ width: 28, height: 28, margin: "0 auto" }} />
        <span
          className="hq-skeleton hq-loading-title"
          style={{ width: 200, height: 36, margin: "18px auto 28px" }}
        />
        <span className="hq-skeleton hq-banner-skeleton" />
        <span className="hq-skeleton hq-banner-skeleton" />
      </div>
    </div>
  );
}
