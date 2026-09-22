import type { PersonTag } from "./types";

/** User is the neutral signup role; it carries no visible tag. */
export function personRoleTags(roleLabel: string): PersonTag[] {
  return roleLabel && roleLabel !== "User"
    ? [{ kind: "role", label: roleLabel, protected: false }]
    : [];
}
