import type { Metadata } from "next";
import { BuilderShell } from "@/components/hq/builder-shell";
import { requireMemberActor } from "@/lib/hq/actor";
import { builderStore } from "@/lib/hq/builder-store";
import { getLoginMethods } from "@/lib/hq/identity";
import { getMemberAuthAvailability, getTelegramBotUrl } from "@/lib/hq/member-auth-config";
import { getBotConsent } from "@/lib/hq/telegram-consent";
import { lastParam, telegramErrorMessage } from "../telegram-copy";
import { AccountPassport, type AccountRole } from "./account-passport";

export const metadata: Metadata = { title: "Your account" };
export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// Everything shown here comes from the server: the actor, getLoginMethods(),
// which never yields the internal placeholder address, the stored
// bot-messaging decision, the operator-set tier and the member's teams. The
// client component gets what it renders and nothing wider: no Telegram id,
// no consent row, no team beyond its name. Only the Telegram OAuth round
// trip still reports through the URL (`connected`, `error`); every other
// outcome is the modal's to announce.
export default async function AccountPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const actor = await requireMemberActor("/hq/account");
  const store = builderStore();
  const [methods, consent, teams, ownedProjects, tier, currentHackathonId] = await Promise.all([
    getLoginMethods(actor.id),
    // Consent is read only when there is a Telegram to message; it is never inferred from the connection.
    actor.telegram ? getBotConsent(actor.id) : null,
    store.teams(actor.id),
    store.ownedProjects(actor.id),
    store.tier(actor.id),
    store.currentHackathonId(),
  ]);
  const availability = getMemberAuthAvailability();
  // The Team line is the verified team, preferring the current edition, then the newest.
  const verified = teams.filter((team) => team.verification === "verified");
  const team = verified.find((candidate) => candidate.hackathonId === currentHackathonId) ?? verified[0] ?? null;
  // Captain and Member are operator grants; Builder is having a verified team or an HQ project of one's own.
  const role: AccountRole = actor.capabilities.has("captain") ? "Captain" : tier === "member" ? "Member" : verified.length || ownedProjects.length ? "Builder" : "User";

  return (
    <BuilderShell bare>
      <AccountPassport
        name={actor.name}
        role={role}
        email={methods.email?.address ?? null}
        // actor.email is the verified login email (null for Telegram-only
        // accounts), the same value the plugin's last-login-method rule is
        // defined over.
        hasEmail={actor.email !== null}
        telegram={methods.telegram ? { username: methods.telegram.username } : null}
        teamName={team?.name ?? null}
        bot={consent?.messagingEnabled ?? false}
        botStarted={consent?.chatStarted ?? false}
        botUrl={getTelegramBotUrl()}
        emailAvailable={availability.email}
        telegramAvailable={availability.telegram}
        initialNotice={lastParam(params.connected) === "telegram" ? "Telegram connected." : null}
        initialError={telegramErrorMessage(params.error, "connect")}
      />
    </BuilderShell>
  );
}
