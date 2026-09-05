import { requireUser } from "@/lib/hq/auth";
import { selectedHackathonId } from "@/lib/hq/hackathon";
import { getHackathons } from "@/lib/hq/queries";
import { HqChrome } from "@/components/hq/chrome";
import { HqToast } from "@/components/hq/toast";

// NOT the auth boundary — layouts don't re-render on soft navigation, so
// every page under this group calls requireUser() itself (and reads its
// hackathon through requireHackathonId()). This call only fetches what the
// chrome shows: the identity and the hackathon switcher.
export default async function HqAppLayout({ children }: { children: React.ReactNode }) {
  const [user, hackathons, selectedId] = await Promise.all([
    requireUser(),
    getHackathons(),
    selectedHackathonId(),
  ]);
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <HqChrome displayName={user.displayName} hackathons={hackathons} selectedId={selectedId} />
      <HqToast />
      <div
        style={{
          maxWidth: 1280,
          margin: "0 auto",
          width: "100%",
          boxSizing: "border-box",
          padding: "24px 20px 64px",
          flex: 1,
        }}
      >
        {children}
      </div>
    </div>
  );
}
