"use client";

import Image from "next/image";
import { useActionState } from "react";
import { changePassword } from "@/lib/hq/actions/auth";
import type { ActionResult } from "@/lib/hq/types";
import { authCard, authField, authLabel, authSubmit } from "./ui";

export function ChangePasswordForm({ displayName }: { displayName: string }) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    changePassword,
    null,
  );

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        boxSizing: "border-box",
      }}
    >
      <form action={formAction} className="hq-fade-in-page" style={authCard}>
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
          Welcome, <em style={{ color: "var(--accent)" }}>{displayName}</em>
        </div>
        <div
          style={{
            fontSize: 13,
            color: "var(--label-2)",
            marginTop: 10,
            textAlign: "center",
          }}
        >
          Your temporary password needs replacing. Choose a new one to continue.
        </div>
        <div style={{ ...authLabel, margin: "18px 0 8px" }}>New password</div>
        <input
          name="password"
          type="password"
          placeholder="At least 12 characters"
          autoComplete="new-password"
          style={authField}
        />
        <div style={{ ...authLabel, margin: "16px 0 8px" }}>Confirm password</div>
        <input
          name="confirm"
          type="password"
          autoComplete="new-password"
          style={authField}
        />
        {state?.error ? (
          <div style={{ fontSize: 12, color: "var(--red)", marginTop: 10 }}>{state.error}</div>
        ) : null}
        <button type="submit" disabled={pending} style={authSubmit}>
          {pending ? "Saving…" : "Set new password"}
        </button>
      </form>
    </div>
  );
}
