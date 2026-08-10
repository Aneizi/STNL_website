import { ProgressBar, card, cardTitle, pageTitle } from "@/components/hq/ui";
import { daysUntilLabel, fmtDate, isStale } from "@/lib/hq/format";
import type { Classifiers, Milestone, Project, Settings } from "@/lib/hq/types";

export function Dashboard({
  settings,
  projects,
  milestones,
  classifiers,
  now,
  todayIso,
  todayText,
}: {
  settings: Settings;
  projects: Project[];
  milestones: Milestone[];
  classifiers: Classifiers;
  now: number;
  todayIso: string;
  todayText: string;
}) {
  const total = projects.length || 1;
  const forecasts = classifiers.forecasts.map((f) => ({
    slug: f.slug,
    label: f.label,
    color: `var(--${f.color})`,
    count: projects.filter((p) => p.forecastSlug === f.slug).length,
  }));
  const committed = forecasts.find((f) => f.slug === "committed")?.count ?? 0;
  const verified = projects.filter(
    (p) => p.gates.length === classifiers.gates.length
  ).length;

  const funnel = [
    {
      label: "Prospects reached",
      cur: settings.prospectsReached,
      target: settings.prospectsTarget,
      sub: settings.prospectsSub,
    },
    {
      label: "Committed projects",
      cur: settings.committedManual,
      target: settings.committedTarget,
      sub: `${committed} of ${projects.length} tracked here are committed`,
    },
    {
      label: "Active at kickoff",
      cur: settings.activeAtKickoff,
      target: settings.activeTarget,
      sub: settings.activeSub,
    },
    {
      label: "Verified submissions",
      cur: verified,
      target: settings.verifiedTarget,
      sub: "All nine gates checked",
    },
  ].map((f) => ({
    ...f,
    pct: Math.min(100, Math.round((f.cur / (f.target || 1)) * 100)),
  }));

  const warnings: Array<{ tag: string; text: string }> = [];
  if (settings.committedManual < settings.committedGlide) {
    warnings.push({
      tag: "Monday review",
      text: `Committed projects at ${settings.committedManual} of ${settings.committedTarget} target. Pace needs ${Math.max(0, settings.committedGlide - settings.committedManual)} more by kickoff to stay on the glide path.`,
    });
  }
  const stale = projects.filter((p) => isStale(p.lastCheckIn, settings.staleDays, now));
  if (stale.length) {
    warnings.push({
      tag: "Check-ins",
      text: `${stale.length} project${stale.length > 1 ? "s have" : " has"} no check-in for over a week: ${stale.map((p) => p.name).join(", ")}.`,
    });
  }

  const weekItems = [
    ...projects
      .filter((p) => p.statusSlug === "red")
      .map((p) => ({
        id: p.id,
        color: "var(--red)",
        text: `${p.name}: ${p.blocker || "red status, no blocker noted"}`,
        meta: `last check-in ${fmtDate(p.lastCheckIn)}`,
      })),
    ...projects
      .filter((p) => p.statusSlug === "amber" && p.blocker)
      .map((p) => ({
        id: p.id,
        color: "var(--orange)",
        text: `${p.name}: ${p.blocker}`,
        meta: `last check-in ${fmtDate(p.lastCheckIn)}`,
      })),
  ];

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 8,
        }}
      >
        <h1 style={pageTitle}>Dashboard</h1>
        <span style={{ fontSize: 13, color: "var(--label-3)" }}>{todayText}</span>
      </div>
      {warnings.map((w) => (
        <div
          key={w.tag}
          style={{
            marginTop: 14,
            background: "var(--orange-fill)",
            borderRadius: 0,
            padding: "10px 14px",
            display: "flex",
            gap: 10,
            alignItems: "baseline",
          }}
        >
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: "var(--orange)",
              whiteSpace: "nowrap",
            }}
          >
            {w.tag}
          </span>
          <span style={{ fontSize: 13, color: "var(--label-1)" }}>{w.text}</span>
        </div>
      ))}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))",
          gap: 12,
          marginTop: 16,
        }}
      >
        {funnel.map((f) => (
          <div key={f.label} style={card}>
            <div style={{ fontSize: 13, color: "var(--label-2)" }}>{f.label}</div>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 6,
                marginTop: 6,
              }}
            >
              <span
                style={{
                  fontFamily: "var(--serif)",
                  fontSize: 34,
                  fontWeight: 400,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {f.cur}
              </span>
              <span
                style={{
                  fontSize: 14,
                  color: "var(--label-3)",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                / {f.target}
              </span>
            </div>
            <div style={{ marginTop: 10 }}>
              <ProgressBar pct={f.pct} />
            </div>
            <div style={{ fontSize: 12, color: "var(--label-3)", marginTop: 8 }}>
              {f.sub}
            </div>
          </div>
        ))}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))",
          gap: 12,
          marginTop: 12,
        }}
      >
        <div style={card}>
          <div style={cardTitle}>Forecast</div>
          <div style={{ fontSize: 13, color: "var(--label-2)", marginTop: 2 }}>
            Across the {projects.length} tracked projects
          </div>
          <div
            style={{
              display: "flex",
              height: 10,
              borderRadius: 0,
              overflow: "hidden",
              background: "var(--fill-3)",
              marginTop: 14,
            }}
          >
            {forecasts.map((f) => (
              <div
                key={f.slug}
                style={{ background: f.color, width: `${(f.count / total) * 100}%` }}
              />
            ))}
          </div>
          <div style={{ display: "flex", gap: 16, marginTop: 12, flexWrap: "wrap" }}>
            {forecasts.map((l) => (
              <div
                key={l.slug}
                style={{ display: "flex", alignItems: "center", gap: 6 }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 0,
                    background: l.color,
                  }}
                />
                <span style={{ fontSize: 13, color: "var(--label-2)" }}>{l.label}</span>
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {l.count}
                </span>
              </div>
            ))}
          </div>
        </div>
        <div style={card}>
          <div style={cardTitle}>Milestones</div>
          <div style={{ display: "flex", flexDirection: "column", marginTop: 8 }}>
            {milestones.map((m) => (
              <div
                key={m.id}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 10,
                  padding: "8px 0",
                  borderBottom: "1px solid var(--sep)",
                }}
              >
                <span
                  style={{
                    fontSize: 13,
                    color: "var(--label-3)",
                    fontVariantNumeric: "tabular-nums",
                    width: 56,
                    flex: "none",
                  }}
                >
                  {fmtDate(m.date)}
                </span>
                <span style={{ fontSize: 14, flex: 1 }}>{m.label}</span>
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: "var(--accent-deep)",
                    fontVariantNumeric: "tabular-nums",
                    whiteSpace: "nowrap",
                  }}
                >
                  {daysUntilLabel(m.date, todayIso)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div style={{ ...card, marginTop: 12 }}>
        <div style={cardTitle}>Needs attention</div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {weekItems.map((w) => (
            <div
              key={w.id}
              style={{
                display: "flex",
                gap: 10,
                alignItems: "baseline",
                padding: "9px 0",
                borderBottom: "1px solid var(--sep)",
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: w.color,
                  flex: "none",
                  position: "relative",
                  top: -1,
                }}
              />
              <span style={{ fontSize: 14, flex: 1 }}>{w.text}</span>
              <span
                style={{
                  fontSize: 12,
                  color: "var(--label-3)",
                  whiteSpace: "nowrap",
                }}
              >
                {w.meta}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
