import { requireUser } from "@/lib/hq/auth";
import { HqChrome } from "@/components/hq/chrome";
import { HqToast } from "@/components/hq/toast";

// NOT the auth boundary — layouts don't re-render on soft navigation, so
// every page under this group calls requireUser() itself. This call only
// fetches the identity for the chrome (and gates the initial load).
export default async function HqAppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <HqChrome displayName={user.displayName} />
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
