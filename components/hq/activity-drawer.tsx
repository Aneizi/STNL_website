"use client";

import { useEffect, useState } from "react";
import { fetchActivity } from "@/lib/hq/actions/overlay";
import { fmtWhen } from "@/lib/hq/format";
import type { ActivityItem } from "@/lib/hq/types";
import { cardTitle } from "./ui";

export function ActivityDrawer({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [timezone, setTimezone] = useState("Europe/Amsterdam");

  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchActivity()
      .then((data) => {
        if (cancelled || !data) return;
        setItems(data.items);
        setTimezone(data.timezone);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 90 }}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="hq-slide-in"
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          width: 320,
          maxWidth: "85vw",
          background: "var(--card)",
          boxShadow: "var(--shadow-pop)",
          padding: 18,
          overflowY: "auto",
          boxSizing: "border-box",
        }}
      >
        <div style={cardTitle}>Activity</div>
        {failed ? (
          <div style={{ fontSize: 13, color: "var(--red)", marginTop: 10 }}>
            Couldn&apos;t load activity. Close and reopen to retry.
          </div>
        ) : items === null ? (
          <div style={{ fontSize: 13, color: "var(--label-3)", marginTop: 10 }}>Loading…</div>
        ) : items.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--label-3)", marginTop: 10 }}>
            Nothing logged yet.
          </div>
        ) : (
          items.map((item) => (
            <div
              key={item.id}
              style={{ padding: "10px 0", borderBottom: "1px solid var(--sep)" }}
            >
              <div style={{ fontSize: 12, color: "var(--label-3)" }}>
                {fmtWhen(item.createdAt, timezone)}, {item.user}
              </div>
              <div style={{ fontSize: 13, marginTop: 2 }}>{item.message}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
