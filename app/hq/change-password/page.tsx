import { redirect } from "next/navigation";
import { requireUser } from "@/lib/hq/auth";
import { ChangePasswordForm } from "@/components/hq/change-password-form";

export const dynamic = "force-dynamic";

export default async function ChangePasswordPage() {
  const user = await requireUser({ allowMustChange: true });
  // Only the forced first-login flow lands here.
  if (!user.mustChangePassword) redirect("/hq");
  return <ChangePasswordForm displayName={user.displayName} />;
}
