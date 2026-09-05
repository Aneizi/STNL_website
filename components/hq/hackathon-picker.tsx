"use client";

import Image from "next/image";
import { useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { FormField, authLabel, input, primaryBtn } from "@/components/hq/ui";
import { logout } from "@/lib/hq/actions/auth";
import { chooseHackathon, createHackathon } from "@/lib/hq/actions/hackathons";
import { hackathonArt } from "@/lib/hq/hackathon-art";
import { fmtDateRange } from "@/lib/hq/hackathon-format";
import type { Hackathon } from "@/lib/hq/types";

/**
 * Where every sign-in lands: one banner per hackathon. Each banner is the
 * submit button of a plain form, so choosing works before any JavaScript
 * arrives; useFormStatus only dims the banner while the choice is saved.
 */
export function HackathonPicker({
  hackathons,
  selectedId,
  displayName,
}: {
  hackathons: Hackathon[];
  selectedId: number | null;
  displayName: string;
}) {
  const open = hackathons.filter((h) => !h.archived);
  const archived = hackathons.filter((h) => h.archived);
  return (
    <div className="hq-picker">
      <div className="hq-picker-inner hq-fade-in-page">
        <div style={{ display: "flex", justifyContent: "center" }}>
          <Image
            src="/landing/st-orange.png"
            alt=""
            width={2154}
            height={2116}
            sizes="28px"
            style={{ width: 28, height: "auto", display: "block" }}
          />
        </div>
        <div
          style={{
            fontFamily: "var(--serif)",
            fontSize: 36,
            lineHeight: 1.05,
            marginTop: 18,
            textAlign: "center",
          }}
        >
          Superteam <em style={{ color: "var(--accent)" }}>HQ</em>
        </div>
        <div style={{ ...authLabel, margin: "26px 0 12px", textAlign: "center" }}>
          {hackathons.length > 0 ? "Choose a hackathon" : "No hackathons yet"}
        </div>

        <div className="hq-picker-list">
          {open.map((h) => (
            <form key={h.id} action={chooseHackathon}>
              <input type="hidden" name="hackathon" value={h.id} />
              <HackathonBanner hackathon={h} current={h.id === selectedId} />
            </form>
          ))}
          {hackathons.length === 0 ? <FirstHackathonForm /> : null}
          {archived.length > 0 ? (
            <ArchivedList hackathons={archived} selectedId={selectedId} />
          ) : null}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "baseline",
            gap: 10,
            marginTop: 26,
            fontSize: 12,
            color: "var(--label-3)",
          }}
        >
          <span>Signed in as {displayName}</span>
          <span style={{ color: "var(--faded)" }}>/</span>
          <button
            type="button"
            className="hq-hover-accent"
            onClick={() => logout()}
            style={{
              border: "none",
              background: "none",
              cursor: "pointer",
              padding: 0,
              fontSize: 12,
              fontWeight: 600,
              color: "var(--label-2)",
            }}
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The banner itself. With artwork (lib/hq/hackathon-art.ts) it is the
 * painting with the wordmark laid over it and the dates beneath; without,
 * a dark typographic banner in the same proportions, so a newly added
 * edition sits comfortably next to a dressed one.
 */
export function HackathonBanner({
  hackathon,
  current,
}: {
  hackathon: Hackathon;
  current: boolean;
}) {
  const { pending } = useFormStatus();
  const art = hackathonArt(hackathon.slug);
  const dates = fmtDateRange(hackathon.startDate, hackathon.endDate);

  return (
    <button
      type="submit"
      disabled={pending}
      className={`hq-banner${art ? " hq-banner-art" : ""}`}
      aria-label={`Open ${hackathon.name}, ${dates}`}
      aria-busy={pending}
      style={{ opacity: pending ? 0.72 : 1 }}
    >
      {art ? (
        <>
          <Image
            src={art.background}
            alt=""
            fill
            sizes="(max-width: 940px) 100vw, 880px"
            quality={90}
            priority
            className="hq-banner-bg"
          />
          <span className="hq-banner-shade" aria-hidden="true" />
        </>
      ) : (
        <span className="hq-banner-plain" aria-hidden="true" />
      )}
      <span className="hq-banner-content">
        {art ? (
          <Image
            src={art.wordmark}
            alt={art.wordmarkAlt}
            width={932}
            height={73}
            sizes="(max-width: 940px) 56vw, 500px"
            priority
            className="hq-banner-wordmark"
            style={{ width: `${art.wordmarkWidth * 100}%`, height: "auto" }}
          />
        ) : (
          <span className="hq-banner-name">{hackathon.name}</span>
        )}
        <span className="hq-banner-dates">{dates}</span>
      </span>
      {current ? <span className="hq-banner-current">Current</span> : null}
    </button>
  );
}

/**
 * Archived editions, put away but still openable. A compact list rather than
 * banners: past editions accumulate, and the open ones are what the picker
 * is for.
 */
function ArchivedList({
  hackathons,
  selectedId,
}: {
  hackathons: Hackathon[];
  selectedId: number | null;
}) {
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ ...authLabel, color: "var(--faded)", margin: "0 0 6px" }}>Archived</div>
      <div style={{ background: "var(--card)", boxShadow: "var(--shadow-1)" }}>
        {hackathons.map((h) => (
          <form key={h.id} action={chooseHackathon}>
            <input type="hidden" name="hackathon" value={h.id} />
            <ArchivedRow hackathon={h} current={h.id === selectedId} />
          </form>
        ))}
      </div>
    </div>
  );
}

