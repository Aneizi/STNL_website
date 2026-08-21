// Shared style atoms ported verbatim from the design. Screens compose these
// and add screen-specific inline styles; when in doubt the design's exact
// inline style wins over reuse.
//
// Stateful shared pieces (useSavedFlash, useConfirmDelete, CopyButton) live
// in ui-client.tsx: server components import this file's plain atoms, and a
// module reachable from a Server Component may not import React hooks.
import type { CSSProperties } from "react";

/* ── Auth card (login / change password) ─────────────────────────── */

export const authCard: CSSProperties = {
  width: 360,
  maxWidth: "100%",
  background: "var(--card)",
  borderRadius: 0,
  boxShadow: "var(--shadow-2)",
  padding: "28px 26px",
  boxSizing: "border-box",
};

export const authLabel: CSSProperties = {
  fontSize: 12,
  color: "var(--label-3)",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

export const authField: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  border: "1px solid var(--sep)",
  borderRadius: 0,
  background: "transparent",
  color: "var(--label-1)",
  fontSize: 15,
};

export const authSubmit: CSSProperties = {
  width: "100%",
  marginTop: 16,
  padding: 11,
  border: "none",
  borderRadius: 0,
  background: "var(--label-1)",
  color: "var(--bg)",
  fontSize: 15,
  fontWeight: 600,
  cursor: "pointer",
};

/* ── Page scaffolding ────────────────────────────────────────────── */

export const card: CSSProperties = {
  background: "var(--card)",
  borderRadius: 0,
  boxShadow: "var(--shadow-1)",
  padding: "16px 18px",
};

export const pageTitle: CSSProperties = {
  fontFamily: "var(--serif)",
  fontSize: 38,
  fontWeight: 400,
  letterSpacing: "-0.01em",
  margin: 0,
};

export const cardTitle: CSSProperties = {
  fontFamily: "var(--serif)",
  fontSize: 21,
  fontWeight: 400,
};

export const columnHeader: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--label-3)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

/* ── Form controls (the design's default input/select/button) ────── */

export const input: CSSProperties = {
  boxSizing: "border-box",
  height: 36,
  padding: "8px 10px",
  border: "1px solid var(--sep)",
  borderRadius: 0,
  background: "transparent",
  color: "var(--label-1)",
  fontSize: 14,
};

export const smallInput: CSSProperties = {
  padding: "7px 10px",
  border: "1px solid var(--sep)",
  borderRadius: 0,
  background: "transparent",
  color: "var(--label-1)",
  fontSize: 13,
};

export const smallSelect: CSSProperties = {
  padding: "6px 10px",
  border: "1px solid var(--sep)",
  borderRadius: 0,
  background: "transparent",
  color: "var(--label-1)",
  fontSize: 13,
};

/** Inline-edit inputs sit on the tinted row, so they get a card background. */
export const editInput: CSSProperties = {
  boxSizing: "border-box",
  padding: "7px 9px",
  border: "1px solid var(--sep)",
  borderRadius: 0,
  background: "var(--card)",
  color: "var(--label-1)",
  fontSize: 13,
  minWidth: 0,
};

export const primaryBtn: CSSProperties = {
  border: "none",
  cursor: "pointer",
  padding: "7px 14px",
  borderRadius: 0,
  fontSize: 14,
  fontWeight: 600,
  background: "var(--label-1)",
  color: "var(--bg)",
};

export const accentBtn: CSSProperties = {
  border: "none",
  cursor: "pointer",
  padding: "7px 12px",
  borderRadius: 0,
  fontSize: 13,
  fontWeight: 600,
  background: "var(--fill-2)",
  color: "var(--accent)",
};

/** Label-above-input column used by every inline create form. */
export function FormField({
  label,
  hint,
  flex,
  minWidth,
  width,
  children,
}: {
  label: string;
  /** Explains what the field controls, on a marker beside the label. */
  hint?: string;
  flex?: number;
  minWidth?: number;
  width?: number;
  children: React.ReactNode;
}) {
  return (
    <label
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        fontSize: 12,
        color: "var(--label-2)",
        flex,
        minWidth,
        width,
      }}
    >
      {hint ? (
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          {label}
          <span
            title={hint}
            style={{
              flex: "none",
              width: 13,
              height: 13,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "help",
              boxShadow: "0 0 0 1px var(--sep)",
              color: "var(--label-3)",
              fontSize: 9,
              fontWeight: 600,
              lineHeight: 1,
            }}
          >
            ?
          </span>
        </span>
      ) : (
        label
      )}
      {children}
    </label>
  );
}

