"use client";

import { changePassword } from "@/lib/hq/actions/auth";
import { AuthForm, useAuthForm } from "./auth-form";
import { authField, authLabel, authSubmit } from "./ui";

// The same two refusals lib/hq/actions/auth.ts gives a JS-off submit, so a
// person reads one message whichever side caught it.
const TOO_SHORT = "Use at least 12 characters.";
const MISMATCH = "The passwords do not match.";

/** The design's pre-check: length first, then the confirmation. */
export function changePasswordPrecheck(data: FormData): string | null {
  const password = data.get("password");
  if (typeof password !== "string" || password.length < 12) return TOO_SHORT;
  if (password !== data.get("confirm")) return MISMATCH;
  return null;
}

export function ChangePasswordForm({ displayName }: { displayName: string }) {
  const { formAction, pending, error, submit } = useAuthForm(changePassword, changePasswordPrecheck);

  return (
    <AuthForm action={formAction} onSubmit={submit}>
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
          fontSize: 16,
          color: "var(--label-2)",
          marginTop: 10,
          textAlign: "center",
        }}
      >
        Your temporary password needs replacing. Choose a new one to continue.
      </div>
      <label htmlFor="new-password" style={{ ...authLabel, display: "block", margin: "18px 0 8px" }}>New password</label>
      <input
        id="new-password"
        name="password"
        type="password"
        placeholder="At least 12 characters"
        autoComplete="new-password"
        style={authField}
      />
      <label htmlFor="confirm-password" style={{ ...authLabel, display: "block", margin: "16px 0 8px" }}>Confirm password</label>
      <input
        id="confirm-password"
        name="confirm"
        type="password"
        autoComplete="new-password"
        style={authField}
      />
      {error ? (
        <div role="alert" style={{ fontSize: 14, color: "var(--red)", marginTop: 10 }}>{error}</div>
      ) : null}
      <button type="submit" disabled={pending} style={pending ? { ...authSubmit, opacity: 0.5 } : authSubmit}>
        {pending ? "Saving…" : "Set new password"}
      </button>
    </AuthForm>
  );
}
