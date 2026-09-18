"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type CSSProperties } from "react";
import { logout } from "@/lib/hq/actions/auth";
import type { Hackathon } from "@/lib/hq/types";
import { ActivityDrawer } from "./activity-drawer";
import { HackathonSwitcher } from "./hackathon-switcher";
import { SearchModal } from "./search-modal";

// Admin is not a tab — it lives in the account menu, above Sign out.
// Demo day is not one either: it is used on one day of the campaign, so it
// is entered from the button below the Projects table instead.
const TABS: Array<{ href: string; label: string }> = [
  { href: "/hq", label: "Dashboard" },
  { href: "/hq/projects", label: "Projects" },
  { href: "/hq/partners", label: "Partners" },
  { href: "/hq/people", label: "People" },
  { href: "/hq/events", label: "Events" },
];

/**
 * The tab a route lights up, by href, or null for a route that is no tab
 * (Admin). Dashboard is the exact root. Demo day is entered from the
 * Projects table, so it keeps that tab lit.
 */
export function activeTab(pathname: string): string | null {
  if (pathname === "/hq") return "/hq";
  if (pathname.startsWith("/hq/demo")) return "/hq/projects";
  return TABS.find((tab) => tab.href !== "/hq" && pathname.startsWith(tab.href))?.href ?? null;
}

// The chrome's own buttons are 28px by design, the one place operator HQ
// goes under the 44px control height.
const chromeButton: CSSProperties = {
  border: "none",
  cursor: "pointer",
  height: 28,
  display: "inline-flex",
  alignItems: "center",
  padding: "0 10px",
  boxSizing: "border-box",
  background: "none",
  boxShadow: "0 0 0 1px var(--sep)",
  color: "var(--label-2)",
  fontSize: 14,
};

export function HqChrome({
  displayName,
  hackathons,
  selectedId,
}: {
  displayName: string;
  hackathons: Hackathon[];
  selectedId: number | null;
}) {
  const pathname = usePathname();
  const router = useRouter();
  // Both popovers live here so opening one closes the other, and Escape or
  // a click elsewhere closes whichever is open.
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((open) => !open);
      }
      if (e.key === "Escape") {
        setSearchOpen(false);
        setActivityOpen(false);
        setMenuOpen(false);
        setSwitcherOpen(false);
      }
    };
    const onClick = () => {
      setMenuOpen(false);
      setSwitcherOpen(false);
    };
    // Other operators' edits land when the tab becomes visible again.
    // Throttled so returning focus can't race an in-flight navigation.
    let lastRefresh = 0;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastRefresh < 15000) return;
      lastRefresh = now;
      router.refresh();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("click", onClick);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("click", onClick);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [router]);

  const active = activeTab(pathname);

  return (
    <>
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 50,
          background: "var(--chrome)",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          borderBottom: "1px solid var(--sep)",
        }}
      >
        <div className="hq-chrome-inner">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              whiteSpace: "nowrap",
              minWidth: 0,
            }}
          >
            <Image
              src="/landing/st-orange.png"
              alt=""
              width={2154}
              height={2116}
              sizes="26px"
              style={{ width: 26, height: "auto", display: "block" }}
            />
            {/* The hackathon being shown stands where the product name used
                to: it is the one fact every page under this chrome depends on. */}
            <HackathonSwitcher
              hackathons={hackathons}
              selectedId={selectedId}
              open={switcherOpen}
              onOpenChange={(open) => {
                setSwitcherOpen(open);
                if (open) setMenuOpen(false);
              }}
            />
          </div>
          <nav className="hq-chrome-nav">
            {/* Separator and link render as one flex item so a wrapped nav
                line never starts with a dangling slash. Rest, active and
                hover colours come from hq.css: an inline colour would beat
                the hover rule. */}
            {TABS.map((tab, i) => (
              <span
                key={tab.href}
                style={{ display: "flex", alignItems: "center", gap: 8 }}
              >
                {i > 0 ? (
                  <span style={{ color: "var(--faded)", fontSize: 14, flex: "none" }}>/</span>
                ) : null}
                <Link
                  href={tab.href}
                  className={
                    tab.href === active ? "hq-chrome-tab hq-chrome-tab-active" : "hq-chrome-tab"
                  }
                  aria-current={tab.href === active ? "page" : undefined}
                  style={{
                    padding: "8px 5px",
                    fontSize: 14,
                    textTransform: "uppercase",
                    letterSpacing: "0.14em",
                    whiteSpace: "nowrap",
                    fontWeight: 600,
                    transition: "color 0.2s",
                  }}
                >
                  {tab.label}
                </Link>
              </span>
            ))}
          </nav>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              title="Search (Cmd-K)"
              style={chromeButton}
            >
              &#8984;K
            </button>
            <button
              type="button"
              onClick={() => setActivityOpen((open) => !open)}
              style={chromeButton}
            >
              Activity
            </button>
            <div style={{ position: "relative" }}>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen((open) => !open);
                  setSwitcherOpen(false);
                }}
                title={displayName}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                style={{
                  width: 28,
                  height: 28,
                  border: "none",
                  cursor: "pointer",
                  verticalAlign: "top",
                  background: "var(--accent-fill)",
                  color: "var(--accent)",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 600,
                  fontSize: 16,
                }}
              >
                {displayName.charAt(0) || "?"}
              </button>
              {menuOpen ? (
                <div
                  className="hq-pop-in"
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    position: "absolute",
                    top: 36,
                    right: 0,
                    zIndex: 110,
                    background: "var(--card)",
                    boxShadow: "var(--shadow-pop)",
                    minWidth: 160,
                    padding: 6,
                    transformOrigin: "top right",
                  }}
                >
                  <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--sep)" }}>
                    <div style={{ fontSize: 16, fontWeight: 600 }}>{displayName}</div>
                    <div style={{ fontSize: 13, color: "var(--label-3)", marginTop: 1 }}>
                      Operator
                    </div>
                  </div>
                  <Link
                    href="/hq/admin"
                    className="hq-hover-fill"
                    style={{
                      display: "block",
                      width: "100%",
                      boxSizing: "border-box",
                      cursor: "pointer",
                      background: "none",
                      color: "var(--label-1)",
                      fontSize: 16,
                      fontWeight: 600,
                      textAlign: "left",
                      padding: "9px 10px",
                      textDecoration: "none",
                    }}
                  >
                    Admin
                  </Link>
                  {/* A server action, not a link to the login page: signing
                      out has to destroy the session. */}
                  <button
                    type="button"
                    className="hq-hover-fill"
                    onClick={() => logout()}
                    style={{
                      display: "block",
                      width: "100%",
                      boxSizing: "border-box",
                      border: "none",
                      cursor: "pointer",
                      background: "none",
                      color: "var(--red)",
                      fontSize: 16,
                      fontWeight: 600,
                      textAlign: "left",
                      padding: "9px 10px",
                    }}
                  >
                    Sign out
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {searchOpen ? <SearchModal onClose={() => setSearchOpen(false)} /> : null}
      {activityOpen ? <ActivityDrawer onClose={() => setActivityOpen(false)} /> : null}
    </>
  );
}
