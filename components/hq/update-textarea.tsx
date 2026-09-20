"use client";

import { useId, type TextareaHTMLAttributes } from "react";
import { MAX_BODY_LENGTH, updateCharacterCount } from "@/lib/hq/reporting-body";

/** Keep pasted drafts intact and explain the budget instead of truncating whitespace. */
export function UpdateTextarea({ value, ...props }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "maxLength"> & { value: string }) {
  const counterId = useId();
  const count = updateCharacterCount(value);
  const tooLong = count > MAX_BODY_LENGTH;
  return <>
    <textarea {...props} value={value} aria-invalid={tooLong || undefined} aria-describedby={[props["aria-describedby"], counterId].filter(Boolean).join(" ")} />
    <p id={counterId} aria-live="polite" style={{ margin: "4px 0 0", fontSize: 13, color: tooLong ? "#a52b16" : "#57534a" }}>
      {count}/{MAX_BODY_LENGTH} characters. Whitespace does not count.
    </p>
  </>;
}