/** Status/role badge chip, colors given as design-token keys. */
export function Badge({ label, color, bg }: { label: string; color: string; bg: string }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        padding: "3px 8px",
        borderRadius: 2,
        color: `var(--${color})`,
        background: `var(--${bg})`,
      }}
    >
      {label}
    </span>
  );
}

/**
 * Marks an event as mirrored from the Luma calendar, and links out to it.
 * Its absence is the signal for an event added by hand in HQ.
 *
 * Deliberately unadorned — no chip, border or fill. It sits directly beside
 * the event name, so anything with edges competed with the name rather than
 * annotating it. Muted by default, accented on hover via the shared class.
 */
export function LumaMark({ href }: { href: string }) {
  return (
    <a
      className="hq-hover-accent"
      href={href}
      target="_blank"
      rel="noreferrer"
      title="View on Luma"
      aria-label="View on Luma"
      style={{
        flex: "none",
        display: "inline-flex",
        alignItems: "center",
        verticalAlign: "middle",
        color: "var(--label-3)",
        textDecoration: "none",
      }}
    >
      {/* Luma wordmark. 22×8 keeps the artwork's 724:264 ratio; block display
          drops the inline baseline gap that would offset it from the name. */}
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 724 264"
        width={22}
        height={8}
        aria-hidden="true"
        style={{ display: "block" }}
      >
        <path
          fill="currentColor"
          d="M38.53 260.65H.43V27.86h38.1zm86.46 2.77c-42.25 0-66.48-22.96-66.48-63V89.33h38.1v108.28c0 23.61 8.7 32.39 32.12 32.39 30.35 0 42.73-14.54 42.73-50.17v-90.5h38.1v171.33h-36.54v-29.91c-4.99 22.98-27.12 32.67-48.03 32.67zm347.2-2.77H434.4V149.87c0-22.5-7.01-30.87-25.88-30.87-24.28 0-37.11 14.45-37.11 41.79v99.86h-37.79V149.87c0-21.93-7.23-30.87-24.94-30.87-31.59 0-38.05 32.96-38.05 41.79v99.86h-38.1V89.33h36.54v29.96c6.49-21.02 27.02-33.71 47.72-33.71 20.69 0 38.09 7.9 45.64 33.71 10.13-26.76 28.35-33.71 50.15-33.71 37.88 0 59.61 18.88 59.61 51.81v123.26h0zm76.65 2.77c-52.62 0-61.55-33.45-61.55-50.52 0-20.1 8.83-38.21 27.93-45.55 8.41-3.11 16.52-5.43 24.84-7.1 7.33-1.47 18.64-3.03 26.91-4.17l2.73-.38c14.38-2 29.67-9.21 29.67-18.62 0-16-20.51-18.39-32.74-18.39-13.87 0-23.64 3.57-27.53 10.05-3.49 6.46-3.73 7.97-4.62 13.6l-.62 4.43h-38.1l.68-5.61c1.35-11.14 3.41-19.03 6.48-24.83 10.54-20.39 31.77-30.75 63.08-30.75 26.11 0 44.63 8.23 53.26 15.94 5.31 4.6 9.1 9.84 11.89 16.46 5.84 12.36 6.32 20.63 6.32 29.4v86.43c0 8.07.78 14.97 2.31 20.5l1.76 6.35h-38.91l-.7-4.19c-.5-2.96-.67-19.75-.88-26.23-8.99 23.61-28.27 33.18-52.21 33.18zm50.53-93.72c-7.97 6.11-20.47 9.6-38.62 13.23-31.27 5.78-36.54 13.06-36.54 27.22 0 12.5 10.63 20.26 27.75 20.26 33.23 0 47.41-15.48 47.41-51.77v-8.94zm124.2-105.51C688.46 64.19 660 35.73 660 .62c0 35.11-28.46 63.57-63.57 63.57h0c35.11 0 63.57 28.46 63.57 63.57h0c0-35.11 28.46-63.57 63.57-63.57z"
        />
      </svg>
    </a>
  );
}

/** Thin progress bar (funnel cards, gates column, partner target). */
export function ProgressBar({ pct }: { pct: number }) {
  return (
    <div
      style={{
        height: 4,
        borderRadius: 0,
        background: "var(--fill-3)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          height: "100%",
          borderRadius: 0,
          background: "var(--accent)",
          width: `${Math.min(100, pct)}%`,
        }}
      />
    </div>
  );
}
