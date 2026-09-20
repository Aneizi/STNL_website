"use client";

import Image from "next/image";
import { useActionState, useState, type FormEvent, type ReactNode } from "react";
import { authCard } from "./ui";

/** Preserve local validation and clear the previous server error while submitting. */
export function useAuthForm<Result extends { error?: string }>(
  action: (state: Result | null, data: FormData) => Promise<Result>,
  precheck: (data: FormData) => string | null,
) {
  const [state, formAction, pending] = useActionState<Result | null, FormData>(action, null);
  const [localError, setLocalError] = useState<string | null>(null);
  const error = localError ?? (pending ? null : state?.error);
  const submit = (event: FormEvent<HTMLFormElement>) => {
    const problem = precheck(new FormData(event.currentTarget));
    if (problem) event.preventDefault();
    setLocalError(problem);
  };
  return { state, formAction, pending, error, submit };
}

/** The shared operator auth frame; each form keeps its own fields and type scale. */
export function AuthForm({ action, onSubmit, children }: {
  action: (data: FormData) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
}) {
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
      <form action={action} onSubmit={onSubmit} className="hq-fade-in-page" style={authCard}>
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
        {children}
      </form>
    </div>
  );
}
