import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { currentMember } from "@/lib/hq/member-auth";
import { safeMemberNext } from "@/lib/hq/member-auth-config";
import { ProfileForm } from "./profile-form";
import styles from "../account.module.css";

export const metadata: Metadata = { title: "Your name", robots: { index: false, follow: false } };

export default async function ProfilePage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const params = await searchParams;
  const requested = safeMemberNext(params.next);
  const next = requested.startsWith("/hq/profile") ? "/hq/welcome" : requested;
  const user = await currentMember();
  if (!user) redirect(`/hq/signin?next=${encodeURIComponent(next)}`);
  if (user.name.trim()) redirect(next);
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand} aria-label="Superteam NL home">
          <Image src="/landing/st-orange.png" alt="" width={2154} height={2116} sizes="28px" />
          <span>superteam NL</span>
        </Link>
      </header>
      <main className={styles.main}>
        <div className={styles.content}>
          <h1>What&apos;s your <em>name?</em></h1>
          <p className={styles.introduction}>One last detail before you join Superteam NL HQ.</p>
          <ProfileForm next={next} />
        </div>
      </main>
    </div>
  );
}
