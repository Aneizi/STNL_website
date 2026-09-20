"use client";

import type { CSSProperties } from "react";
import { login } from "@/lib/hq/actions/auth";
import { AuthForm, useAuthForm } from "./auth-form";
import { authField, authSubmit } from "./ui";

const EMPTY_FIELDS = "Enter your username and password.";

/**
 * The design's own pre-check, answered before the action is asked: both
 * fields must hold something. A JS-off submit of the same shape reaches
 * lib/hq/actions/auth.ts, which refuses it with its generic message.
 */
export function loginPrecheck(data: FormData): string | null {
  return data.get("username") && data.get("password") ? null : EMPTY_FIELDS;
}

const label: CSSProperties = {
  display: "block",
  fontSize: 20,
  color: "var(--label-2)",
  fontWeight: 600,
};
const field: CSSProperties = { ...authField, fontSize: 20, minHeight: 50 };

export function LoginForm() {
  const { state, formAction, pending, error, submit } = useAuthForm(login, loginPrecheck);

  return (
    <AuthForm action={formAction} onSubmit={submit}>
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
      <p style={{ fontSize: 20, color: "var(--label-2)", margin: "12px 0 24px", textAlign: "center" }}>For admins only.</p>
      <label htmlFor="admin-username" style={{ ...label, margin: "18px 0 8px" }}>Username</label>
      <input
        id="admin-username"
        name="username"
        autoCapitalize="none"
        autoComplete="username"
        defaultValue={state?.username ?? ""}
        style={field}
      />
      <label htmlFor="admin-password" style={{ ...label, margin: "16px 0 8px" }}>Password</label>
      <input
        id="admin-password"
        name="password"
        type="password"
        autoComplete="current-password"
        style={field}
      />
      {error ? (
        <div role="alert" style={{ fontSize: 20, color: "var(--red)", marginTop: 10 }}>{error}</div>
      ) : null}
      <button type="submit" disabled={pending} style={{ ...authSubmit, fontSize: 20, minHeight: 50, ...(pending ? { opacity: 0.5 } : {}) }}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </AuthForm>
  );
}
