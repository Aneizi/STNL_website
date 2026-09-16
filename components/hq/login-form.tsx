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
        <h1
          style={{
            fontSize: 32,
            fontWeight: 600,
            lineHeight: 1.2,
            margin: "18px 0 0",
            textAlign: "center",
          }}
        >
          Admin login
        </h1>
        <p style={{ fontSize: 17, color: "var(--label-2)", margin: "12px 0 24px", textAlign: "center" }}>For admins only.</p>
        <label htmlFor="admin-username" style={{ ...authLabel, display: "block", fontSize: 17, textTransform: "none", letterSpacing: 0, color: "var(--label-2)", margin: "18px 0 8px" }}>Username</label>
        <input
          id="admin-username"
          name="username"
          autoCapitalize="none"
          autoComplete="username"
          defaultValue={state?.username ?? ""}
          style={{ ...authField, fontSize: 17, minHeight: 50 }}
        />
        <label htmlFor="admin-password" style={{ ...authLabel, display: "block", fontSize: 17, textTransform: "none", letterSpacing: 0, color: "var(--label-2)", margin: "16px 0 8px" }}>Password</label>
        <input
          id="admin-password"
          name="password"
          type="password"
          autoComplete="current-password"
          style={{ ...authField, fontSize: 17, minHeight: 50 }}
        />
        {state?.error ? (
          <div role="alert" style={{ fontSize: 17, color: "var(--red)", marginTop: 10 }}>{state.error}</div>
        ) : null}
        <button type="submit" disabled={pending} style={{ ...authSubmit, fontSize: 17, minHeight: 50 }}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
