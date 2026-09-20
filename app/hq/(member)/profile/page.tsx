import type { Metadata } from "next";
import Image from "next/image";
import { redirect } from "next/navigation";
import { hasTelegramIdentity } from "@/lib/hq/identity";
import { currentMember, redirectToMemberSignIn } from "@/lib/hq/member-auth";
import { getTelegramBotUrl, safeMemberNext } from "@/lib/hq/member-auth-config";
import { ProfileForm } from "./profile-form";
import styles from "../account.module.css";

export const metadata: Metadata = { title: "Your name", robots: { index: false, follow: false } };

export default async function ProfilePage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const params = await searchParams;
  const requested = safeMemberNext(params.next);
  const next = requested.startsWith("/hq/profile") ? "/hq/welcome" : requested;
  // Reached by Telegram-first accounts too (newUserCallbackURL): `user.email`
  // may be null, and nothing below asks for an address.
  const user = await currentMember();
  if (!user) return redirectToMemberSignIn(next);
  if (user.name.trim()) redirect(next);
  // Bot consent can only be stored for a Telegram account, so the checkbox is
  // offered to those and to nobody else.
  const hasTelegram = await hasTelegramIdentity(user.id);
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <span className={styles.brand}>
          <Image src="/landing/st-orange.png" alt="" width={2154} height={2116} sizes="28px" />
          <span>Superteam NL</span>
        </span>
      </header>
      <main className={styles.main}>
        <div className={styles.content}>
          <h1>What&apos;s your <em>name?</em></h1>
          <p className={styles.introduction}>One last detail before you join Superteam NL HQ.</p>
          <ProfileForm next={next} hasTelegram={hasTelegram} botUrl={getTelegramBotUrl()} />
        </div>
      </main>
    </div>
  );
}
