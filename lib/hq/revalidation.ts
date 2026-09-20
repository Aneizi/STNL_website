import "server-only";
import { revalidatePath } from "next/cache";

const team = "/hq/(member)/team/[id]";
const partner = "/hq/(app)/partners/[id]";
const projects = [
  "/hq", "/hq/projects", "/hq/demo", "/hq/events", "/hq/partners", partner,
  "/hq/people", "/hq/admin", "/hq/dashboard", "/hq/captain", "/hq/account", team,
];
const reporting = ["/hq", "/hq/projects", "/hq/admin", "/hq/dashboard", "/hq/captain", team];

// Include dependent views, not only the screen that issued the mutation.
const paths = {
  projects,
  people: [...projects, "/hq/people", "/hq/account"],
  events: ["/hq", "/hq/events", "/hq/projects", "/hq/partners", partner],
  partners: ["/hq", "/hq/partners", partner, "/hq/events", "/hq/projects", "/hq/demo"],
  demo: ["/hq", "/hq/demo", "/hq/people"],
  reporting,
  captains: [...reporting, "/hq/people", "/hq/account", "/hq/invite/continue"],
  builders: [...projects, "/hq/welcome", "/hq/initialize", "/hq/join"],
  milestones: ["/hq", "/hq/admin"],
  interest: ["/hq", "/hq/people"],
  dashboard: ["/hq/dashboard"],
} as const;

/** Edition/catalog changes still invalidate layouts containing the edition picker. */
export function refreshHq(scope: keyof typeof paths | "all" = "all"): void {
  if (scope === "all") {
    revalidatePath("/hq", "layout");
    return;
  }
  for (const path of new Set(paths[scope])) {
    if (path.includes("[")) revalidatePath(path, "page");
    else revalidatePath(path);
  }
}