function ArchivedRow({ hackathon, current }: { hackathon: Hackathon; current: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="hq-hover-fill"
      aria-label={`Open ${hackathon.name}, archived`}
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 12,
        width: "100%",
        boxSizing: "border-box",
        border: "none",
        borderBottom: "1px solid var(--sep)",
        background: "none",
        cursor: pending ? "progress" : "pointer",
        padding: "11px 14px",
        textAlign: "left",
        color: "var(--label-2)",
        opacity: pending ? 0.7 : 1,
      }}
    >
      <span style={{ fontSize: 14, fontWeight: 600, color: "var(--label-1)" }}>
        {hackathon.name}
      </span>
      <span style={{ fontSize: 12, color: "var(--label-3)", flex: 1 }}>
        {fmtDateRange(hackathon.startDate, hackathon.endDate)}
      </span>
      {current ? (
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: "var(--accent)",
          }}
        >
          Current
        </span>
      ) : null}
      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--label-2)" }}>Open</span>
    </button>
  );
}

/**
 * Only for a database with no hackathon at all (the seed normally creates
 * the first). Everything after the first edition is managed from Admin.
 */
function FirstHackathonForm() {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");

  const submit = () => {
    setError("");
    startTransition(async () => {
      const res = await createHackathon({
        id: Number(id),
        name,
        startDate: start,
        endDate: end,
      });
      if (!res.ok) setError(res.error ?? "Could not add the hackathon.");
    });
  };

  return (
    <div
      style={{
        background: "var(--card)",
        boxShadow: "var(--shadow-2)",
        padding: "22px 24px",
      }}
    >
      <div style={{ fontFamily: "var(--serif)", fontSize: 24 }}>Add the first hackathon</div>
      <div style={{ fontSize: 13, color: "var(--label-2)", marginTop: 4 }}>
        Everything in HQ belongs to a hackathon. Give the edition Colosseum&apos;s hackathon
        id, its name and its dates to begin.
      </div>
      <div
        style={{
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
          alignItems: "flex-end",
          marginTop: 14,
        }}
      >
        <FormField label="ID" width={90}>
          <input
            type="number"
            min={1}
            step={1}
            value={id}
            onChange={(e) => setId(e.target.value)}
            style={{ ...input, boxSizing: "border-box" }}
          />
        </FormField>
        <FormField label="Name" flex={1} minWidth={200}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ ...input, boxSizing: "border-box" }}
          />
        </FormField>
        <FormField label="Starts" minWidth={150}>
          <input
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            style={{ ...input, padding: "7px 10px", boxSizing: "border-box" }}
          />
        </FormField>
        <FormField label="Ends" minWidth={150}>
          <input
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            style={{ ...input, padding: "7px 10px", boxSizing: "border-box" }}
          />
        </FormField>
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          style={{ ...primaryBtn, padding: "9px 16px" }}
        >
          {pending ? "Adding…" : "Add"}
        </button>
      </div>
      {error ? (
        <div style={{ fontSize: 12, color: "var(--red)", marginTop: 10 }}>{error}</div>
      ) : null}
    </div>
  );
}
