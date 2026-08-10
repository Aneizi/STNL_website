import { redirect } from "next/navigation";
import { currentUser } from "@/lib/hq/auth";
import { LoginForm } from "@/components/hq/login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const user = await currentUser();
  if (user) redirect(user.mustChangePassword ? "/hq/change-password" : "/hq");
  return <LoginForm />;
}
