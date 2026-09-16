import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/hq/auth";
import { LoginForm } from "@/components/hq/login-form";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Admin login" };

export default async function AdminLoginPage() {
  const user = await currentUser();
  if (user) redirect(user.mustChangePassword ? "/hq/change-password" : "/hq");
  return <LoginForm />;
}
