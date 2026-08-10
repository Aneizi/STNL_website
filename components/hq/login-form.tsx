"use client";

import Image from "next/image";
import { useActionState } from "react";
import { login, type LoginResult } from "@/lib/hq/actions/auth";
import { authCard, authField, authLabel, authSubmit } from "./ui";

export function LoginForm() {
  const [state, formAction, pending] = useActionState<LoginResult | null, FormData>(
    login,
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
          Superteam <em style={{ color: "var(--accent)" }}>HQ</em>
        </div>
        <div style={{ ...authLabel, margin: "18px 0 8px" }}>Username</div>
        <input
          name="username"
          autoCapitalize="none"
          autoComplete="username"
          defaultValue={state?.username ?? ""}
          style={authField}
        />
        <div style={{ ...authLabel, margin: "16px 0 8px" }}>Password</div>
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          style={authField}
        />
        {state?.error ? (
          <div style={{ fontSize: 12, color: "var(--red)", marginTop: 10 }}>{state.error}</div>
        ) : null}
        <button type="submit" disabled={pending} style={authSubmit}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
        <div
          style={{
            fontSize: 12,
            color: "var(--label-3)",
            marginTop: 14,
            textAlign: "center",
          }}
        >
          Sign ups are currently closed.
        </div>
      </form>
    </div>
  );
}
