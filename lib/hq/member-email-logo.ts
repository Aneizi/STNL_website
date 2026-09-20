import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Attachment } from "resend";

let logoContent: string | undefined;

/** Embed the original banner so email clients never need access to the site. */
export async function memberEmailLogo(): Promise<Attachment> {
  const content = logoContent ?? (await readFile(join(process.cwd(), "lib/hq/email-assets/superteam-nl.png"))).toString("base64");
  // Cache only a successful read; a transient file error must not poison sends.
  logoContent = content;
  return {
    filename: "superteam-nl.png",
    content,
    contentType: "image/png",
    contentId: "superteam-nl-logo",
  };
}
