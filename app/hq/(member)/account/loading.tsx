import { BuilderShell } from "@/components/hq/builder-shell";

export default function Loading() {
  return <BuilderShell back="/hq/dashboard"><p role="status" aria-live="polite">Opening your account…</p></BuilderShell>;
}
