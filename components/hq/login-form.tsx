"use client";

import Image from "next/image";
import { useActionState, useState, type CSSProperties, type FormEvent } from "react";
import { login, type LoginResult } from "@/lib/hq/actions/auth";
import { authCard, authField, authSubmit } from "./ui";

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
  const [state, formAction, pending] = useActionState<LoginResult | null, FormData>(
    login,
    null,
  );
  const [localError, setLocalError] = useState<string | null>(null);
  // The pre-check's message wins, and the action's clears while a new
  // attempt is in flight, the way the design empties it on submit.
  const error = localError ?? (pending ? null : state?.error);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    const problem = loginPrecheck(new FormData(event.currentTarget));
    if (problem) event.preventDefault();
    setLocalError(problem);
  };

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
      <form action={formAction} onSubmit={submit} className="hq-fade-in-page" style={authCard}>
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
        <button type="submit" disabled={pending} style={{ ...authSubmit, fontSize: 20, minHeight: 50 }}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
