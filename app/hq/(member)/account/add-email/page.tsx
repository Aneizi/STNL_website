import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BuilderShell } from "@/components/hq/builder-shell";
import { requireMemberActor } from "@/lib/hq/actor";
import { getMemberAuthAvailability } from "@/lib/hq/member-auth-config";
import { AddEmailForm } from "../add-email-form";

export const metadata: Metadata = { title: "Add a recovery email" };
export const dynamic = "force-dynamic";

// The confirmation step before the change-email endpoints, for an account
// that signs in with Telegram only. The server action behind the form records
// the intent the endpoint then requires. actor.email is the verified login
// email; an account that has one has nothing to add here.
export default async function AddEmailPage() {
  const actor = await requireMemberActor("/hq/account/add-email");
  if (actor.email !== null) redirect("/hq/account");
  const available = getMemberAuthAvailability().email;
  return (
    <BuilderShell back="/hq/account">
      <h1>Add a recovery <em>email.</em></h1>
      <p>A verified email lets you sign in without Telegram and is the way back in if you ever lose access to it. Once it is added, you can also disconnect Telegram.</p>
      <p>We will send a 6-digit code to the address you enter and to nowhere else. Your account, your teams and your roles stay exactly as they are.</p>
      <p>This works within 15 minutes of signing in. If it has been longer, you will be asked to sign in again first.</p>
      {available ? <AddEmailForm /> : <p>Email is not available yet.</p>}
    </BuilderShell>
  );
}
