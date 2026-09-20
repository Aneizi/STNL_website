/** Legacy health flags are no longer shown; lifecycle statuses such as Onboarding remain. */
export function isTrafficLightStatus(slug: string): boolean {
  return ["red", "amber", "yellow", "green"].includes(slug);
}
