"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { IconArrowRight } from "symbols-react";
import type { ContactMethod, InterestPath, InterestResult } from "@/lib/colosseum-interest";
import { submitInterest } from "./actions";
import styles from "./interest.module.css";

const initialState: InterestResult = { ok: false };

export function InterestForm({ path }: { path: InterestPath }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [name, setName] = useState("");
  const [method, setMethod] = useState<ContactMethod>("telegram");
  const [submittedMethod, setSubmittedMethod] = useState<ContactMethod>("telegram");
  const [contacts, setContacts] = useState({ telegram: "", phone: "" });
  const [builtOnSolana, setBuiltOnSolana] = useState(false);
  const [state, action, pending] = useActionState(
    async (previous: InterestResult, formData: FormData): Promise<InterestResult> => {
      setSubmittedMethod(formData.get("contactMethod") === "phone" ? "phone" : "telegram");
      let result: InterestResult;
      try {
        result = await submitInterest(previous, formData);
      } catch {
        return { ok: false, error: "We couldn’t save your details. Please try again." };
      }
      if (result.ok && result.redirectTo) {
        if (result.redirectTo.startsWith("/")) router.push(result.redirectTo);
        else window.location.assign(result.redirectTo);
      }
      return result;
    },
    initialState,
  );

  useEffect(() => {
    if (state.fieldErrors?.name) formRef.current?.querySelector<HTMLInputElement>("#interest-name")?.focus();
    else if (state.fieldErrors?.contact) formRef.current?.querySelector<HTMLInputElement>("#interest-contact")?.focus();
  }, [state]);

  const submitting = pending || state.ok;
  const contactHint = method === "telegram" ? "Use your username." : "Include your country code, such as +31.";
  const contactError = submittedMethod === method ? state.fieldErrors?.contact : undefined;

  return (
    <form ref={formRef} action={action} className={styles.form} aria-busy={submitting}>
      <input type="hidden" name="path" value={path} />
      <div className={styles.honeypot} aria-hidden="true">
        <label htmlFor="interest-website">Website</label>
        <input id="interest-website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      <div className={styles.field}>
        <label htmlFor="interest-name">Name</label>
        <input
          id="interest-name"
          name="name"
          type="text"
          autoComplete="name"
          spellCheck={false}
          required
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={submitting}
          aria-invalid={Boolean(state.fieldErrors?.name)}
          aria-describedby={state.fieldErrors?.name ? "interest-name-error" : undefined}
        />
        {state.fieldErrors?.name && <p id="interest-name-error" className={styles.error}>{state.fieldErrors.name}</p>}
      </div>

      <fieldset className={styles.contactMethods} disabled={submitting}>
        <legend>How can we reach you?</legend>
        <div className={styles.toggle}>
          {(["telegram", "phone"] as const).map((option) => (
            <label key={option} className={styles.option}>
              <input
                type="radio"
                name="contactMethod"
                value={option}
                checked={method === option}
                onChange={() => setMethod(option)}
              />
              <span>{option === "telegram" ? "Telegram" : "WhatsApp number"}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className={styles.field}>
        <label htmlFor="interest-contact">{method === "telegram" ? "Telegram username" : "WhatsApp number"}</label>
        <input
          id="interest-contact"
          name="contact"
          type={method === "phone" ? "tel" : "text"}
          inputMode={method === "phone" ? "tel" : "text"}
          autoComplete={method === "phone" ? "tel" : "off"}
          autoCapitalize="none"
          spellCheck={false}
          required
          maxLength={100}
          placeholder={method === "phone" ? "+31 6 1234 5678" : "@alex"}
          value={contacts[method]}
          onChange={(event) => setContacts((current) => ({ ...current, [method]: event.target.value }))}
          disabled={submitting}
          aria-invalid={Boolean(contactError)}
          aria-describedby={`interest-contact-hint${contactError ? " interest-contact-error" : ""}`}
        />
        <p id="interest-contact-hint" className={styles.hint}>{contactHint}</p>
        {contactError && <p id="interest-contact-error" className={styles.error}>{contactError}</p>}
      </div>

      <label className={styles.checkbox}>
        <span>Have you built on Solana before?</span>
        <input
          type="checkbox"
          name="builtOnSolana"
          checked={builtOnSolana}
          onChange={(event) => setBuiltOnSolana(event.target.checked)}
          disabled={submitting}
        />
      </label>

      <p className={styles.privacy}>Superteam NL will use your details to contact you about the hackathon.</p>
      {state.error && <p role="alert" className={styles.error}>{state.error}</p>}
      <button type="submit" className={styles.submit} disabled={submitting}>
        <span aria-live="polite">{submitting ? "Saving your interest…" : "Count me in"}</span>
        <IconArrowRight width={20} height={20} fill="currentColor" aria-hidden="true" />
      </button>
    </form>
  );
}
