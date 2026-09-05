"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { IconChevronDown } from "symbols-react";
import { showToast } from "@/components/hq/toast";
import { switchHackathon } from "@/lib/hq/actions/hackathons";
import { fmtDateRange } from "@/lib/hq/hackathon-format";
import type { Hackathon } from "@/lib/hq/types";

/**
 * The chrome's hackathon menu: the edition being shown, opening to the list
 * of every edition. Picking one switches in place — the same page, now
 * scoped to the other hackathon — except a partner detail page, whose
 * partner belongs to the edition just left; that goes back to the board.
 */
export function HackathonSwitcher({
  hackathons,
  selectedId,
}: {
  hackathons: Hackathon[];
  selectedId: number | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const current = hackathons.find((h) => h.id === selectedId) ?? null;

  useEffect(() => {
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const pick = (id: number) => {
    setOpen(false);
    if (id === selectedId) return;
    startTransition(async () => {
      const res = await switchHackathon(id);
      if (!res.ok) {
        showToast(res.error ?? "Could not switch hackathon");
        return;
      }
      if (/^\/hq\/partners\/.+/.test(pathname)) router.push("/hq/partners");
      else router.refresh();
    });
  };

  return (
    <div style={{ position: "relative", minWidth: 0 }}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        title="Switch hackathon"
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          maxWidth: 240,
          border: "none",
          background: "none",
          cursor: "pointer",
          padding: "4px 0",
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.14em",
          color: pending ? "var(--faded)" : "var(--label-3)",
          position: "relative",
          top: 1,
          transition: "color 0.2s",
        }}
      >
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
        >
          {current?.name ?? "Choose a hackathon"}
        </span>
        {current?.archived ? (
          <span
            style={{
              flex: "none",
              fontSize: 9,
              letterSpacing: "0.1em",
              padding: "2px 5px",
              boxShadow: "0 0 0 1px var(--sep)",
              color: "var(--label-3)",
            }}
          >
            Archived
          </span>
        ) : null}
        <IconChevronDown
          aria-hidden="true"
          fill="currentColor"
          style={{
            flex: "none",
            display: "block",
            width: 8,
            height: 5,
            transform: open ? "rotate(180deg)" : "none",
            transition: "transform 160ms ease",
          }}
        />
      </button>
      {open ? (
        <div
          role="menu"
          className="hq-pop-in"
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            top: 32,
            left: 0,
            zIndex: 110,
            background: "var(--card)",
            boxShadow: "var(--shadow-pop)",
            minWidth: 268,
            padding: 6,
            transformOrigin: "top left",
          }}
        >
          {hackathons
            .filter((h) => !h.archived)
            .map((h) => (
              <MenuEntry key={h.id} hackathon={h} active={h.id === selectedId} onPick={pick} />
            ))}
          {hackathons.some((h) => h.archived) ? (
            <>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.12em",
                  textTransform: "uppercase",
                  color: "var(--faded)",
                  padding: "8px 10px 2px",
                  borderTop: "1px solid var(--sep)",
                  marginTop: 4,
                }}
              >
                Archived
              </div>
              {hackathons
                .filter((h) => h.archived)
                .map((h) => (
                  <MenuEntry key={h.id} hackathon={h} active={h.id === selectedId} onPick={pick} />
                ))}
            </>
          ) : null}
          <div style={{ borderTop: "1px solid var(--sep)", marginTop: 4, paddingTop: 4 }}>
            <Link
              href="/hq/select"
              role="menuitem"
              className="hq-hover-fill"
              onClick={() => setOpen(false)}
              style={{
                display: "block",
                padding: "8px 10px",
                fontSize: 12,
                fontWeight: 600,
                color: "var(--label-2)",
                textDecoration: "none",
              }}
            >
              All hackathons
            </Link>
            <Link
              href="/hq/admin"
              role="menuitem"
              className="hq-hover-fill"
              onClick={() => setOpen(false)}
              style={{
                display: "block",
                padding: "8px 10px",
                fontSize: 12,
                fontWeight: 600,
                color: "var(--label-2)",
                textDecoration: "none",
              }}
            >
              Manage hackathons
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MenuEntry({
  hackathon,
  active,
  onPick,
}: {
  hackathon: Hackathon;
  active: boolean;
  onPick: (id: number) => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      className="hq-hover-fill"
      onClick={() => onPick(hackathon.id)}
      style={{
        display: "block",
        width: "100%",
        boxSizing: "border-box",
        border: "none",
        cursor: "pointer",
        background: "none",
        textAlign: "left",
        padding: "8px 10px",
        opacity: hackathon.archived ? 0.7 : 1,
      }}
    >
      <div
        style={{
          fontSize: 13,
          fontWeight: 600,
          color: active ? "var(--accent)" : "var(--label-1)",
        }}
      >
        {hackathon.name}
      </div>
      <div style={{ fontSize: 11, color: "var(--label-3)", marginTop: 1 }}>
        {fmtDateRange(hackathon.startDate, hackathon.endDate)}
        <span style={{ color: "var(--faded)" }}> · #{hackathon.id}</span>
      </div>
    </button>
  );
}
