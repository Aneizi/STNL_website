// The member navigation as data. Derived on the server from what the
// account holds and rendered on the client with the current path, so the
// rules live in one pure function that a test can table.
//
// A hint, never authorization: an item's presence says where to look, and
// the page behind it decides again from the grants at request time.
import type { Capability } from "./capabilities";

export type NavItem = {
  /** Stable identity for rendering; the label is copy and may change. */
  key: string;
  label: string;
  href: string;
  /**
   * The path this item is the section for: current on that path and on the
   * segments below it. A trailing "/" names a subtree only. Absent for a
   * call to action that points into another item's section.
   */
  activeUnder?: string;
};

export type MemberNavInput = {
  capabilities: ReadonlySet<Capability>;
  hasTelegram: boolean;
  teamCount: number;
};

/**
 * Home, then the team module (Register team until the account has one, My
 * teams after), Captain with the capability only, Connect Telegram until a
 * Telegram identity is linked, and Account. An account that holds several
 * roles sees the relevant items together.
 */
export function getMemberNav({ capabilities, hasTelegram, teamCount }: MemberNavInput): NavItem[] {
  const items: NavItem[] = [{ key: "home", label: "Home", href: "/hq/dashboard", activeUnder: "/hq/dashboard" }];
  items.push(
    teamCount > 0
      ? { key: "teams", label: "My teams", href: "/hq/dashboard", activeUnder: "/hq/team/" }
      : { key: "teams", label: "Register team", href: "/hq/initialize", activeUnder: "/hq/initialize" },
  );
  if (capabilities.has("captain")) items.push({ key: "captain", label: "Captain", href: "/hq/captain", activeUnder: "/hq/captain" });
  if (!hasTelegram) items.push({ key: "connect-telegram", label: "Connect Telegram", href: "/hq/account" });
  items.push({ key: "account", label: "Account", href: "/hq/account", activeUnder: "/hq/account" });
  return items;
}

/** Whether `pathname` sits in the item's section: the path itself or a segment below it, never a longer sibling. */
export function isNavItemCurrent(item: NavItem, pathname: string): boolean {
  const section = item.activeUnder;
  if (!section) return false;
  if (section.endsWith("/")) return pathname.startsWith(section) && pathname.length > section.length;
  return pathname === section || pathname.startsWith(`${section}/`);
}
