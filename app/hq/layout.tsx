import type { Metadata } from "next";
import "./hq.css";

export const metadata: Metadata = {
  title: {
    default: "Colosseum HQ",
    template: "%s - Colosseum HQ",
  },
  // Internal tool: keep it out of search engines.
  robots: { index: false, follow: false },
};

export default function HqLayout({ children }: { children: React.ReactNode }) {
  return <div className="hq">{children}</div>;
}
