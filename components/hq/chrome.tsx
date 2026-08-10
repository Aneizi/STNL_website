"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { logout } from "@/lib/hq/actions/auth";
import { ActivityDrawer } from "./activity-drawer";
import { SearchModal } from "./search-modal";

// Admin is not a tab — it lives in the account menu, above Sign out.
const TABS: Array<{ href: string; label: string }> = [
  { href: "/hq", label: "Dashboard" },
  { href: "/hq/projects", label: "Projects" },
  { href: "/hq/partners", label: "Partners" },
  { href: "/hq/people", label: "People" },
  { href: "/hq/events", label: "Events" },
  { href: "/hq/demo", label: "Demo day" },
];

export function HqChrome({ displayName }: { displayName: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [searchOpen, setSearchOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

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
      }
    };
    const onClick = () => setMenuOpen(false);
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

  const isActive = (href: string) =>
    href === "/hq" ? pathname === "/hq" : pathname.startsWith(href);

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
        <div
          style={{
            maxWidth: 1280,
            margin: "0 auto",
            padding: "0 20px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 14,
            height: 52,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              whiteSpace: "nowrap",
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
            <span
              style={{
                fontSize: 11,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.14em",
                color: "var(--label-3)",
                position: "relative",
                top: 1,
              }}
            >
              Campaign HQ
            </span>
          </div>
          <nav style={{ display: "flex", gap: 8, alignItems: "center", overflowX: "auto" }}>
            {TABS.map((tab, i) => (
              <span
                key={tab.href}
                style={{ display: "contents" }}
              >
                {i > 0 ? (
                  <span style={{ color: "var(--faded)", fontSize: 12, flex: "none" }}>/</span>
                ) : null}
                <Link
                  href={tab.href}
                  style={{
                    padding: "8px 5px",
                    fontSize: 12,
                    textTransform: "uppercase",
                    letterSpacing: "0.14em",
                    whiteSpace: "nowrap",
                    color: isActive(tab.href) ? "var(--accent)" : "var(--label-1)",
                    fontWeight: 600,
                    boxShadow: isActive(tab.href) ? "inset 0 -2px 0 var(--accent)" : "none",
                    transition: "color 0.2s",
                    textDecoration: "none",
                  }}
                >
                  {tab.label}
                </Link>
              </span>
            ))}
          </nav>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <button
              onClick={() => setSearchOpen(true)}
              title="Search (Cmd-K)"
              style={{
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
                fontSize: 12,
              }}
            >
              &#8984;K
            </button>
            <button
              onClick={() => setActivityOpen((open) => !open)}
              style={{
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
                fontSize: 12,
              }}
            >
              Activity
            </button>
            <div style={{ position: "relative" }}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen((open) => !open);
                }}
                title={displayName}
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
                  fontSize: 13,
                }}
              >
                {displayName.charAt(0) || "?"}
              </button>
              {menuOpen ? (
                <div
                  className="hq-pop-in"
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
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{displayName}</div>
                    <div style={{ fontSize: 11, color: "var(--label-3)", marginTop: 1 }}>
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
                      fontSize: 13,
                      fontWeight: 600,
                      textAlign: "left",
                      padding: "9px 10px",
                      textDecoration: "none",
                    }}
                  >
                    Admin
                  </Link>
                  <button
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
                      fontSize: 13,
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
