"use client";

// Safety net for rejected server actions (network drop, stale action id
// after a deploy). This Next version passes unstable_retry; reset is the
// legacy prop — accept either.
export default function HqError({
  reset,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  reset?: () => void;
  unstable_retry?: () => void;
}) {
  const retry = unstable_retry ?? reset ?? (() => window.location.reload());
  return (
    <div
      style={{
        background: "var(--card)",
        borderRadius: 0,
        boxShadow: "var(--shadow-1)",
        padding: "24px 22px",
        maxWidth: 420,
        margin: "48px auto",
        textAlign: "center",
      }}
    >
      <div style={{ fontFamily: "var(--serif)", fontSize: 24, fontWeight: 400 }}>
        Something went wrong
      </div>
      <div style={{ fontSize: 13, color: "var(--label-2)", marginTop: 8 }}>
        The last change may not have saved. Reload and check before retrying it.
      </div>
      <button
        onClick={retry}
        style={{
          marginTop: 16,
          border: "none",
          cursor: "pointer",
          padding: "9px 18px",
          borderRadius: 0,
          fontSize: 14,
          fontWeight: 600,
          background: "var(--label-1)",
          color: "var(--bg)",
        }}
      >
        Try again
      </button>
    </div>
  );
}
