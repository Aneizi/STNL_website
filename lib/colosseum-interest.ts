import { z } from "zod";

export type InterestPath = "beginner" | "experienced";
export type ContactMethod = "telegram" | "phone";

export type InterestResult = {
  ok: boolean;
  error?: string;
  fieldErrors?: Partial<Record<"name" | "contact", string>>;
  redirectTo?: string;
};

export type InterestInput = {
  name: string;
  contactMethod: ContactMethod;
  contact: string;
  builtOnSolana: boolean;
  path: InterestPath;
};

const formSchema = z.object({
  name: z.string().trim().min(1).max(120),
  contactMethod: z.enum(["telegram", "phone"]),
  contact: z.string().trim().min(1).max(200),
  builtOnSolana: z.union([z.literal("on"), z.null()]),
  path: z.enum(["beginner", "experienced"]),
  website: z.union([z.literal(""), z.null()]),
});

function normalizeContact(method: ContactMethod, value: string): string | null {
  if (method === "telegram") {
    const username = value
      .replace(/^(?:https?:\/\/)?(?:www\.)?t\.me\//i, "")
      .replace(/^@/, "")
      .replace(/\/$/, "");
    return /^[a-z][a-z0-9_]{0,31}$/i.test(username)
      ? `@${username.toLowerCase()}`
      : null;
  }

  if (!/^(?:\+|00)[\d\s().-]+$/.test(value)) return null;
  const phone = value.replace(/[\s().-]/g, "").replace(/^00/, "+");
  return /^\+[1-9]\d{6,14}$/.test(phone) ? phone : null;
}

export function parseInterestForm(
  formData: FormData,
): { ok: true; data: InterestInput } | { ok: false; result: InterestResult } {
  const parsed = formSchema.safeParse({
    name: formData.get("name"),
    contactMethod: formData.get("contactMethod"),
    contact: formData.get("contact"),
    builtOnSolana: formData.get("builtOnSolana"),
    path: formData.get("path"),
    website: formData.get("website"),
  });

  if (!parsed.success) {
    const fieldErrors: InterestResult["fieldErrors"] = {};
    for (const issue of parsed.error.issues) {
      if (issue.path[0] === "name") fieldErrors.name = "Enter your name, up to 120 characters.";
      if (issue.path[0] === "contact") fieldErrors.contact = "Enter your contact details.";
    }
    return {
      ok: false,
      result: { ok: false, error: "Check your details and try again.", fieldErrors },
    };
  }

  const { name, contactMethod, builtOnSolana, path } = parsed.data;
  const contact = normalizeContact(contactMethod, parsed.data.contact);
  if (!contact) {
    return {
      ok: false,
      result: {
        ok: false,
        fieldErrors: {
          contact: contactMethod === "telegram"
            ? "Enter your Telegram username or t.me link."
            : "Include your country code, for example +31 6 1234 5678.",
        },
      },
    };
  }

  return {
    ok: true,
    data: {
      name: name.replace(/\s+/g, " "),
      contactMethod,
      contact,
      builtOnSolana: builtOnSolana === "on",
      path,
    },
  };
}
