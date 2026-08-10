// Shared style atoms ported verbatim from the design. Screens compose these
// and add screen-specific inline styles; when in doubt the design's exact
// inline style wins over reuse.
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
