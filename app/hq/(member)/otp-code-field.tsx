"use client";

import type { RefObject } from "react";

/** The status line every code form shows once a code went out; the expiry matches `expiresIn` in lib/hq/member-auth.ts. */
export const CODE_SENT_COPY = "Code sent. It expires in 15 minutes.";

type FieldProps = {
  value: string;
  /** Receives the digits only, at most six of them. */
  onChange: (digits: string) => void;
  disabled: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
  /** Ids of the status and error lines that describe the field. */
  describedBy?: string;
  labelClassName?: string;
  inputClassName?: string;
};

/** The six-digit code input, with the same input semantics on every form that verifies a code. */
export function OtpCodeField({ value, onChange, disabled, inputRef, describedBy, labelClassName, inputClassName }: FieldProps) {
  return (
    <label className={labelClassName}>
      Verification code
      <input
        ref={inputRef}
        className={inputClassName}
        name="code"
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        minLength={6}
        maxLength={6}
        value={value}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, "").slice(0, 6))}
        aria-describedby={describedBy}
        required
        disabled={disabled}
      />
    </label>
  );
}

type ResendProps = {
  secondsLeft: number;
  disabled: boolean;
  onClick: () => void;
  className?: string;
};

/** The resend control: counts the cooldown down and is disabled until it reaches zero. */
export function ResendCodeButton({ secondsLeft, disabled, onClick, className }: ResendProps) {
  return (
    <button type="button" className={className} disabled={disabled || secondsLeft > 0} onClick={onClick}>
      {secondsLeft > 0 ? `Resend in ${secondsLeft}s` : "Resend code"}
    </button>
  );
}
