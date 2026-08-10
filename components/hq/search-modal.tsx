"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { SearchResult } from "@/lib/hq/types";

export function SearchModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [results, setResults] = useState<SearchResult[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  const onQuery = (q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!q.trim()) {
      abortRef.current?.abort();
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const res = await fetch(`/hq/api/search?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as { results: SearchResult[] };
        setResults(data.results);
      } catch {
        // Aborted or offline — keep whatever is shown.
      }
    }, 150);
  };

  const go = (result: SearchResult) => {
    onClose();
    // Mirrors the design's navigation side effects (filter resets etc.),
    // handled by each screen via these query params.
    switch (result.kind) {
      case "Project":
        router.push(`/hq/projects?expand=${result.id}`);
        break;
      case "Partner":
        router.push(`/hq/partners/${result.id}`);
        break;
      case "Person":
        router.push(`/hq/people?reset=1`);
        break;
      case "Event":
        router.push(`/hq/events?view=list`);
        break;
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgba(0,0,0,0.3)",
        display: "flex",
        justifyContent: "center",
        paddingTop: "12vh",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="hq-pop-in-modal"
        style={{
          width: 520,
          maxWidth: "calc(100% - 32px)",
          alignSelf: "flex-start",
          background: "var(--card)",
          borderRadius: 0,
          boxShadow: "var(--shadow-pop)",
          overflow: "hidden",
          transformOrigin: "top center",
        }}
      >
        <input
          autoFocus
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search projects, partners, people, events"
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "14px 18px",
            border: "none",
            background: "none",
            color: "var(--label-1)",
            fontSize: 16,
            borderBottom: "1px solid var(--sep)",
            outline: "none",
          }}
        />
        {results.length > 0 ? (
          <div style={{ maxHeight: 320, overflowY: "auto", padding: 6 }}>
            {results.map((result) => (
              <button
                key={`${result.kind}-${result.id}`}
                className="hq-hover-fill"
                onClick={() => go(result)}
                style={{
                  display: "flex",
                  width: "100%",
                  boxSizing: "border-box",
                  alignItems: "baseline",
                  gap: 10,
                  border: "none",
                  cursor: "pointer",
                  background: "none",
                  padding: "9px 12px",
                  borderRadius: 0,
                  textAlign: "left",
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: "var(--label-3)",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    width: 56,
                    flex: "none",
                  }}
                >
                  {result.kind}
                </span>
                <span style={{ fontSize: 14, color: "var(--label-1)" }}>{result.label}</span>
                <span style={{ fontSize: 12, color: "var(--label-3)" }}>{result.meta}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
