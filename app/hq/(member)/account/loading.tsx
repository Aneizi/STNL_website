import { BuilderShell } from "@/components/hq/builder-shell";

export default function Loading() {
  return <BuilderShell><p role="status" aria-live="polite">Opening your account…</p></BuilderShell>;
}
